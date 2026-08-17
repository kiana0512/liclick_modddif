import type * as THREE from 'three';
import { recordWebGpuProductionDispatch } from '@/engine/performance/gpuComputeBackend';

export type WebGpuUvTopologyRasterResult = {
  mask: Uint8Array<ArrayBuffer>;
  backend: 'webgpu-worker' | 'offscreen-canvas-worker';
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
const trianglesByRoot = new WeakMap<THREE.Object3D, Promise<Float32Array<ArrayBuffer>>>();
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

async function serializeUvTriangles(root: THREE.Object3D) {
  const cached = trianglesByRoot.get(root);
  if (cached) return cached;
  const promise = (async () => {
    const geometries: Array<{
      uv: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
      index?: THREE.BufferAttribute | null;
      triangleCount: number;
    }> = [];
    let triangleCount = 0;
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const uv = mesh.geometry.getAttribute('uv');
      if (!uv) return;
      const index = mesh.geometry.getIndex();
      const meshTriangleCount = Math.floor((index?.count ?? uv.count) / 3);
      if (meshTriangleCount <= 0) return;
      geometries.push({ uv, index, triangleCount: meshTriangleCount });
      triangleCount += meshTriangleCount;
    });
    const triangles = new Float32Array(triangleCount * 3 * 2);
    let outputOffset = 0;
    let verticesSinceYield = 0;
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
          await yieldMainThread();
        }
      }
    }
    return triangles;
  })();
  trianglesByRoot.set(root, promise);
  return promise;
}

/**
 * Runs a genuine Worker-owned WebGPU render pipeline. The first topology for a
 * model/resolution is compared pixel-for-pixel with the same Canvas2D gold
 * raster inside the Worker. A mismatch publishes the gold mask, never the GPU
 * candidate, so enabling this path cannot change UV repair quality.
 */
export function rasterizeUvTopologyMaskWithWebGpu(
  root: THREE.Object3D,
  width: number,
  height: number,
) {
  let cache = resultByRoot.get(root);
  if (!cache) {
    cache = new Map();
    resultByRoot.set(root, cache);
  }
  const preferWebGpu =
    typeof window === 'undefined' ||
    new URLSearchParams(window.location.search).get('webGpuUvTopology') !== '0';
  const cacheKey = `${root.uuid}:${width}x${height}:pixel-center:${preferWebGpu ? 'gpu' : 'compat'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const promise = (async () => {
    if (typeof Worker === 'undefined' || typeof window === 'undefined') {
      throw new Error('Worker WebGPU UV topology raster is unavailable.');
    }
    const serializeStartedAt = performance.now();
    const triangles = await serializeUvTriangles(root);
    const serializeMs = performance.now() - serializeStartedAt;
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
  failAllPending('WebGPU UV topology worker was terminated.');
  worker?.terminate();
  worker = undefined;
}
