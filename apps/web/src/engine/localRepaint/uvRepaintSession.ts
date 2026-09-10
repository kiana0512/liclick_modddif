import * as THREE from 'three';
import { UvRepaint, createUvRepaintSourceMaterial } from './uvRepaint';
import { publishUvRepaintLayer } from './uvRepaintLayer';
import { createUvRepaintSelectionCanvas, type UvRepaintPatch } from './uvRepaintState';
import { useLayerStore } from '@/stores/layerStore';
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { useToastStore } from '@/stores/toastStore';
import type { LocalRepaintProjectionSource } from '@/stores/sceneStore';
import { paintHistoryBoundary } from '@/engine/paint/paintHistoryBoundary';
import {
  getLiveProjectedTexture,
  markLiveProjectedCanvasTextureUpdated,
  registerLiveUvRenderTarget,
  trackLiveUvCommit,
} from '@/engine/projection/liveProjectedCanvasTextureRegistry';

type Restore = (side: 'before' | 'after') => void;
type StrokeCommit = {
  erase: boolean;
  invalidate: () => void;
  consume?: (coverage: HTMLCanvasElement) => Restore | undefined;
  owner: () => UvRepaint | undefined;
};
export type NativeUvRepaintSession = {
  engine: UvRepaint;
  assetUrl: string;
  commitStroke: (input: StrokeCommit) => void;
};

/** Lazy session coordinator: source preparation, pixel publication and history.
 * Render passes stay in UvRepaint; no server writes or generation requests. */
export async function createNativeUvRepaintSession(input: {
  renderer: THREE.WebGLRenderer;
  meshes: THREE.Mesh[];
  camera: THREE.Camera;
  resolution: number;
  sourceMaterial: THREE.ShaderMaterial;
  image: HTMLImageElement;
  falloff: HTMLCanvasElement;
  initial?: CanvasImageSource;
  source: LocalRepaintProjectionSource;
  objectId: string;
  layerId: string;
  cancelled: () => boolean;
}) {
  const fullSource = new THREE.Texture(input.image);
  fullSource.colorSpace = THREE.SRGBColorSpace;
  fullSource.flipY = false;
  fullSource.needsUpdate = true;
  const allowed = new THREE.CanvasTexture(input.falloff);
  allowed.flipY = false;
  const material = createUvRepaintSourceMaterial(input.sourceMaterial);
  material.uniforms.projectedMap.value = fullSource;
  material.uniforms.maskMap.value = allowed;
  let engine: UvRepaint | undefined;
  try {
    engine = new UvRepaint(input.renderer, input.meshes, input.resolution);
    await engine.prepare(material, input.camera, input.initial);
    if (input.cancelled()) {
      engine.dispose();
      return undefined;
    }
    const assetUrl = registerLiveUvRenderTarget(
      `${input.layerId}:rgba`,
      engine.canvas,
      engine.texture,
    );
    const live = engine;
    let commit = Promise.resolve();
    const publish = () => {
      markLiveProjectedCanvasTextureUpdated(assetUrl, {
        upload: getLiveProjectedTexture(assetUrl) !== live.texture,
      });
      publishUvRepaintLayer({
        id: input.layerId,
        assetUrl,
        source: input.source,
        objectId: input.objectId,
      });
    };
    const commitStroke = (stroke: StrokeCommit) => {
      const epoch = paintHistoryBoundary.version;
      const patchesPromise = live.end();
      let restore: Restore | undefined;
      const discard = useEditorHistoryStore.getState().captureRuntime({
        label: stroke.erase ? 'UV 局部重绘擦除' : 'UV 局部重绘笔画',
        undo: () => restore?.('before'),
        redo: () => restore?.('after'),
      });
      const work = commit.then(async () => {
        const patches: UvRepaintPatch[] = await patchesPromise;
        if (
          epoch !== paintHistoryBoundary.version ||
          !patches.length ||
          !useLayerStore.getState().layers.some((layer) => layer.id === input.layerId)
        ) {
          discard();
          return;
        }
        live.publish(patches, 'after');
        const restoreSelection =
          !stroke.erase && stroke.consume
            ? stroke.consume(createUvRepaintSelectionCanvas(patches, live.resolution))
            : undefined;
        restore = (side) => {
          (stroke.owner() ?? live).publish(patches, side, true);
          restoreSelection?.(side);
          publish();
          stroke.invalidate();
        };
        publish();
        stroke.invalidate();
      });
      commit = work.catch((error) => {
        discard();
        useToastStore
          .getState()
          .pushToast({
            tone: 'error',
            title: 'UV 重绘笔画保存失败',
            description: error instanceof Error ? error.message : String(error),
          });
      });
      paintHistoryBoundary.track(commit);
      trackLiveUvCommit(work, assetUrl);
    };
    publishUvRepaintLayer({
      id: input.layerId,
      assetUrl,
      source: input.source,
      objectId: input.objectId,
      initialize: true,
    });
    return { engine, assetUrl, commitStroke } satisfies NativeUvRepaintSession;
  } catch (error) {
    engine?.dispose();
    throw error;
  } finally {
    material.dispose();
    fullSource.dispose();
    allowed.dispose();
  }
}
