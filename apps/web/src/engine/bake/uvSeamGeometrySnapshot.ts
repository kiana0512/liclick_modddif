import type * as THREE from 'three';

// Exact bytes, rather than a short hash or BufferAttribute.version: callers
// can edit CPU geometry without raising needsUpdate. Only one seam plan retains
// these snapshots, with a 32 MiB limit, independently of projection image size.
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export type UvSeamGeometrySnapshot = { description: string; buffers: Uint8Array[] };

function describe(root: THREE.Object3D, topologyOnly = false): UvSeamGeometrySnapshot {
  root.updateMatrixWorld(true);
  const description: unknown[] = [];
  const buffers: Uint8Array[] = [];
  const spans = new Map<ArrayBufferLike, Set<string>>();
  root.traverse(node => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (node.userData.liclickPaintOverlay || node.userData.liclickWireframeOverlay || node.userData.liclickLocalRepaintGpuOverlay) return;
    description.push(node.uuid, topologyOnly ? null : node.matrixWorld.elements.slice());
    const geometry = mesh.geometry;
    const attributes = topologyOnly ? [geometry.getAttribute('uv'), geometry.index]
      : [geometry.getAttribute('position'), geometry.getAttribute('normal'), geometry.getAttribute('uv'), geometry.index];
    for (const attribute of attributes) {
      if (!attribute) { description.push(null); continue; }
      const array = attribute.array;
      description.push(attribute.constructor.name, array.constructor.name, attribute.itemSize, attribute.count,
        attribute.normalized, 'data' in attribute ? [attribute.offset, attribute.data.stride] : null);
      const span = `${array.byteOffset}:${array.byteLength}`;
      let seen = spans.get(array.buffer);
      if (!seen) { seen = new Set(); spans.set(array.buffer, seen); }
      description.push(buffers.length, span);
      if (!seen.has(span)) {
        seen.add(span);
        buffers.push(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
      }
    }
  });
  return { description: JSON.stringify(description), buffers };
}

export function* snapshotUvSeamGeometry(root: THREE.Object3D, topologyOnly = false) {
  const state = describe(root, topologyOnly);
  const bytes = state.buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  if (typeof document !== 'undefined') document.body.dataset.residentUvSeamGeometryBytes = String(bytes);
  if (bytes > MAX_SNAPSHOT_BYTES) {
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

export function* matchesUvSeamGeometry(root: THREE.Object3D, snapshot: UvSeamGeometrySnapshot, topologyOnly = false) {
  const state = describe(root, topologyOnly);
  if (state.description !== snapshot.description || state.buffers.length !== snapshot.buffers.length) return false;
  for (let index = 0; index < state.buffers.length; index++) {
    const current = state.buffers[index], previous = snapshot.buffers[index];
    if (current.length !== previous.length) return false;
    let compared = 0;
    if (current.byteOffset % 4 === 0) {
      const words = new Uint32Array(current.buffer, current.byteOffset, Math.floor(current.length / 4));
      const saved = new Uint32Array(previous.buffer, previous.byteOffset, words.length);
      for (let first = 0; first < words.length; first += 16384) {
        const end = Math.min(first + 16384, words.length);
        for (let offset = first; offset < end; offset++) if (words[offset] !== saved[offset]) return false;
        yield;
      }
      compared = words.length * 4;
    }
    for (let offset = compared; offset < current.length; offset++) {
      if (current[offset] !== previous[offset]) return false;
      if ((offset & 65535) === 65535) yield;
    }
  }
  return true;
}
