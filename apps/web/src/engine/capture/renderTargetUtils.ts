import * as THREE from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { CapturePassRequest, SceneMaterialSnapshot } from './captureTypes';
import { createRegisteredObjectUrl } from '@/utils/blobUrlRegistry';
import { encodeFlippedGpuReadbackPngInWorker } from './gpuReadbackPngWorker';

type RenderSceneToPngOptions = {
  applyDisplayTransform?: boolean;
  dataTexture?: boolean;
  samples?: number;
  ignoreSceneBackground?: boolean;
  /** Split the exact target into scissored GPU jobs so the visible renderer
   * can present between expensive depth/normal fragments. */
  tileSize?: number;
  waitForViewportIdle?: () => Promise<void>;
  performancePhasePrefix?: string;
  /**
   * Runs as soon as the offscreen render and readback have been submitted,
   * before this function yields while waiting for the pixels. Callers that
   * temporarily mutate the live scene can restore it here so the viewport
   * never presents the capture-only materials or visibility state.
   */
  onRenderSubmitted?: () => void;
};

function markCapturePerformancePhase(prefix: string | undefined, suffix: string) {
  if (!prefix || typeof document === 'undefined') return;
  if (document.body.dataset.perfSimulatedViewportInteraction !== '1') return;
  document.body.dataset.perfUvBakePhase = `${prefix}-${suffix}`;
}

type RenderScenePass = {
  /**
   * Applies the material/visibility state for one accumulation pass and returns
   * a restorer. The restorer runs immediately after renderer submission.
   */
  prepare: () => () => void;
};

let displayOutputPass: OutputPass | undefined;

type SharedRendererState = {
  target: THREE.WebGLRenderTarget | null;
  clearColor: THREE.Color;
  clearAlpha: number;
  viewport: THREE.Vector4;
  scissor: THREE.Vector4;
  scissorTest: boolean;
  autoClear: boolean;
  xrEnabled: boolean;
};

function captureSharedRendererState(gl: THREE.WebGLRenderer): SharedRendererState {
  return {
    target: gl.getRenderTarget(),
    clearColor: gl.getClearColor(new THREE.Color()),
    clearAlpha: gl.getClearAlpha(),
    viewport: gl.getViewport(new THREE.Vector4()),
    scissor: gl.getScissor(new THREE.Vector4()),
    scissorTest: gl.getScissorTest(),
    autoClear: gl.autoClear,
    xrEnabled: gl.xr.enabled,
  };
}

function restoreSharedRendererState(gl: THREE.WebGLRenderer, state: SharedRendererState) {
  gl.setRenderTarget(state.target);
  gl.setClearColor(state.clearColor, state.clearAlpha);
  gl.setViewport(state.viewport);
  gl.setScissor(state.scissor);
  gl.setScissorTest(state.scissorTest);
  gl.autoClear = state.autoClear;
  gl.xr.enabled = state.xrEnabled;
}

async function waitForSubmittedGpuWork(renderer: THREE.WebGLRenderer) {
  const context = renderer.getContext();
  if (!(context instanceof WebGL2RenderingContext)) {
    context.flush();
    return;
  }
  const fence = context.fenceSync(context.SYNC_GPU_COMMANDS_COMPLETE, 0);
  context.flush();
  if (!fence) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const probe = () => {
        const status = context.clientWaitSync(fence, 0, 0);
        if (status === context.WAIT_FAILED) {
          reject(new Error('Offscreen capture GPU fence failed.'));
          return;
        }
        if (status === context.TIMEOUT_EXPIRED) {
          window.setTimeout(probe, 4);
          return;
        }
        resolve();
      };
      window.setTimeout(probe, 0);
    });
  } finally {
    context.deleteSync(fence);
  }
}

function getDisplayOutputPass() {
  displayOutputPass ??= new OutputPass();
  return displayOutputPass;
}

