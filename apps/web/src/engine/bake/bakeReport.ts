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
    coverageRatio: input.coverageRatio,
    warnings: input.warnings,
  };
}
