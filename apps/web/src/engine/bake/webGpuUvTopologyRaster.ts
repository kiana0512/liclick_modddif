import type * as THREE from 'three';
import { recordWebGpuProductionDispatch } from '@/engine/performance/gpuComputeBackend';
import { snapshotUvSeamGeometry, matchesUvSeamGeometry, type UvSeamGeometrySnapshot } from './uvSeamGeometrySnapshot';

export type WebGpuUvTopologyRasterResult = {
  mask: Uint8Array<ArrayBuffer>;
  backend: 'webgpu-worker' | 'cpu-pixel-center-worker';
  gpuAccepted: boolean;
  mismatchedPixels: number;
  rawMismatchedPixels: number;
  maximumDifference: number;
  serializeMs: number;
  gpuMs: number;
  cpuGoldMs: number;
  totalMs: number;
};

type RasterRequest = {
  type: 'raster';
  id: number;
  cacheKey: string;
  triangles: ArrayBuffer;
  width: number;
  height: number;
  preferWebGpu: boolean;
};

type RasterResponse =
  | {
      type: 'result';
      id: number;
      mask: ArrayBuffer;
      backend: WebGpuUvTopologyRasterResult['backend'];
      gpuAccepted: boolean;
      mismatchedPixels: number;
      rawMismatchedPixels: number;
      maximumDifference: number;
      gpuMs: number;
      cpuGoldMs: number;
      totalMs: number;
    }
  | { type: 'error'; id: number; message: string };

type PendingRaster = {
  serializeMs: number;
  resolve: (result: WebGpuUvTopologyRasterResult) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingRaster>();
const trianglesByRoot = new WeakMap<THREE.Object3D, Float32Array<ArrayBuffer>>();
const revisionByRoot = new WeakMap<THREE.Object3D, number>();
let nextGeometryRevision = 1;
let sourceSnapshot: { root: WeakRef<THREE.Object3D>; value: UvSeamGeometrySnapshot } | undefined;
const resultByRoot = new WeakMap<
  THREE.Object3D,
  Map<string, Promise<WebGpuUvTopologyRasterResult>>
>();

function failAllPending(message: string) {
  for (const request of pending.values()) request.reject(new Error(message));
  pending.clear();
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../../workers/webGpuUvTopologyRaster.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<RasterResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.type === 'error') {
      request.reject(new Error(event.data.message));
      return;
    }
    if (event.data.backend === 'webgpu-worker') recordWebGpuProductionDispatch();
    request.resolve({
      mask: new Uint8Array(event.data.mask),
      backend: event.data.backend,
      gpuAccepted: event.data.gpuAccepted,
      mismatchedPixels: event.data.mismatchedPixels,
      rawMismatchedPixels: event.data.rawMismatchedPixels,
      maximumDifference: event.data.maximumDifference,
      serializeMs: request.serializeMs,
      gpuMs: event.data.gpuMs,
      cpuGoldMs: event.data.cpuGoldMs,
      totalMs: event.data.totalMs + request.serializeMs,
    });
  };
  worker.onerror = (event) => {
    failAllPending(event.message || 'WebGPU UV topology worker failed.');
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

function yieldMainThread() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

function collectUvTriangleGeometries(root: THREE.Object3D) {
  const geometries: Array<{
    uv: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    index?: THREE.BufferAttribute | null;
    triangleCount: number;
  }> = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (object.userData.liclickPaintOverlay || object.userData.liclickWireframeOverlay || object.userData.liclickLocalRepaintGpuOverlay) return;
    const uv = mesh.geometry.getAttribute('uv');
    if (!uv) return;
    const index = mesh.geometry.getIndex();
    const triangleCount = Math.floor((index?.count ?? uv.count) / 3);
    if (triangleCount > 0) geometries.push({ uv, index, triangleCount });
  });
  return geometries;
}

