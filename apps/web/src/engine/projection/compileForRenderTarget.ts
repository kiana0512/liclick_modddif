import type * as THREE from 'three';

/** Compile the exact framebuffer variant without holding renderer state across a yield. */
export function compileForRenderTarget(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  target: THREE.WebGLRenderTarget | null,
) {
  const previousTarget = renderer.getRenderTarget();
  const previousFace = renderer.getActiveCubeFace();
  const previousMip = renderer.getActiveMipmapLevel();
  try {
    renderer.setRenderTarget(target);
    return renderer.compileAsync(scene, camera);
  } finally {
    // compileAsync selects the program synchronously, then polls its link status.
    // The visible viewport must regain its framebuffer before that polling yields.
    renderer.setRenderTarget(previousTarget, previousFace, previousMip);
  }
}
