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

type CopyableRepairArray = Uint8Array | Uint8ClampedArray | Uint32Array | Int32Array;

const COOPERATIVE_COPY_CHUNK_BYTES = 1024 * 1024;

function yieldToViewportFrame() {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return new Promise<void>((resolve) =>
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0)),
  );
}

async function copyArrayCooperatively<T extends CopyableRepairArray>(
  source: T,
  create: (length: number) => T,
  signal?: AbortSignal,
) {
  const output = create(source.length);
  const chunkElements = Math.max(
    1,
    Math.floor(COOPERATIVE_COPY_CHUNK_BYTES / source.BYTES_PER_ELEMENT),
  );
  const setOutput = output.set.bind(output) as (
    array: ArrayLike<number>,
    offset?: number,
  ) => void;
  for (let offset = 0; offset < source.length; offset += chunkElements) {
    if (signal?.aborted) throw createAbortError();
    const end = Math.min(source.length, offset + chunkElements);
    setOutput(source.subarray(offset, end), offset);
    if (end < source.length) {
      // Topology buffers can exceed 20 MB at 2K. Copy them in bounded slices
      // so preparing a Worker request never turns into one visible long frame.
      await yieldToViewportFrame();
    }
  }
  return output;
}

/**
 * Copies a large RGBA surface without monopolising one display frame. Content
 * repair uses this for its immutable projection-bake cache before compositing
 * prior sparse repair layers into a working buffer.
 */
export async function copyRepairRgbaCooperatively(
  source: Uint8ClampedArray<ArrayBufferLike>,
  signal?: AbortSignal,
): Promise<Uint8ClampedArray<ArrayBuffer>> {
  return (await copyArrayCooperatively(
    source,
    (length) => new Uint8ClampedArray(length),
    signal,
  )) as Uint8ClampedArray<ArrayBuffer>;
}

async function copyRegionIds(
  regionIds: SurfaceRepairRegionArray | undefined,
  signal?: AbortSignal,
) {
  if (!regionIds) return undefined;
  return regionIds instanceof Int32Array
    ? copyArrayCooperatively(regionIds, (length) => new Int32Array(length), signal)
    : copyArrayCooperatively(regionIds, (length) => new Uint32Array(length), signal);
}

function canTransferWholeView(value: ArrayBufferView) {
  return (
    value.buffer instanceof ArrayBuffer &&
    value.byteOffset === 0 &&
    value.byteLength === value.buffer.byteLength
  );
}

/** Cached topology inputs are copied; explicitly disposable image inputs may transfer directly. */
async function copyInput(
  input: SurfaceAwareRepairInput,
  options: RunSurfaceAwareRepairOptions,
) : Promise<SurfaceAwareRepairInput> {
  const transferRgba = options.transferOwnership?.rgba && canTransferWholeView(input.rgba);
  const transferWriteMask =
    options.transferOwnership?.writeMask && canTransferWholeView(input.writeMask);
  return {
    ...input,
    rgba: transferRgba
      ? input.rgba
      : await copyArrayCooperatively(
          input.rgba instanceof Uint8ClampedArray
            ? input.rgba
            : new Uint8ClampedArray(
                input.rgba.buffer,
                input.rgba.byteOffset,
                input.rgba.byteLength,
              ),
          (length) => new Uint8ClampedArray(length),
          options.signal,
        ),
    writeMask: transferWriteMask
      ? input.writeMask
      : await copyArrayCooperatively(
          input.writeMask instanceof Uint8Array
            ? input.writeMask
            : new Uint8Array(
                input.writeMask.buffer,
                input.writeMask.byteOffset,
                input.writeMask.byteLength,
              ),
          (length) => new Uint8Array(length),
          options.signal,
        ),
    topologyMask: await copyArrayCooperatively(
      input.topologyMask instanceof Uint8Array
        ? input.topologyMask
        : new Uint8Array(
            input.topologyMask.buffer,
            input.topologyMask.byteOffset,
            input.topologyMask.byteLength,
          ),
      (length) => new Uint8Array(length),
      options.signal,
    ),
    ...(input.sourceExclusionMask
      ? {
          sourceExclusionMask: await copyArrayCooperatively(
            input.sourceExclusionMask instanceof Uint8Array
              ? input.sourceExclusionMask
              : new Uint8Array(
                  input.sourceExclusionMask.buffer,
                  input.sourceExclusionMask.byteOffset,
                  input.sourceExclusionMask.byteLength,
                ),
            (length) => new Uint8Array(length),
            options.signal,
          ),
        }
      : { sourceExclusionMask: undefined }),
    ...(input.seamLinks
      ? {
          seamLinks: await copyArrayCooperatively(
            input.seamLinks,
            (length) => new Uint32Array(length),
            options.signal,
          ),
        }
      : { seamLinks: undefined }),
    topologyRegionIds: await copyRegionIds(input.topologyRegionIds, options.signal),
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
export async function runSurfaceAwareRepair(
  input: SurfaceAwareRepairInput,
  options: RunSurfaceAwareRepairOptions = {},
): Promise<SurfaceAwareRepairResult> {
  if (options.signal?.aborted) return Promise.reject(createAbortError());
  const copiedInput = await copyInput(input, options);
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
      maxSeamCrossings: copiedInput.maxSeamCrossings,
      sourcePaddingPixels: copiedInput.sourcePaddingPixels,
      maxDistance: copiedInput.maxDistance,
      minSourceAlpha: copiedInput.minSourceAlpha,
      sourceColorOutlierThreshold: copiedInput.sourceColorOutlierThreshold,
      connectivity: copiedInput.connectivity,
      coverageSkirtPixels: copiedInput.coverageSkirtPixels,
      coverageSkirtMaxInputAlpha: copiedInput.coverageSkirtMaxInputAlpha,
      outputBleedPixels: copiedInput.outputBleedPixels,
      requireCompleteComponents: copiedInput.requireCompleteComponents,
      dominantSourceColorThreshold: copiedInput.dominantSourceColorThreshold,
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