export async function renderSceneToPngUrl(
  request: CapturePassRequest,
  options: RenderSceneToPngOptions = {},
) {
  // Three.js intentionally skips renderer tone mapping for ordinary render
  // targets. Color captures therefore need a linear intermediate followed by
  // the same display transform used by the on-screen viewport.
  markCapturePerformancePhase(options.performancePhasePrefix, 'target-setup');
  const sceneTarget = new THREE.WebGLRenderTarget(request.width, request.height, {
    samples: options.samples ?? (request.width > 1024 || request.height > 1024 ? 0 : 2),
    ...(options.applyDisplayTransform
      ? { type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace }
      : { colorSpace: options.dataTexture ? THREE.NoColorSpace : THREE.SRGBColorSpace }),
  });
  const outputTarget = options.applyDisplayTransform
    ? new THREE.WebGLRenderTarget(request.width, request.height, {
        colorSpace: THREE.NoColorSpace,
      })
    : undefined;
  const readTarget = outputTarget ?? sceneTarget;
  const previousRendererState = captureSharedRendererState(request.gl);
  const previousBackground = request.scene.background;
  const pixels = new Uint8Array(request.width * request.height * 4);
  try {
    if (options.ignoreSceneBackground) request.scene.background = null;
    request.gl.setRenderTarget(sceneTarget);
    request.gl.setClearColor(request.clearColor ?? '#000000', request.clearAlpha ?? 1);
    request.gl.setScissorTest(false);
    request.gl.clear();
    const tileSize = Math.max(
      1,
      Math.min(
        Math.floor(options.tileSize ?? Math.max(request.width, request.height)),
        Math.max(request.width, request.height),
      ),
    );
    const tiled = tileSize < request.width || tileSize < request.height;
    if (tiled) {
      const tiles: Array<{ x: number; y: number; width: number; height: number }> = [];
      for (let y = 0; y < request.height; y += tileSize) {
        for (let x = 0; x < request.width; x += tileSize) {
          tiles.push({
            x,
            y,
            width: Math.min(tileSize, request.width - x),
            height: Math.min(tileSize, request.height - y),
          });
        }
      }
      for (let index = 0; index < tiles.length; index += 1) {
        await options.waitForViewportIdle?.();
        const tile = tiles[index];
        markCapturePerformancePhase(options.performancePhasePrefix, 'render-tile');
        request.gl.setRenderTarget(sceneTarget);
        request.gl.setScissorTest(true);
        request.gl.setScissor(tile.x, tile.y, tile.width, tile.height);
        request.gl.render(request.scene, request.camera);
        // Do not let a detached depth/normal capture queue outrun the physical
        // GPU. A flush only submits work; it does not prevent several 256px
        // tiles accumulating behind the onscreen renderer and stealing a later
        // presentation interval. The asynchronous fence drains this tile while
        // leaving the main thread and viewport fully responsive.
        const tileCompletion = waitForSubmittedGpuWork(request.gl);
        // The capture target retains every completed tile. Restore the live
        // renderer before yielding so React Three Fiber cannot inherit our
        // target/scissor state.
        restoreSharedRendererState(request.gl, previousRendererState);
        markCapturePerformancePhase(options.performancePhasePrefix, 'gpu-wait');
        await tileCompletion;
        if (index + 1 < tiles.length) {
          // Resume after every rAF callback (including R3F presentation) has
          // submitted for this frame. Resolving directly inside rAF resumes in
          // a microtask and can put the next detached capture tile in front of
          // the visible viewport even though both paths are individually fast.
          await new Promise<void>((resolve) =>
            window.requestAnimationFrame(() => window.setTimeout(resolve, 0)),
          );
        }
      }
      request.gl.setRenderTarget(sceneTarget);
      request.gl.setScissorTest(false);
    } else {
      request.gl.render(request.scene, request.camera);
    }

    if (outputTarget) {
      getDisplayOutputPass().render(request.gl, outputTarget, sceneTarget, 0, false);
    }

    markCapturePerformancePhase(options.performancePhasePrefix, 'readback-submit');
    const readbackPromise = request.gl.readRenderTargetPixelsAsync(
      readTarget,
      0,
      0,
      request.width,
      request.height,
      pixels,
    );
    // The async PBO read owns the submitted frame. Restore the shared renderer
    // before waiting so React Three Fiber can keep drawing the viewport.
    request.scene.background = previousBackground;
    restoreSharedRendererState(request.gl, previousRendererState);
    options.onRenderSubmitted?.();
    markCapturePerformancePhase(options.performancePhasePrefix, 'readback-wait');
    await readbackPromise;
  } finally {
    request.scene.background = previousBackground;
    restoreSharedRendererState(request.gl, previousRendererState);
    sceneTarget.dispose();
    outputTarget?.dispose();
  }

  markCapturePerformancePhase(options.performancePhasePrefix, 'encode-worker');
  const png = await encodeFlippedGpuReadbackPngInWorker(pixels, request.width, request.height);
  markCapturePerformancePhase(options.performancePhasePrefix, 'publish');
  return createRegisteredObjectUrl(new Blob([png], { type: 'image/png' }));
}

