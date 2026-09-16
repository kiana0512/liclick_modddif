import type * as THREE from 'three';
import { deflateSync, inflateSync } from 'fflate';

// Exact bytes, rather than a short hash or BufferAttribute.version: callers
// can edit CPU geometry without raising needsUpdate. Only one seam plan retains
// these snapshots, with a default 32 MiB limit. Repair plans can supply their
// shared snapshot/address budget, independently of projection image size.
// Large sources use lossless blocks; every restored byte is still compared.
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_BLOCK_BYTES = 65536;
type CompressedBuffer = { byteLength: number; chunks: Uint8Array[] };
export type UvSeamGeometrySnapshot = { description: string; buffers: Uint8Array[];
  compressed?: CompressedBuffer[] };

function describe(root: THREE.Object3D, topologyOnly = false) {
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

export function uvSeamSnapshotByteLength(snapshot: UvSeamGeometrySnapshot) {
  return snapshot.compressed
    ? snapshot.compressed.reduce((sum, buffer) => sum + buffer.chunks.reduce((size, chunk) => size + chunk.byteLength, 0), 0)
    : snapshot.buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
}

export function* snapshotUvSeamGeometry(root: THREE.Object3D, topologyOnly = false,
  maximumBytes = MAX_SNAPSHOT_BYTES, compressOversize = true): Generator<void, UvSeamGeometrySnapshot | undefined> {
  const state = describe(root, topologyOnly);
  const bytes = state.buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  if (typeof document !== 'undefined') document.body.dataset.residentUvSeamGeometryBytes = String(bytes);
  const recordStorage = (storedBytes: number, encoding: string) => {
    if (!topologyOnly && typeof document !== 'undefined') {
      document.body.dataset.residentUvSeamSnapshotBytes = String(storedBytes);
      document.body.dataset.residentUvSeamSnapshotEncoding = encoding;
    }
  };
  if (bytes > Math.min(MAX_SNAPSHOT_BYTES, maximumBytes)) {
    if (!compressOversize) return undefined;
    const compressed: CompressedBuffer[] = [];
    let storedBytes = 0;
    for (let index = 0; index < state.buffers.length; index++) {
      const source = state.buffers[index];
      const chunks: Uint8Array[] = [];
      for (let offset = 0; offset < source.length; offset += SNAPSHOT_BLOCK_BYTES) {
        const block = source.subarray(offset, offset + SNAPSHOT_BLOCK_BYTES);
        const chunk = deflateSync(block, { level: 1 });
        storedBytes += chunk.byteLength;
        if (storedBytes > maximumBytes) {
          recordStorage(0, 'over-budget');
          return undefined;
        }
        chunks.push(chunk);
        yield;
      }
      compressed.push({ byteLength: source.byteLength, chunks });
    }
    recordStorage(storedBytes, 'lossless-blocks');
    return { description: state.description, buffers: [], compressed };
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
  recordStorage(bytes, 'raw');
  return { description: state.description, buffers };
}

export function* matchesUvSeamGeometry(root: THREE.Object3D, snapshot: UvSeamGeometrySnapshot, topologyOnly = false) {
  const state = describe(root, topologyOnly);
  if (state.description !== snapshot.description ||
    state.buffers.length !== (snapshot.compressed ?? snapshot.buffers).length) return false;
  if (snapshot.compressed) {
    for (let index = 0; index < state.buffers.length; index++) {
      const current = state.buffers[index], saved = snapshot.compressed[index];
      if (current.length !== saved.byteLength) return false;
      let offset = 0;
      for (const chunk of saved.chunks) {
        const previous = inflateSync(chunk);
        for (let byte = 0; byte < previous.length; byte++) {
          if (current[offset + byte] !== previous[byte]) return false;
        }
        offset += previous.length;
        yield;
      }
    }
    return true;
  }
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