// The retained raster input is already an exact reference. For oversized source
// arrays, compare referenced UVs directly instead of inflating another snapshot
// or allocating another full triangle array. Unversioned edits still invalidate.
async function matchesSerializedUvTriangles(root: THREE.Object3D, previous: Float32Array<ArrayBuffer>) {
  const geometries = collectUvTriangleGeometries(root);
  if (geometries.reduce((sum, geometry) => sum + geometry.triangleCount * 6, 0) !== previous.length) return false;
  const expected = new Uint32Array(previous.buffer);
  const converted = new Float32Array(2), convertedBits = new Uint32Array(converted.buffer);
  let offset = 0, verticesSinceYield = 0, sliceStarted = performance.now();
  for (const { uv, index, triangleCount } of geometries) {
    const raw = !('data' in uv) && !uv.normalized && uv.array instanceof Float32Array
      ? new Uint32Array(uv.array.buffer, uv.array.byteOffset, uv.array.length) : undefined;
    for (let vertex = 0; vertex < triangleCount * 3; vertex++) {
      const sourceIndex = index ? index.getX(vertex) : vertex;
      const sourceOffset = sourceIndex * uv.itemSize;
      if (!(raw && Number.isInteger(sourceOffset) && sourceOffset >= 0 && sourceOffset + 1 < raw.length &&
        raw[sourceOffset] === expected[offset] && raw[sourceOffset + 1] === expected[offset + 1])) {
        // Match the existing Float32 serialization for normalized, interleaved,
        // half-float and other formats, including NaN conversion and signed zero.
        converted[0] = uv.getX(sourceIndex); converted[1] = uv.getY(sourceIndex);
        if (convertedBits[0] !== expected[offset] || convertedBits[1] !== expected[offset + 1]) return false;
      }
      offset += 2;
      if (++verticesSinceYield >= 8_192) {
        verticesSinceYield = 0;
        if (performance.now() - sliceStarted >= 4) { await yieldMainThread(); sliceStarted = performance.now(); }
      }
    }
  }
  return true;
}

async function serializeUvTriangles(root: THREE.Object3D) {
  const previous = trianglesByRoot.get(root);
  const run = async <T>(steps: Generator<void, T>) => {
    let start = performance.now();
    let step = steps.next();
    while (!step.done) {
      if (performance.now() - start >= 4) { await yieldMainThread(); start = performance.now(); }
      step = steps.next();
    }
    return step.value;
  };
  if (previous) {
    const snapshot = sourceSnapshot?.root.deref() === root ? sourceSnapshot.value : undefined;
    const matches = snapshot
      ? await run(matchesUvSeamGeometry(root, snapshot, true))
      : await matchesSerializedUvTriangles(root, previous);
    if (matches) return previous;
  }
  // A single bounded source snapshot, rather than re-expanding every triangle
  // on every layer toggle. Actual unversioned UV/index edits still invalidate.
  sourceSnapshot = undefined;
  const snapshot = await run(snapshotUvSeamGeometry(root, true, undefined, false));
  const promise = (async () => {
    const geometries = collectUvTriangleGeometries(root);
    const triangleCount = geometries.reduce((sum, geometry) => sum + geometry.triangleCount, 0);
    const triangles = new Float32Array(triangleCount * 3 * 2);
    let outputOffset = 0;
    let verticesSinceYield = 0;
    let sliceStarted = performance.now();
    for (const geometry of geometries) {
      for (let triangle = 0; triangle < geometry.triangleCount; triangle += 1) {
        for (let corner = 0; corner < 3; corner += 1) {
          const sourceIndex = geometry.index
            ? geometry.index.getX(triangle * 3 + corner)
            : triangle * 3 + corner;
          triangles[outputOffset++] = geometry.uv.getX(sourceIndex);
          triangles[outputOffset++] = geometry.uv.getY(sourceIndex);
        }
        verticesSinceYield += 3;
        // This is only cooperative source-data serialization, not image
        // tiling. Keep every main-thread burst below one display frame while
        // the actual topology raster remains a single Worker WebGPU pass.
        if (verticesSinceYield >= 8_192) {
          verticesSinceYield = 0;
          if (performance.now() - sliceStarted >= 4) {
            await yieldMainThread();
            sliceStarted = performance.now();
          }
        }
      }
    }
    return triangles;
  })();
  const triangles = await promise;
  if (snapshot && await run(matchesUvSeamGeometry(root, snapshot, true))) sourceSnapshot = {root:new WeakRef(root), value:snapshot};
  else if (snapshot) throw new Error('UV geometry changed during topology preparation.');
  else if (!await matchesSerializedUvTriangles(root, triangles)) throw new Error('UV geometry changed during topology preparation.');
  if (previous?.length === triangles.length) {
    const currentBits = new Uint32Array(triangles.buffer);
    const previousBits = new Uint32Array(previous.buffer);
    let equal = true;
    for (let start = 0; equal && start < currentBits.length; start += 65536) {
      const end = Math.min(start + 65536, currentBits.length);
      for (let i = start; i < end; i++) {
        if (currentBits[i] !== previousBits[i]) { equal = false; break; }
      }
      if (end < currentBits.length) await yieldMainThread();
    }
    if (equal) return previous;
  }
  // UV arrays can change without needsUpdate. Both the page and Worker caches
  // must invalidate from actual serialized triangles, including helper removal.
  trianglesByRoot.set(root, triangles);
  resultByRoot.delete(root);
  revisionByRoot.set(root, nextGeometryRevision++);
  return triangles;
}

