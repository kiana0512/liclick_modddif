import type * as THREE from 'three';

const compiling = new WeakMap<THREE.Material, { count: number; dispose?: () => void }>();

/** Keep Three's material program alive until every async poller has settled. */
export function deferDisposalDuringCompile(material: THREE.Material, dispose: () => void) {
  const lease = compiling.get(material);
  if (!lease) return false;
  lease.dispose = dispose;
  return true;
}

/** Compile the exact framebuffer variant without holding renderer state across a yield. */
export function compileForRenderTarget(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  target: THREE.WebGLRenderTarget | null,
) {
  const materials = new Set<THREE.Material>();
  scene.traverse((object) => {
    const material = (object as THREE.Mesh).material;
    if (Array.isArray(material)) material.forEach((item) => materials.add(item));
    else if (material) materials.add(material);
  });
  materials.forEach((material) => {
    const lease = compiling.get(material) ?? { count: 0 };
    lease.count++;
    compiling.set(material, lease);
  });
  const release = () => materials.forEach((material) => {
    const lease = compiling.get(material)!;
    if (--lease.count === 0) {
      compiling.delete(material);
      lease.dispose?.();
    }
  });
  const previousTarget = renderer.getRenderTarget();
  const previousFace = renderer.getActiveCubeFace();
  const previousMip = renderer.getActiveMipmapLevel();
  try {
    renderer.setRenderTarget(target);
    return renderer.compileAsync(scene, camera).then(
      (result) => { release(); return result; },
      (error: unknown) => { release(); throw error; },
    );
  } catch (error) {
    release();
    throw error;
  } finally {
    // compileAsync selects the program synchronously, then polls its link status.
    // The visible viewport must regain its framebuffer before that polling yields.
    renderer.setRenderTarget(previousTarget, previousFace, previousMip);
  }
}
