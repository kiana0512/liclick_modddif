import type * as THREE from 'three';

/** Clone the compile shell, without serializing application-owned metadata. */
export function cloneShaderWarmupMesh(sourceMesh: THREE.Mesh) {
  // Object3D.copy JSON-serializes userData, including our original materials
  // and their texture images. Shader compilation never consumes that metadata.
  // Shadow it on a read-through source rather than mutating the live mesh.
  // Keep Three's subclass copy: skinning, instancing, morphs and transforms
  // must select exactly the same programs as the previous clone(false).
  const compileSource = Object.create(sourceMesh, { userData: { value: {} } }) as THREE.Mesh;
  return compileSource.clone(false) as THREE.Mesh;
}