/**
 * Runs a genuine Worker-owned WebGPU render pipeline. The first topology for a
 * model/resolution is compared pixel-for-pixel with the same pixel-centre gold
 * raster inside the Worker. A mismatch publishes the gold mask, never the GPU
 * candidate, so enabling this path cannot change UV repair quality.
 */
export async function rasterizeUvTopologyMaskWithWebGpu(
  root: THREE.Object3D,
  width: number,
  height: number,
) {
  const serializeStartedAt = performance.now();
  const triangles = await serializeUvTriangles(root);
  const serializeMs = performance.now() - serializeStartedAt;
  let cache = resultByRoot.get(root);
  if (!cache) {
    cache = new Map();
    resultByRoot.set(root, cache);
  }
  const preferWebGpu =
    typeof window === 'undefined' ||
    new URLSearchParams(window.location.search).get('webGpuUvTopology') !== '0';
  const cacheKey = `${root.uuid}:${revisionByRoot.get(root)}:${width}x${height}:pixel-center-uv-extent-v3:${preferWebGpu ? 'gpu' : 'compat'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached.then(result => ({...result, serializeMs, gpuMs:0, cpuGoldMs:0, totalMs:serializeMs}));
  const promise = (async () => {
    if (typeof Worker === 'undefined' || typeof window === 'undefined') {
      throw new Error('Worker WebGPU UV topology raster is unavailable.');
    }
    if (triangles.length === 0) throw new Error('The model has no UV triangles.');
    const id = nextRequestId++;
    const request: RasterRequest = {
      type: 'raster',
      id,
      cacheKey,
      // Do not transfer the cached geometry buffer: detaching it would force
      // another high-poly traversal on the next resolution or bake.
      triangles: triangles.buffer,
      width,
      height,
      preferWebGpu,
    };
    return new Promise<WebGpuUvTopologyRasterResult>((resolve, reject) => {
      pending.set(id, { resolve, reject, serializeMs });
      if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true' && getPipelineTrace()) Object.assign(request, prepareTracedWorkerRequest(getWorker(), request.id, 'uv.compose'));
      getWorker().postMessage(request);
    });
  })().catch((error) => {
    cache?.delete(cacheKey);
    throw error;
  });
  cache.set(cacheKey, promise);
  return promise;
}

export function terminateWebGpuUvTopologyRasterWorker() {
  sourceSnapshot = undefined;
  failAllPending('WebGPU UV topology worker was terminated.');
  worker?.terminate();
  worker = undefined;
}
import { getPipelineTrace } from '@/engine/performance/tracing/pipelineTrace';
import { prepareTracedWorkerRequest } from '@/engine/performance/tracing/workerTraceTransport';
