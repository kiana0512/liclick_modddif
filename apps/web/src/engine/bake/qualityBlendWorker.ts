import { recordWebGpuProductionDispatch } from '@/engine/performance/gpuComputeBackend';
import { markPerformanceEvent } from '@/engine/performance/performanceTimeline';
import {
  isViewportInteractionBusy,
  subscribeViewportInteraction,
} from '@/engine/viewport/viewportInteractionState';

export type QualityBlendWorkerLayer = {
  color: Uint8ClampedArray;
  quality: Float32Array;
};

export type QualityBlendVerification = {
  byteMismatches: number;
  alphaByteMismatches: number;
  mismatchRatio: number;
  maximumByteDelta: number;
  firstMismatch?: {
    byteOffset: number;
    expectedRgba: number[];
    actualRgba: number[];
  };
  usedCpuOutput: boolean;
  acceptedGpuOutput: boolean;
};

export type QualityBlendWorkerResult = {
  imageData: ImageData;
  coverage: Uint8Array<ArrayBuffer>;
  writtenTexels: number;
  backend: 'webgpu-worker' | 'cpu-worker';
  accumulateMs: number;
  resolveMs: number;
  overlayMs: number;
  totalMs: number;
  verification?: QualityBlendVerification;
};

type BlendRequest = {
  type: 'blend';
  id: number;
  resolution: number;
  preserveCoverageConfidenceAlpha: boolean;
  verify: boolean;
  forceCpuOutput: boolean;
  interactive: boolean;
  layers: Array<{ color: ArrayBuffer; quality: ArrayBuffer }>;
  overlays: Array<{ color: ArrayBuffer; quality: ArrayBuffer }>;
};

type WorkerResponse =
  | {
      type: 'result';
      id: number;
      output: ArrayBuffer;
      coverage: ArrayBuffer;
      writtenTexels: number;
      backend: 'webgpu-worker' | 'cpu-worker';
      accumulateMs: number;
      resolveMs: number;
      overlayMs: number;
      totalMs: number;
      verification?: QualityBlendVerification;
    }
  | { type: 'error'; id: number; message: string };

