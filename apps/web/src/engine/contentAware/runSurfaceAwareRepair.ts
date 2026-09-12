import type {
  SurfaceAwareRepairInput,
  SurfaceAwareRepairResult,
  SurfaceRepairProgress,
  SurfaceRepairRegionArray,
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

function copyRegionIds(regionIds: SurfaceRepairRegionArray | undefined, preserveWholeView = false) {
  if (!regionIds) return undefined;
  if (preserveWholeView && canTransferWholeView(regionIds)) return regionIds;
  return regionIds instanceof Int32Array ? new Int32Array(regionIds) : new Uint32Array(regionIds);
}

function canTransferWholeView(value: ArrayBufferView) {
  return (
    value.buffer instanceof ArrayBuffer &&
    value.byteOffset === 0 &&
    value.byteLength === value.buffer.byteLength
  );
}

/** Main-thread fallback copies all inputs; Worker topology copies are owned by structured clone. */
function copyInput(
  input: SurfaceAwareRepairInput,
  options: RunSurfaceAwareRepairOptions,
  preserveWholeReadOnlyViews = false,
): SurfaceAwareRepairInput {
  const transferRgba = options.transferOwnership?.rgba && canTransferWholeView(input.rgba);
  const transferWriteMask =
    options.transferOwnership?.writeMask && canTransferWholeView(input.writeMask);
  return {
    ...input,
    rgba: transferRgba ? input.rgba : new Uint8ClampedArray(input.rgba),
    writeMask: transferWriteMask ? input.writeMask : new Uint8Array(input.writeMask),
    topologyMask:
      preserveWholeReadOnlyViews && canTransferWholeView(input.topologyMask)
        ? input.topologyMask
        : new Uint8Array(input.topologyMask),
    ...(input.sourceExclusionMask
      ? {
          sourceExclusionMask:
            preserveWholeReadOnlyViews && canTransferWholeView(input.sourceExclusionMask)
              ? input.sourceExclusionMask
              : new Uint8Array(input.sourceExclusionMask),
        }
      : { sourceExclusionMask: undefined }),
    ...(input.seamLinks
      ? {
          seamLinks:
            preserveWholeReadOnlyViews && canTransferWholeView(input.seamLinks)
              ? input.seamLinks
              : new Uint32Array(input.seamLinks),
        }
      : { seamLinks: undefined }),
    topologyRegionIds: copyRegionIds(input.topologyRegionIds, preserveWholeReadOnlyViews),
  };
}

async function runOnMainThread(
  copiedInput: SurfaceAwareRepairInput,
  options: RunSurfaceAwareRepairOptions,
) {
  // Normal editor execution uses the Worker; load the identical compatibility
  // kernel only when needed instead of adding it to the editor's initial route.
  const { repairSurfaceTexture } = await import('./surfaceAwareRepair');
  return repairSurfaceTexture(copiedInput, {
    signal: options.signal,
    onProgress: options.onProgress,
  });
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
  if (options.useWorker === false || typeof Worker === 'undefined') {
    return runOnMainThread(copyInput(input, options), options);
  }
  // The browser's structured clone owns the immutable topology copy. Avoid
  // duplicating those 4K arrays once in JS before postMessage copies them again.
  const copiedInput = copyInput(input, options, true);

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
      maxSeamCrossings: copiedInput.maxSeamCrossings,
      sourcePaddingPixels: copiedInput.sourcePaddingPixels,
      maxDistance: copiedInput.maxDistance,
      minSourceAlpha: copiedInput.minSourceAlpha,
      sourceColorOutlierThreshold: copiedInput.sourceColorOutlierThreshold,
      connectivity: copiedInput.connectivity,
      coverageSkirtPixels: copiedInput.coverageSkirtPixels,
      coverageSkirtMaxInputAlpha: copiedInput.coverageSkirtMaxInputAlpha,
      outputBleedPixels: copiedInput.outputBleedPixels,
      fillUnreachableWithGlobalAverage: copiedInput.fillUnreachableWithGlobalAverage,
      requireCompleteComponents: copiedInput.requireCompleteComponents,
      dominantSourceColorThreshold: copiedInput.dominantSourceColorThreshold,
      lockToDominantSourceRegion: copiedInput.lockToDominantSourceRegion,
      localBoundaryBlend: copiedInput.localBoundaryBlend,
      adaptiveGapDistance: copiedInput.adaptiveGapDistance,
    };
    // RGBA/writeMask are disposable copies (or explicitly transferred caller
    // buffers). Keep cached topology sources attached and let structured clone
    // create the Worker's immutable copies.
    const transfer: Transferable[] = [rgbaBuffer, writeMaskBuffer];
    try {
      worker.postMessage(request, transfer);
    } catch (error) {
      fail(error);
    }
  });
}