/**
 * Renders several material passes into one target and performs exactly one GPU
 * readback + PNG encode. This is used by the accumulated repaint selection:
 * reading/encoding every archived camera projection separately made button 2
 * scale linearly to multi-second stalls.
 */
export async function renderScenePassesToPngUrl(
  request: CapturePassRequest,
  passes: RenderScenePass[],
  options: Pick<
    RenderSceneToPngOptions,
    'dataTexture' | 'ignoreSceneBackground' | 'onRenderSubmitted'
  > = {},
) {
  const target = new THREE.WebGLRenderTarget(request.width, request.height, {
    samples: 0,
    colorSpace: options.dataTexture ? THREE.NoColorSpace : THREE.SRGBColorSpace,
  });
  const previousRendererState = captureSharedRendererState(request.gl);
  const previousBackground = request.scene.background;
  const pixels = new Uint8Array(request.width * request.height * 4);
  try {
    if (options.ignoreSceneBackground) request.scene.background = null;
    request.gl.autoClear = false;
    request.gl.setRenderTarget(target);
    request.gl.setClearColor(request.clearColor ?? '#000000', request.clearAlpha ?? 1);
    request.gl.clear(true, true, true);
    for (let index = 0; index < passes.length; index += 1) {
      const restore = passes[index].prepare();
      try {
        request.gl.render(request.scene, request.camera);
      } finally {
        restore();
      }
      // Every pass uses the same viewer camera but a different projector. Keep
      // accumulated colour while allowing the next projection to rasterize the
      // same front-most surface again.
      if (index + 1 < passes.length) request.gl.clearDepth();
    }
    const readbackPromise = request.gl.readRenderTargetPixelsAsync(
      target,
      0,
      0,
      request.width,
      request.height,
      pixels,
    );
    request.scene.background = previousBackground;
    restoreSharedRendererState(request.gl, previousRendererState);
    options.onRenderSubmitted?.();
    await readbackPromise;
  } finally {
    request.scene.background = previousBackground;
    restoreSharedRendererState(request.gl, previousRendererState);
    target.dispose();
  }

  const png = await encodeFlippedGpuReadbackPngInWorker(pixels, request.width, request.height);
  return createRegisteredObjectUrl(new Blob([png], { type: 'image/png' }));
}

export function applyTargetOnlyMaterial(
  scene: THREE.Scene,
  objectId: string,
  materialFactory?: (sourceMaterial: THREE.Material) => THREE.Material,
) {
  const snapshots: SceneMaterialSnapshot[] = [];
  const targetMeshes = new Set<THREE.Mesh>();
  const targetAncestors = new Set<THREE.Object3D>([scene]);

  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.userData.liclickObjectId !== objectId) return;
    if (
      object.userData.liclickRestorePlaceholder ||
      object.userData.liclickViewportHelper ||
      object.userData.liclickPaintOverlay ||
      object.userData.liclickSelectionGlow ||
      object.userData.liclickWireframeOverlay
    )
      return;
    targetMeshes.add(object);
    let parent: THREE.Object3D | null = object.parent;
    while (parent) {
      targetAncestors.add(parent);
      parent = parent.parent;
    }
  });

  scene.traverse((object) => {
    if (object === scene || object instanceof THREE.Camera || object instanceof THREE.Light) return;
    const isTarget = object instanceof THREE.Mesh && targetMeshes.has(object);
    const isTargetAncestor = targetAncestors.has(object);
    snapshots.push({
      object,
      visible: object.visible,
      material: object instanceof THREE.Mesh ? object.material : undefined,
    });
    object.visible = isTarget || isTargetAncestor;
    if (isTarget && materialFactory) {
      object.material = Array.isArray(object.material)
        ? object.material.map((material) => materialFactory(material))
        : materialFactory(object.material);
    }
  });

  return () => {
    snapshots.forEach((snapshot) => {
      snapshot.object.visible = snapshot.visible;
      if (snapshot.object instanceof THREE.Mesh && snapshot.material) {
        snapshot.object.material = snapshot.material;
      }
    });
  };
}