type PendingBlend = {
  resolution: number;
  resolve: (result: QualityBlendWorkerResult) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 1;
let stopInteractionSubscription: (() => void) | undefined;
let interactionHeartbeat: number | undefined;
const pending = new Map<number, PendingBlend>();

function isInteractionProtected() {
  return (
    isViewportInteractionBusy() ||
    (typeof document !== 'undefined' &&
      document.body.dataset.perfSimulatedViewportInteraction === '1')
  );
}

function postBudgetState() {
  worker?.postMessage({ type: 'budget', interactive: isInteractionProtected() });
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
  worker = new Worker(new URL('../../workers/qualityBlend.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    maintainInteractionHeartbeat();
    if (event.data.type === 'error') {
      request.reject(new Error(event.data.message));
      return;
    }
    if (event.data.backend === 'webgpu-worker') recordWebGpuProductionDispatch();
    markPerformanceEvent('uv-merge', 'quality-blend-worker-complete', {
      backend: event.data.backend,
      resolution: request.resolution,
      writtenTexels: event.data.writtenTexels,
      accumulateMs: event.data.accumulateMs,
      resolveMs: event.data.resolveMs,
      overlayMs: event.data.overlayMs,
      totalMs: event.data.totalMs,
      byteMismatches: event.data.verification?.byteMismatches ?? 0,
      alphaByteMismatches: event.data.verification?.alphaByteMismatches ?? 0,
      mismatchRatio: event.data.verification?.mismatchRatio ?? 0,
      maximumByteDelta: event.data.verification?.maximumByteDelta ?? 0,
      usedCpuOutput: event.data.verification?.usedCpuOutput ?? false,
      acceptedGpuOutput: event.data.verification?.acceptedGpuOutput ?? false,
      firstMismatch: event.data.verification?.firstMismatch,
    });
    if (
      typeof document !== 'undefined' &&
      new URLSearchParams(window.location.search).get('perfLab') === '1'
    ) {
      document.body.dataset.perfQualityBlend = JSON.stringify({
        backend: event.data.backend,
        resolution: request.resolution,
        writtenTexels: event.data.writtenTexels,
        accumulateMs: event.data.accumulateMs,
        resolveMs: event.data.resolveMs,
        overlayMs: event.data.overlayMs,
        totalMs: event.data.totalMs,
        byteMismatches: event.data.verification?.byteMismatches ?? 0,
        alphaByteMismatches: event.data.verification?.alphaByteMismatches ?? 0,
        mismatchRatio: event.data.verification?.mismatchRatio ?? 0,
        maximumByteDelta: event.data.verification?.maximumByteDelta ?? 0,
        usedCpuOutput: event.data.verification?.usedCpuOutput ?? false,
        acceptedGpuOutput: event.data.verification?.acceptedGpuOutput ?? false,
        firstMismatch: event.data.verification?.firstMismatch,
      });
    }
    request.resolve({
      imageData: new ImageData(
        new Uint8ClampedArray(event.data.output),
        request.resolution,
        request.resolution,
      ),
      coverage: new Uint8Array(event.data.coverage),
      writtenTexels: event.data.writtenTexels,
      backend: event.data.backend,
      accumulateMs: event.data.accumulateMs,
      resolveMs: event.data.resolveMs,
      overlayMs: event.data.overlayMs,
      totalMs: event.data.totalMs,
      verification: event.data.verification,
    });
  };
  worker.onerror = (event) => {
    failAllPending(event.message || 'Quality blend worker failed.');
    worker?.terminate();
    worker = undefined;
  };
  stopInteractionSubscription = subscribeViewportInteraction(postBudgetState);
  return worker;
}

/**
 * Transfers normal projected rasters to a persistent worker. CPU accumulation,
 * WebGPU resolve/readback and the CPU calibration pass all stay off the UI
 * thread. Each alpha mode is calibrated on its first real bake. Only an
 * alpha-exact, visually lossless GPU result is approved for later direct use;
 * rejected calibration or device failure returns the canonical CPU bytes.
 */
export function blendProjectedRastersInWorker(
  layers: QualityBlendWorkerLayer[],
  resolution: number,
  preserveCoverageConfidenceAlpha: boolean,
  overlays: QualityBlendWorkerLayer[] = [],
) {
  const id = nextRequestId++;
  const transfers: Transferable[] = [];
  const transferableBuffer = (view: Uint8ClampedArray | Float32Array) => {
    if (
      view.buffer instanceof ArrayBuffer &&
      view.byteOffset === 0 &&
      view.byteLength === view.buffer.byteLength
    ) {
      return view.buffer;
    }
    return view.slice().buffer as ArrayBuffer;
  };
  const workerLayers = layers.map((layer) => {
    const color = transferableBuffer(layer.color);
    const quality = transferableBuffer(layer.quality);
    transfers.push(color, quality);
    return { color, quality };
  });
  const workerOverlays = overlays.map((layer) => {
    const color = transferableBuffer(layer.color);
    const quality = transferableBuffer(layer.quality);
    transfers.push(color, quality);
    return { color, quality };
  });
  const request: BlendRequest = {
    type: 'blend',
    id,
    resolution,
    preserveCoverageConfidenceAlpha,
    // Every adapter is calibrated on its first real bake inside the worker.
    // The A/B flag keeps the exact reference enabled for every later bake.
    verify:
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('perfQualityGpuAb') === '1',
    forceCpuOutput:
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('perfQualityCpuGold') === '1',
    interactive: isInteractionProtected(),
    layers: workerLayers,
    overlays: workerOverlays,
  };
  return new Promise<QualityBlendWorkerResult>((resolve, reject) => {
    pending.set(id, { resolution, resolve, reject });
    maintainInteractionHeartbeat();
    getWorker().postMessage(request, transfers);
  });
}

export function terminateQualityBlendWorker() {
  failAllPending('Quality blend worker was terminated.');
  stopInteractionSubscription?.();
  stopInteractionSubscription = undefined;
  worker?.terminate();
  worker = undefined;
}
