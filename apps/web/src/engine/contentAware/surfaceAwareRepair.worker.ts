import {
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
  requireCompleteComponents?: boolean;
  dominantSourceColorThreshold?: number;
  lockToDominantSourceRegion?: boolean;
}

export type SurfaceRepairWorkerResponse =
  | { kind: 'progress'; progress: SurfaceRepairProgress }
  | {
      kind: 'result';
      filledRgba: ArrayBuffer;
      repairedMask: ArrayBuffer;
      sourceExclusionMask: ArrayBuffer;
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
      requireCompleteComponents: request.requireCompleteComponents,
      dominantSourceColorThreshold: request.dominantSourceColorThreshold,
      lockToDominantSourceRegion: request.lockToDominantSourceRegion,
    };
    const result = repairSurfaceTexture(input, {
      onProgress: (progress) => workerScope.postMessage({ kind: 'progress', progress }),
    });
    // The core always allocates these arrays locally, so their backing stores are
    // transferable ArrayBuffers (never caller-supplied SharedArrayBuffers).
    const filledRgba = result.filledRgba.buffer as ArrayBuffer;
    const repairedMask = result.repairedMask.buffer as ArrayBuffer;
    const sourceExclusionMask = result.sourceExclusionMask.buffer as ArrayBuffer;
    workerScope.postMessage(
      {
        kind: 'result',
        filledRgba,
        repairedMask,
        sourceExclusionMask,
        stats: result.stats,
      },
      [filledRgba, repairedMask, sourceExclusionMask],
    );
  } catch (error) {
    workerScope.postMessage({
      kind: 'error',
      error: error instanceof Error ? error.message : 'Surface-aware repair failed.',
    });
  }
};
