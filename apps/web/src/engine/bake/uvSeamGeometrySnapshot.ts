import type * as THREE from 'three';

// Exact bytes, rather than a short hash or BufferAttribute.version: callers
// can edit CPU geometry without raising needsUpdate. Only one seam plan retains
// these snapshots, with a 32 MiB limit, independently of projection image size.
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export type UvSeamGeometrySnapshot = { description: string; buffers: Uint8Array[] };

function describe(root: THREE.Object3D): UvSeamGeometrySnapshot {
  root.updateMatrixWorld(true);
  const description: unknown[] = [];
  const buffers: Uint8Array[] = [];
  root.traverse(node => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    description.push(node.uuid, node.matrixWorld.elements.slice());
    const geometry = mesh.geometry;
    for (const attribute of [geometry.getAttribute('position'), geometry.getAttribute('normal'),
      geometry.getAttribute('uv'), geometry.index]) {
      if (!attribute) { description.push(null); continue; }
      const array = attribute.array;
      description.push(attribute.constructor.name, array.constructor.name, attribute.itemSize, attribute.count,
        attribute.normalized, 'data' in attribute ? [attribute.offset, attribute.data.stride] : null);
      buffers.push(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    }
  });
  return { description: JSON.stringify(description), buffers };
}

export function* snapshotUvSeamGeometry(root: THREE.Object3D) {
  const state = describe(root);
  if (state.buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0) > MAX_SNAPSHOT_BYTES) {
    return undefined;
  }
  const buffers: Uint8Array[] = [];
  for (const source of state.buffers) {
    const copy = new Uint8Array(source.byteLength);
    for (let offset = 0; offset < copy.length; offset += 65536) {
      copy.set(source.subarray(offset, offset + 65536), offset);
      yield;
    }
    buffers.push(copy);
  }
  return { description: state.description, buffers };
}

export function* matchesUvSeamGeometry(root: THREE.Object3D, snapshot: UvSeamGeometrySnapshot) {
  const state = describe(root);
  if (state.description !== snapshot.description || state.buffers.length !== snapshot.buffers.length) return false;
  for (let index = 0; index < state.buffers.length; index++) {
    const current = state.buffers[index], previous = snapshot.buffers[index];
    if (current.length !== previous.length) return false;
    for (let offset = 0; offset < current.length; offset++) {
      if (current[offset] !== previous[offset]) return false;
      if ((offset & 65535) === 65535) yield;
    }
  }
  return true;
}
