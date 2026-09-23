import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { ViewportRuntime } from '@/stores/sceneStore';
import { waitForViewportInteractionIdle } from '@/engine/viewport/input';

let renderer: THREE.WebGLRenderer | undefined;
let tail: Promise<unknown> = Promise.resolve();
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

// Object3D.copy JSON-serializes userData. Runtime texture references there call
// Texture.toJSON and synchronously encode large images. Capture only reads these
// metadata values; retain references in a new top-level dictionary instead.
function cloneCaptureTree(source: THREE.Object3D): THREE.Object3D {
  const view = new Proxy(source, {
    get: (target, key, receiver) => key === 'userData' ? {} : Reflect.get(target, key, receiver),
  });
  const copy = view.clone(false);
  copy.userData = { ...source.userData };
  for (const child of source.children) copy.add(cloneCaptureTree(child));
  return copy;
}

/** CAPTURE-NORMAL-ISOLATION/1.1.0: thumbnails and geometry guides never draw
 * or install temporary materials on the live renderer/scene. Geometry buffers
 * remain shared read-only; skeletons and scene nodes have independent owners. */
export function withIsolatedNormalCapture<T>(viewport: ViewportRuntime | undefined,
  capture: (isolated: ViewportRuntime) => Promise<T>,
  options: { signal?: AbortSignal; beforeClone?: () => Promise<unknown> } = {}): Promise<T> {
  if (!viewport) return Promise.reject(new Error('视口尚未准备完成，请稍后重试。'));
  const run = tail.catch(() => {}).then(async () => {
    const checkCancelled = () => options.signal?.throwIfAborted();
    checkCancelled();
    await waitForViewportInteractionIdle(180, checkCancelled);
    await options.beforeClone?.();
    checkCancelled();
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
      scene = cloneSkeleton(new Proxy(viewport.scene, {
        get: (target, key, receiver) => key === 'clone' ? () => cloneCaptureTree(target) : Reflect.get(target, key, receiver),
      })) as THREE.Scene;
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
