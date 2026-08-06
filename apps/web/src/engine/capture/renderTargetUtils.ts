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
  /**
   * Runs as soon as the offscreen render and readback have been submitted,
   * before this function yields while waiting for the pixels. Callers that
   * temporarily mutate the live scene can restore it here so the viewport
   * never presents the capture-only materials or visibility state.
   */
  onRenderSubmitted?: () => void;
};

let displayOutputPass: OutputPass | undefined;

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
  const previousTarget = request.gl.getRenderTarget();
  const previousClearColor = new THREE.Color();
  request.gl.getClearColor(previousClearColor);
  const previousClearAlpha = request.gl.getClearAlpha();
  const previousBackground = request.scene.background;
  const pixels = new Uint8Array(request.width * request.height * 4);
  try {
    if (options.ignoreSceneBackground) request.scene.background = null;
    request.gl.setRenderTarget(sceneTarget);
    request.gl.setClearColor(request.clearColor ?? '#000000', request.clearAlpha ?? 1);
    request.gl.clear();
    request.gl.render(request.scene, request.camera);

    if (outputTarget) {
      getDisplayOutputPass().render(request.gl, outputTarget, sceneTarget, 0, false);
    }

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
    request.gl.setRenderTarget(previousTarget);
    request.gl.setClearColor(previousClearColor, previousClearAlpha);
    options.onRenderSubmitted?.();
    await readbackPromise;
  } finally {
    request.scene.background = previousBackground;
    request.gl.setRenderTarget(previousTarget);
    request.gl.setClearColor(previousClearColor, previousClearAlpha);
    sceneTarget.dispose();
    outputTarget?.dispose();
  }

  const png = await encodeFlippedGpuReadbackPngInWorker(
    pixels,
    request.width,
    request.height,
  );
  return createRegisteredObjectUrl(new Blob([png], { type: 'image/png' }));
}

export function applyTargetOnlyMaterial(
  scene: THREE.Scene,
  objectId: string,
  materialFactory?: () => THREE.Material,
) {
  const snapshots: SceneMaterialSnapshot[] = [];
  const targetMeshes = new Set<THREE.Mesh>();
  const targetAncestors = new Set<THREE.Object3D>([scene]);

  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.userData.liclickObjectId !== objectId) return;
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
    if (isTarget && materialFactory) object.material = materialFactory();
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
