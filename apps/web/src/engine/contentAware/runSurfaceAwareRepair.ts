import {
  repairSurfaceTexture,
  type SurfaceAwareRepairInput,
  type SurfaceAwareRepairResult,
  type SurfaceRepairProgress,
  type SurfaceRepairRegionArray,
} from './surfaceAwareRepair';
import type {
  SurfaceRepairWorkerRequest,
  SurfaceRepairWorkerResponse,
} from './surfaceAwareRepair.worker';

export interface RunSurfaceAwareRepairOptions {
  signal?: AbortSignal;
  onProgress?: (progress: SurfaceRepairProgress) => void;
  /** Intended for tests and legacy environments. Worker execution is the default. */
  useWorker?: boolean;
  /**
   * Detach short-lived caller buffers instead of cloning them before the Worker
   * transfer. Cached topology arrays are always copied and never detached.
   */
  transferOwnership?: {
    rgba?: boolean;
    writeMask?: boolean;
  };
}

function createAbortError() {
  return new DOMException('Surface-aware repair was cancelled.', 'AbortError');
}

function copyRegionIds(regionIds: SurfaceRepairRegionArray | undefined) {
  if (!regionIds) return undefined;
  return regionIds instanceof Int32Array ? new Int32Array(regionIds) : new Uint32Array(regionIds);
}

function canTransferWholeView(value: ArrayBufferView) {
  return (
    value.buffer instanceof ArrayBuffer &&
    value.byteOffset === 0 &&
    value.byteLength === value.buffer.byteLength
  );
}

/** Cached topology inputs are copied; explicitly disposable image inputs may transfer directly. */
function copyInput(
  input: SurfaceAwareRepairInput,
  options: RunSurfaceAwareRepairOptions,
): SurfaceAwareRepairInput {
  const transferRgba = options.transferOwnership?.rgba && canTransferWholeView(input.rgba);
  const transferWriteMask =
    options.transferOwnership?.writeMask && canTransferWholeView(input.writeMask);
  return {
    ...input,
    rgba: transferRgba ? input.rgba : new Uint8ClampedArray(input.rgba),
    writeMask: transferWriteMask ? input.writeMask : new Uint8Array(input.writeMask),
    topologyMask: new Uint8Array(input.topologyMask),
    ...(input.sourceExclusionMask
      ? { sourceExclusionMask: new Uint8Array(input.sourceExclusionMask) }
      : { sourceExclusionMask: undefined }),
    ...(input.seamLinks
      ? { seamLinks: new Uint32Array(input.seamLinks) }
      : { seamLinks: undefined }),
    topologyRegionIds: copyRegionIds(input.topologyRegionIds),
  };
}

function runOnMainThread(
  copiedInput: SurfaceAwareRepairInput,
  options: RunSurfaceAwareRepairOptions,
) {
  return Promise.resolve().then(() =>
    repairSurfaceTexture(copiedInput, {
      signal: options.signal,
      onProgress: options.onProgress,
    }),
  );
}

/**
 * Runs surface-aware repair off the editor thread. Inputs remain attached by
 * default; callers may opt short-lived RGBA/write buffers into zero-copy transfer.
 */
export function runSurfaceAwareRepair(
  input: SurfaceAwareRepairInput,
  options: RunSurfaceAwareRepairOptions = {},
): Promise<SurfaceAwareRepairResult> {
  if (options.signal?.aborted) return Promise.reject(createAbortError());
  const copiedInput = copyInput(input, options);
  if (options.useWorker === false || typeof Worker === 'undefined') {
    return runOnMainThread(copiedInput, options);
  }

  return new Promise<SurfaceAwareRepairResult>((resolve, reject) => {
    const worker = new Worker(new URL('./surfaceAwareRepair.worker.ts', import.meta.url), {
      type: 'module',
    });
    let settled = false;
    const cleanup = () => {
      options.signal?.removeEventListener('abort', abort);
      worker.terminate();
    };
    const finish = (
      callback: (value: SurfaceAwareRepairResult) => void,
      value: SurfaceAwareRepairResult,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const abort = () => fail(createAbortError());

    worker.onmessage = (event: MessageEvent<SurfaceRepairWorkerResponse>) => {
      const response = event.data;
      if (response.kind === 'progress') {
        options.onProgress?.(response.progress);
        return;
      }
      if (response.kind === 'error') {
        fail(new Error(response.error));
        return;
      }
      finish(resolve, {
        filledRgba: new Uint8ClampedArray(response.filledRgba),
        repairedMask: new Uint8Array(response.repairedMask),
        sourceExclusionMask: new Uint8Array(response.sourceExclusionMask),
        stats: response.stats,
      });
    };
    worker.onerror = (event) => {
      fail(new Error(event.message || 'Surface-aware repair worker failed.'));
    };
    options.signal?.addEventListener('abort', abort, { once: true });

    const rgba = copiedInput.rgba as Uint8ClampedArray;
    const writeMask = copiedInput.writeMask as Uint8Array;
    const topologyMask = copiedInput.topologyMask as Uint8Array;
    const sourceExclusionMask = copiedInput.sourceExclusionMask as Uint8Array | undefined;
    const seamLinks = copiedInput.seamLinks;
    const topologyRegionIds = copiedInput.topologyRegionIds;
    const rgbaBuffer = rgba.buffer as ArrayBuffer;
    const writeMaskBuffer = writeMask.buffer as ArrayBuffer;
    const topologyMaskBuffer = topologyMask.buffer as ArrayBuffer;
    const sourceExclusionBuffer = sourceExclusionMask?.buffer as ArrayBuffer | undefined;
    const seamLinksBuffer = seamLinks?.buffer as ArrayBuffer | undefined;
    const topologyRegionBuffer = topologyRegionIds?.buffer as ArrayBuffer | undefined;
    const request: SurfaceRepairWorkerRequest = {
      width: copiedInput.width,
      height: copiedInput.height,
      rgba: rgbaBuffer,
      writeMask: writeMaskBuffer,
      topologyMask: topologyMaskBuffer,
      ...(sourceExclusionBuffer ? { sourceExclusionMask: sourceExclusionBuffer } : {}),
      ...(seamLinksBuffer ? { seamLinks: seamLinksBuffer } : {}),
      ...(topologyRegionIds && topologyRegionBuffer
        ? {
            topologyRegionIds: topologyRegionBuffer,
            topologyRegionType: topologyRegionIds instanceof Int32Array ? 'int32' : 'uint32',
          }
        : {}),
      sourcePaddingPixels: copiedInput.sourcePaddingPixels,
      maxDistance: copiedInput.maxDistance,
      minSourceAlpha: copiedInput.minSourceAlpha,
      connectivity: copiedInput.connectivity,
      outputBleedPixels: copiedInput.outputBleedPixels,
      requireCompleteComponents: copiedInput.requireCompleteComponents,
      lockToDominantSourceRegion: copiedInput.lockToDominantSourceRegion,
    };
    const transfer: Transferable[] = [rgbaBuffer, writeMaskBuffer, topologyMaskBuffer];
    if (sourceExclusionBuffer) transfer.push(sourceExclusionBuffer);
    if (seamLinksBuffer) transfer.push(seamLinksBuffer);
    if (topologyRegionBuffer) transfer.push(topologyRegionBuffer);
    try {
      worker.postMessage(request, transfer);
    } catch (error) {
      fail(error);
    }
  });
}
