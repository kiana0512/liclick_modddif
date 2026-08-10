import { recordWebGpuProductionDispatch } from '@/engine/performance/gpuComputeBackend';
import {
  isViewportInteractionBusy,
  subscribeViewportInteraction,
} from '@/engine/viewport/viewportInteractionState';

// Smaller submissions keep the render queue available to the viewport during
// 4K UV composition. This changes scheduling only; every RGBA byte is still
// processed and the existing CPU/GPU parity check remains exact.
const INTERACTIVE_CHUNK_BYTES = 1 * 1024 * 1024;
const IDLE_CHUNK_BYTES = 8 * 1024 * 1024;

export type WebGpuRgbaCompositeMetrics = {
  uploadMs: number;
  computeMs: number;
  readbackMs: number;
  totalMs: number;
  bytesTransferred: number;
  chunkBytes: number;
  backend: 'webgpu-worker' | 'cpu-worker';
};

export type WebGpuRgbaCompositeResult = {
  data: Uint8ClampedArray<ArrayBuffer>;
  metrics: WebGpuRgbaCompositeMetrics;
  verification?: {
    byteMismatches: number;
    maximumByteDelta: number;
    firstMismatch?: {
      byteOffset: number;
      expectedRgba: number[];
      actualRgba: number[];
    };
    usedCpuOutput: boolean;
  };
};

type CompositeRequest = {
  type: 'composite';
  id: number;
  front: ArrayBuffer;
  underlay?: ArrayBuffer;
  underlayUrl?: string;
  width?: number;
  height?: number;
  opacity: number;
  verify: boolean;
  interactive: boolean;
  interactiveChunkBytes: number;
  idleChunkBytes: number;
};

type BudgetRequest = { type: 'budget'; interactive: boolean };
type ReleaseRequest = { type: 'release' };

type CompositeResponse =
  | {
      type: 'result';
      id: number;
      output: ArrayBuffer;
      metrics: WebGpuRgbaCompositeMetrics;
      verification?: WebGpuRgbaCompositeResult['verification'];
    }
  | { type: 'error'; id: number; message: string };

type PendingComposite = {
  resolve: (result: WebGpuRgbaCompositeResult) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingComposite>();
let stopInteractionSubscription: (() => void) | undefined;
let interactionHeartbeat: number | undefined;

function isInteractionProtected() {
  return (
    isViewportInteractionBusy() ||
    (typeof document !== 'undefined' &&
      document.body.dataset.perfSimulatedViewportInteraction === '1')
  );
}

function getRequestedChunkBytes() {
  if (typeof window === 'undefined') return undefined;
  const params = new URLSearchParams(window.location.search);
  if (params.get('perfLab') !== '1') return undefined;
  const requestedMb = Number(params.get('perfWebGpuChunkMb'));
  if (!Number.isFinite(requestedMb) || requestedMb <= 0) return undefined;
  return Math.round(Math.max(1, Math.min(16, requestedMb)) * 1024 * 1024);
}

function postBudgetState() {
  if (!worker) return;
  const message: BudgetRequest = { type: 'budget', interactive: isInteractionProtected() };
  worker.postMessage(message);
}

function maintainInteractionHeartbeat() {
  if (pending.size > 0 && interactionHeartbeat === undefined) {
    interactionHeartbeat = window.setInterval(postBudgetState, 50);
  } else if (pending.size === 0 && interactionHeartbeat !== undefined) {
    window.clearInterval(interactionHeartbeat);
    interactionHeartbeat = undefined;
  }
}

function failAllPending(message: string) {
  for (const request of pending.values()) request.reject(new Error(message));
  pending.clear();
  maintainInteractionHeartbeat();
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../../workers/webGpuRgbaComposite.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<CompositeResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    maintainInteractionHeartbeat();
    if (event.data.type === 'error') {
      request.reject(new Error(event.data.message));
      return;
    }
    if (event.data.metrics.backend === 'webgpu-worker') recordWebGpuProductionDispatch();
    request.resolve({
      data: new Uint8ClampedArray(event.data.output),
      metrics: event.data.metrics,
      verification: event.data.verification,
    });
  };
  worker.onerror = (event) => {
    failAllPending(event.message || 'WebGPU composite worker failed.');
    worker?.terminate();
    worker = undefined;
  };
  stopInteractionSubscription = subscribeViewportInteraction(postBudgetState);
  return worker;
}

function transferableBuffer(source: Uint8Array | Uint8ClampedArray) {
  if (
    source.buffer instanceof ArrayBuffer &&
    source.byteOffset === 0 &&
    source.byteLength === source.buffer.byteLength
  ) {
    return source.buffer;
  }
  const copy = new Uint8Array(source.byteLength);
  copy.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  return copy.buffer;
}

