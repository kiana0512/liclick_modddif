import * as THREE from 'three';
import { SkeletonUtils } from 'three-stdlib';
import type { ViewportRuntime } from '@/stores/sceneStore';
import { waitForViewportInteractionIdle } from '@/engine/viewport/viewportInteractionState';

let renderer: THREE.WebGLRenderer | undefined;
let tail: Promise<unknown> = Promise.resolve();
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

/** CAPTURE-NORMAL-ISOLATION/1.0.0: thumbnails and geometry guides never draw
 * or install temporary materials on the live renderer/scene. Geometry buffers
 * remain shared read-only; skeletons and scene nodes have independent owners. */
export function withIsolatedNormalCapture<T>(viewport: ViewportRuntime | undefined,
  capture: (isolated: ViewportRuntime) => Promise<T>): Promise<T> {
  if (!viewport) return Promise.reject(new Error('视口尚未准备完成，请稍后重试。'));
  const run = tail.catch(() => {}).then(async () => {
    await waitForViewportInteractionIdle();
    clearTimeout(releaseTimer);
    if (renderer?.getContext().isContextLost()) { renderer.dispose(); renderer = undefined; }
    renderer ??= new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'high-performance' });
    const owner = renderer;
    owner.outputColorSpace = viewport.gl.outputColorSpace;
    owner.toneMapping = viewport.gl.toneMapping;
    owner.toneMappingExposure = viewport.gl.toneMappingExposure;
    owner.localClippingEnabled = viewport.gl.localClippingEnabled;
    owner.sortObjects = viewport.gl.sortObjects;
    viewport.scene.updateMatrixWorld(true);
    let scene: THREE.Scene | undefined;
    try {
      scene = SkeletonUtils.clone(viewport.scene) as THREE.Scene;
      document.body.dataset.normalCaptureIsolation = 'independent-scene-and-renderer';
      return await capture({ ...viewport, gl: owner, scene, camera: viewport.camera.clone() });
    } finally {
      scene?.traverse(object => { if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose(); });
      scene?.clear();
      releaseTimer = setTimeout(() => {
        if (renderer === owner) { owner.dispose(); owner.forceContextLoss(); renderer = undefined; }
      }, 20_000);
    }
  });
  tail = run.catch(() => {});
  return run;
}
