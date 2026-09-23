import {
  checksumSurfaceRepairRgba,
  mergeSparseSurfaceRepairRgba,
  prepareSurfaceRepairContinuation,
  repairSurfaceTexture,
  type SurfaceAwareRepairInput,
  type SurfaceRepairConnectivity,
  type SurfaceRepairProgress,
  type SurfaceRepairStats,
} from './surfaceAwareRepair';

export interface SurfaceRepairWorkerRequest {
  width: number;
  height: number;
  rgba: ArrayBuffer;
  writeMask: ArrayBuffer;
  sourceExclusionMask?: ArrayBuffer;
  topologyMask: ArrayBuffer;
  seamLinks?: ArrayBuffer;
  topologyRegionIds?: ArrayBuffer;
  topologyRegionType?: 'int32' | 'uint32';
  maxSeamCrossings?: number;
  sourcePaddingPixels?: number;
  maxDistance?: number;
  minSourceAlpha?: number;
  sourceColorOutlierThreshold?: number;
  connectivity?: SurfaceRepairConnectivity;
  coverageSkirtPixels?: number;
  coverageSkirtMaxInputAlpha?: number;
  outputBleedPixels?: number;
  fillUnreachableWithGlobalAverage?: boolean;
  requireCompleteComponents?: boolean;
  dominantSourceColorThreshold?: number;
  lockToDominantSourceRegion?: boolean;
  localBoundaryBlend?: boolean;
  adaptiveGapDistance?: boolean;
  includeDiagnostics?: boolean;
  returnUnresolvedInput?: boolean;
  accumulatedFilledRgba?: ArrayBuffer;
}

export type SurfaceRepairWorkerResponse =
  | { kind: 'progress'; progress: SurfaceRepairProgress }
  | {
      kind: 'result';
      filledRgba: ArrayBuffer;
      repairedMask?: ArrayBuffer;
      sourceExclusionMask?: ArrayBuffer;
      continuationSourceRgba?: ArrayBuffer;
      unresolvedMask?: ArrayBuffer;
      stats: SurfaceRepairStats;
    }
  | { kind: 'error'; error: string };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<SurfaceRepairWorkerRequest>) => void) | null;
  postMessage(message: SurfaceRepairWorkerResponse, transfer?: Transferable[]): void;
};

workerScope.onmessage = (event) => {
  try {
    const request = event.data;
    const input: SurfaceAwareRepairInput = {
      width: request.width,
      height: request.height,
      rgba: new Uint8ClampedArray(request.rgba),
      writeMask: new Uint8Array(request.writeMask),
      topologyMask: new Uint8Array(request.topologyMask),
      ...(request.sourceExclusionMask
        ? { sourceExclusionMask: new Uint8Array(request.sourceExclusionMask) }
        : {}),
      ...(request.seamLinks ? { seamLinks: new Uint32Array(request.seamLinks) } : {}),
      ...(request.topologyRegionIds
        ? {
            topologyRegionIds:
              request.topologyRegionType === 'int32'
                ? new Int32Array(request.topologyRegionIds)
                : new Uint32Array(request.topologyRegionIds),
          }
        : {}),
      maxSeamCrossings: request.maxSeamCrossings,
      sourcePaddingPixels: request.sourcePaddingPixels,
      maxDistance: request.maxDistance,
      minSourceAlpha: request.minSourceAlpha,
      sourceColorOutlierThreshold: request.sourceColorOutlierThreshold,
      connectivity: request.connectivity,
      coverageSkirtPixels: request.coverageSkirtPixels,
      coverageSkirtMaxInputAlpha: request.coverageSkirtMaxInputAlpha,
      outputBleedPixels: request.outputBleedPixels,
      fillUnreachableWithGlobalAverage: request.fillUnreachableWithGlobalAverage,
      requireCompleteComponents: request.requireCompleteComponents,
      dominantSourceColorThreshold: request.dominantSourceColorThreshold,
      lockToDominantSourceRegion: request.lockToDominantSourceRegion,
      localBoundaryBlend: request.localBoundaryBlend,
      adaptiveGapDistance: request.adaptiveGapDistance,
    };
    const result = repairSurfaceTexture(input, {
      onProgress: (progress) => workerScope.postMessage({ kind: 'progress', progress }),
    });
    const continuation = request.returnUnresolvedInput
      ? prepareSurfaceRepairContinuation(
          input.rgba as Uint8ClampedArray<ArrayBuffer>,
          input.writeMask as Uint8Array<ArrayBuffer>,
          result,
        )
      : undefined;
    const publishedRgba = request.accumulatedFilledRgba
      ? mergeSparseSurfaceRepairRgba(
          new Uint8ClampedArray(request.accumulatedFilledRgba),
          result.filledRgba,
        )
      : result.filledRgba;
    const publishedStats =
      publishedRgba === result.filledRgba
        ? result.stats
        : { ...result.stats, outputChecksum: checksumSurfaceRepairRgba(publishedRgba) };
    // The core always allocates these arrays locally, so their backing stores are
    // transferable ArrayBuffers (never caller-supplied SharedArrayBuffers).
    const filledRgba = publishedRgba.buffer as ArrayBuffer;
    const repairedMask = result.repairedMask.buffer as ArrayBuffer;
    const sourceExclusionMask = result.sourceExclusionMask.buffer as ArrayBuffer;
    const continuationSourceRgba = continuation?.sourceRgba.buffer;
    const unresolvedMask = continuation?.unresolvedMask.buffer;
    const continuationTransfer = continuation
      ? [continuationSourceRgba!, unresolvedMask!]
      : [];
    if (request.includeDiagnostics === false) {
      workerScope.postMessage(
        {
          kind: 'result',
          filledRgba,
          ...(continuationSourceRgba && unresolvedMask
            ? { continuationSourceRgba, unresolvedMask }
            : {}),
          stats: publishedStats,
        },
        [filledRgba, ...continuationTransfer],
      );
    } else {
      workerScope.postMessage(
        {
          kind: 'result',
          filledRgba,
          repairedMask,
          sourceExclusionMask,
          ...(continuationSourceRgba && unresolvedMask
            ? { continuationSourceRgba, unresolvedMask }
            : {}),
          stats: publishedStats,
        },
        [filledRgba, repairedMask, sourceExclusionMask, ...continuationTransfer],
      );
    }
  } catch (error) {
    workerScope.postMessage({
      kind: 'error',
      error: error instanceof Error ? error.message : 'Surface-aware repair failed.',
    });
  }
};
