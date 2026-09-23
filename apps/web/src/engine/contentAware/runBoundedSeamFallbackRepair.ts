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
  seamLinkCount: number;
  seamTopologyBuildTimeMs: number;
};

/** Common requests stay seam-free; only a proven residual pays for one physical-seam pass. */
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
  if (topology.seamLinkCount === 0) {
    input.onProgress?.(1);
    return { ...base, seamTopologyBuildTimeMs: topology.buildTimeMs };
  }
  const fallback = await runSurfaceAwareRepair(
    {
      width: input.width,
      height: input.height,
      rgba: initial.continuationSourceRgba,
      writeMask: initial.unresolvedMask,
      topologyMask: topology.topologyMask,
      topologyRegionIds: topology.regionIds,
      seamLinks: topology.seamLinks,
      ...input.propagation,
      maxSeamCrossings: 1,
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
    seamLinkCount: topology.seamLinkCount,
    seamTopologyBuildTimeMs: topology.buildTimeMs,
  };
}
