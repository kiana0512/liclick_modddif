import type { BakeReport } from './uvBakeTypes';

export function createBakeReport(input: Omit<BakeReport, 'id' | 'durationMs'> & { startedAt: number }): BakeReport {
  return {
    id: crypto.randomUUID(),
    durationMs: Math.max(0, Math.round(performance.now() - input.startedAt)),
    objectId: input.objectId,
    layerId: input.layerId,
    width: input.width,
    height: input.height,
    totalTriangles: input.totalTriangles,
    processedTriangles: input.processedTriangles,
    coveredPixels: input.coveredPixels,
    skippedPixels: input.skippedPixels,
    totalTexels: input.totalTexels,
    inFrustumTexels: input.inFrustumTexels,
    maskRejectedTexels: input.maskRejectedTexels,
    depthRejectedTexels: input.depthRejectedTexels,
    backfaceRejectedTexels: input.backfaceRejectedTexels,
    writtenTexels: input.writtenTexels,
    coverageRatio: input.coverageRatio,
    warnings: [
      ...input.warnings,
      ...(input.coverageRatio > 0.92
        ? ['Projection coverage is unusually high. Please check camera/mask/depth settings.']
        : []),
      ...(input.coverageRatio < 0.002
        ? ['Low projection coverage. Try capturing from a closer view.']
        : []),
    ],
  };
}
