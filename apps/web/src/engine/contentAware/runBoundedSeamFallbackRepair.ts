import type * as THREE from 'three';
import {
  buildContentAwareSurfaceTopology,
  type ContentAwareSurfaceTopology,
} from './buildSurfaceTopology';
import { runSurfaceAwareRepair } from './runSurfaceAwareRepair';
import type { SurfaceRepairStats } from './surfaceAwareRepair';
import type { VisibleSurfaceCompletionPolicy } from './visibleSurfaceCompletionPolicy';

export type VisibleSurfaceRepairResult = {
  filledRgba: Uint8ClampedArray<ArrayBuffer>;
  repairedPixels: number;
  unresolvedPixels: number;
  outputChecksum: number;
  initialStats: SurfaceRepairStats;
  fallbackStats?: SurfaceRepairStats;
  globalFallbackPixels: number;
  seamLinkCount: number;
  seamTopologyBuildTimeMs: number;
};

/** Common requests stay seam-free; residuals get one bounded seam and coverage pass. */
export async function runVisibleSurfaceRepairWithFallback(input: {
  root: THREE.Object3D;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  writeMask: Uint8Array;
  topology: ContentAwareSurfaceTopology;
  propagation: VisibleSurfaceCompletionPolicy['propagation'];
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}): Promise<VisibleSurfaceRepairResult> {
  const initial = await runSurfaceAwareRepair(
    {
      width: input.width,
      height: input.height,
      rgba: input.rgba,
      writeMask: input.writeMask,
      topologyMask: input.topology.topologyMask,
      topologyRegionIds: input.topology.regionIds,
      ...input.propagation,
    },
    {
      signal: input.signal,
      transferOwnership: { rgba: true, writeMask: true },
      includeDiagnostics: false,
      returnUnresolvedInput: true,
      onProgress: (progress) => input.onProgress?.(progress.progress * 0.8),
    },
  );
  const base = {
    filledRgba: initial.filledRgba,
    repairedPixels: initial.stats.repairedPixels,
    unresolvedPixels: initial.stats.unresolvedPixels,
    outputChecksum: initial.stats.outputChecksum,
    initialStats: initial.stats,
    globalFallbackPixels: 0,
    seamLinkCount: 0,
    seamTopologyBuildTimeMs: 0,
  };
  if (initial.stats.unresolvedPixels === 0) {
    input.onProgress?.(1);
    return base;
  }
  if (!initial.continuationSourceRgba || !initial.unresolvedMask) {
    throw new Error('Surface repair omitted unresolved continuation buffers.');
  }
  const topology = await buildContentAwareSurfaceTopology(input.root, input.width, input.height, {
    includeInvisible: false,
    includeSeamLinks: true,
    yieldIntervalMs: 4,
    signal: input.signal,
    onProgress: (progress) =>
      input.onProgress?.(0.8 + 0.1 * (progress.total ? progress.completed / progress.total : 1)),
  });
  const fallback = await runSurfaceAwareRepair(
    {
      width: input.width,
      height: input.height,
      rgba: initial.continuationSourceRgba,
      writeMask: initial.unresolvedMask,
      topologyMask: topology.topologyMask,
      topologyRegionIds: topology.regionIds,
      ...(topology.seamLinkCount > 0 ? { seamLinks: topology.seamLinks } : {}),
      ...input.propagation,
      maxSeamCrossings: topology.seamLinkCount > 0 ? 1 : 0,
      // Only the residual reaches this pass. Prefer same-region local colour,
      // then one physical seam hop; a fully blank island finally receives an
      // opaque authored-colour fallback instead of remaining a visible hole.
      fillUnreachableWithGlobalAverage: true,
    },
    {
      signal: input.signal,
      transferOwnership: { rgba: true, writeMask: true },
      includeDiagnostics: false,
      accumulatedFilledRgba: initial.filledRgba,
      onProgress: (progress) => input.onProgress?.(0.9 + progress.progress * 0.1),
    },
  );
  return {
    filledRgba: fallback.filledRgba,
    repairedPixels: initial.stats.repairedPixels + fallback.stats.repairedPixels,
    unresolvedPixels: fallback.stats.unresolvedPixels,
    outputChecksum: fallback.stats.outputChecksum,
    initialStats: initial.stats,
    fallbackStats: fallback.stats,
    globalFallbackPixels: fallback.stats.globalFallbackPixels,
    seamLinkCount: topology.seamLinkCount,
    seamTopologyBuildTimeMs: topology.buildTimeMs,
  };
}