/**
 * Transfers ownership of both source buffers to a persistent worker. The worker
 * owns WebGPU upload, compute, readback and the mapped-range copy, so the main
 * thread only receives the finished buffer by zero-copy ownership transfer.
 */
export function compositeRgbaUnderWithWebGpu(
  front: Uint8Array | Uint8ClampedArray,
  underlay: Uint8Array | Uint8ClampedArray,
  opacity = 1,
) {
  if (front.length !== underlay.length || front.length % 4 !== 0) {
    return Promise.reject(new RangeError('RGBA buffers must have the same four-channel length.'));
  }
  const layerOpacity = Math.max(0, Math.min(1, opacity));
  if (layerOpacity <= 0 || front.length === 0) {
    return Promise.resolve<WebGpuRgbaCompositeResult>({
      data: new Uint8ClampedArray(transferableBuffer(front)),
      metrics: {
        uploadMs: 0,
        computeMs: 0,
        readbackMs: 0,
        totalMs: 0,
        bytesTransferred: 0,
        chunkBytes: isInteractionProtected() ? INTERACTIVE_CHUNK_BYTES : IDLE_CHUNK_BYTES,
        backend: 'webgpu-worker',
      },
    });
  }

  const id = nextRequestId++;
  const frontBuffer = transferableBuffer(front);
  const underlayBuffer = transferableBuffer(underlay);
  const requestedChunkBytes = getRequestedChunkBytes();
  const request: CompositeRequest = {
    type: 'composite',
    id,
    front: frontBuffer,
    underlay: underlayBuffer,
    opacity: layerOpacity,
    verify:
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('perfWebGpuAb') === '1',
    interactive: isInteractionProtected(),
    interactiveChunkBytes: requestedChunkBytes ?? INTERACTIVE_CHUNK_BYTES,
    idleChunkBytes: requestedChunkBytes ?? IDLE_CHUNK_BYTES,
  };

  return new Promise<WebGpuRgbaCompositeResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    maintainInteractionHeartbeat();
    getWorker().postMessage(request, [frontBuffer, underlayBuffer]);
  });
}

/** Loads and rasterizes the underlay inside the worker, removing DOM image,
 * Canvas draw and getImageData work from the animation/UI thread. */
export function compositeRgbaUrlUnderWithWebGpu(
  front: Uint8Array | Uint8ClampedArray,
  underlayUrl: string,
  width: number,
  height: number,
  opacity = 1,
) {
  if (front.length !== width * height * 4) {
    return Promise.reject(new RangeError('RGBA buffer dimensions do not match.'));
  }
  const layerOpacity = Math.max(0, Math.min(1, opacity));
  if (layerOpacity <= 0 || front.length === 0) {
    return Promise.resolve<WebGpuRgbaCompositeResult>({
      data: new Uint8ClampedArray(transferableBuffer(front)),
      metrics: {
        uploadMs: 0,
        computeMs: 0,
        readbackMs: 0,
        totalMs: 0,
        bytesTransferred: 0,
        chunkBytes: isInteractionProtected() ? INTERACTIVE_CHUNK_BYTES : IDLE_CHUNK_BYTES,
        backend: 'webgpu-worker',
      },
    });
  }

  const id = nextRequestId++;
  const frontBuffer = transferableBuffer(front);
  const requestedChunkBytes = getRequestedChunkBytes();
  const request: CompositeRequest = {
    type: 'composite',
    id,
    front: frontBuffer,
    underlayUrl,
    width,
    height,
    opacity: layerOpacity,
    verify:
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('perfWebGpuAb') === '1',
    interactive: isInteractionProtected(),
    interactiveChunkBytes: requestedChunkBytes ?? INTERACTIVE_CHUNK_BYTES,
    idleChunkBytes: requestedChunkBytes ?? IDLE_CHUNK_BYTES,
  };
  return new Promise<WebGpuRgbaCompositeResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    maintainInteractionHeartbeat();
    getWorker().postMessage(request, [frontBuffer]);
  });
}

export function releaseWebGpuRgbaCompositeResources() {
  const message: ReleaseRequest = { type: 'release' };
  worker?.postMessage(message);
}

export function terminateWebGpuRgbaCompositeWorker() {
  failAllPending('WebGPU composite worker was terminated.');
  stopInteractionSubscription?.();
  stopInteractionSubscription = undefined;
  worker?.terminate();
  worker = undefined;
}
