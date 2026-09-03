import * as THREE from 'three';
import { createProjectedLayerMaterial, disposeGeneratedMaterialTree } from '../projection/ProjectedLayerMaterial';
import { serializeCamera } from '../projection/ProjectionCamera';

/** Keep an owner of the exact overlay program alive throughout remote generation. */
export function prewarmLocalRepaintProgram(
  renderer: THREE.WebGLRenderer,
  geometry: THREE.BufferGeometry,
  camera: THREE.Camera,
) {
  let disposed = false;
  let material: THREE.ShaderMaterial | undefined;
  const startedAt = performance.now();
  document.body.dataset.localRepaintEarlyProgramStatus = 'preparing';
  const ready = (async () => {
    const pixel = document.createElement('canvas');
    pixel.width = pixel.height = 1;
    material = await createProjectedLayerMaterial({
      layerId: 'local-repaint-program-prewarm',
      objectId: 'local-repaint-program-prewarm',
      imageUrl: pixel.toDataURL('image/png'),
      camera: serializeCamera(camera, 1, new THREE.Vector3()),
      opacity: 1,
      visible: true,
      depthTest: true,
      transparentProjectionOnly: true,
    });
    const compileScene = new THREE.Scene();
    const mesh = new THREE.Mesh(geometry, material);
    compileScene.add(mesh);
    try {
      // Isolated scene: never attach a synthetic layer or modify the project.
      await renderer.compileAsync(compileScene, camera);
      if (!disposed) {
        document.body.dataset.localRepaintEarlyProgramStatus = 'ready';
        document.body.dataset.localRepaintEarlyProgramMs = (performance.now() - startedAt).toFixed(1);
      }
    } finally {
      compileScene.remove(mesh);
    }
  })();
  return {
    ready,
    dispose() {
      disposed = true;
      // Three's async compilation still reads the material until polling ends.
      void ready.catch(() => undefined).then(() => {
        if (material) disposeGeneratedMaterialTree(material);
      });
    },
  };
}
