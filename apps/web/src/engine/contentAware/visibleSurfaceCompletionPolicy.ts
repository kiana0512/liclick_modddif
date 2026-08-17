import type { ContentAwareRepairMaskInput } from './buildRepairMask';
import type { SurfaceAwareRepairInput } from './surfaceAwareRepair';
import { EMPTY_PROJECTION_MAX_VISIBLE_ALPHA } from '../projection/projectionCoverageContract.mjs';

type GapMaskPolicy = Pick<
  ContentAwareRepairMaskInput,
  | 'hardAlphaThreshold'
  | 'weakAlphaThreshold'
  | 'weakGrowPixels'
  | 'minimumComponentPixels'
  | 'minimumComponentSpan'
>;

type SurfacePropagationPolicy = Pick<
  SurfaceAwareRepairInput,
  | 'maxSeamCrossings'
  | 'sourcePaddingPixels'
  | 'maxDistance'
  | 'minSourceAlpha'
  | 'sourceColorOutlierThreshold'
  | 'connectivity'
  | 'coverageSkirtPixels'
  | 'coverageSkirtMaxInputAlpha'
  | 'outputBleedPixels'
  | 'fillUnreachableWithGlobalAverage'
  | 'lockToDominantSourceRegion'
  | 'dominantSourceColorThreshold'
  | 'requireCompleteComponents'
>;

export type VisibleSurfaceCompletionPolicy = {
  gapMask: GapMaskPolicy;
  propagation: SurfacePropagationPolicy;
};

/**
 * Completes every reachable low-confidence texel in the model's strict UV
 * coverage plus the conservative half-pixel texture-sampling footprint. Empty
 * atlas space outside that bounded footprint is never selected.
 */
export function createVisibleSurfaceCompletionPolicy(
  width: number,
  height = width,
): VisibleSurfaceCompletionPolicy {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError(`Invalid visible-surface completion size: ${width}x${height}.`);
  }
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > 0xffffffff) {
    throw new RangeError(`Visible-surface completion is too large: ${width}x${height}.`);
  }
  return {
    gapMask: {
      // This is the live shader's exact hatch feather boundary. Running at the
      // selected viewport resolution avoids the former 2K/4K disagreement.
      hardAlphaThreshold: EMPTY_PROJECTION_MAX_VISIBLE_ALPHA,
      weakAlphaThreshold: 64,
      weakGrowPixels: 1,
      // A one-texel miss can still be a visible crack on a thin rail or inside
      // a mechanical recess. `coreMask` is the noise boundary, not component size.
      minimumComponentPixels: 1,
      minimumComponentSpan: 0,
    },
    propagation: {
      // 255 is the repair core's unlimited physical-seam mode. Seam links are
      // already restricted to the same surface component and compatible normals.
      maxSeamCrossings: 255,
      // Alpha already separates sources (>=64) from shader-visible gaps. Keeping the
      // adjacent donor is essential for one-texel rails and conservative edges.
      sourcePaddingPixels: 0,
      // The queue visits every topology texel at most once. Pixel count is a
      // safe upper bound that removes the old one-click 64..128 px cutoff.
      maxDistance: pixelCount,
      minSourceAlpha: 64,
      sourceColorOutlierThreshold: 64,
      connectivity: 4,
      // Publish exactly the detected gap. A visible one-pixel skirt becomes an
      // orange/brown outline when the sparse repair layer is inspected alone.
      coverageSkirtPixels: 0,
      coverageSkirtMaxInputAlpha: EMPTY_PROJECTION_MAX_VISIBLE_ALPHA,
      outputBleedPixels: 4,
      // A completely unprojected component has no topology-local donor. The
      // product contract prefers an approximate authored colour over exposing
      // the diagnostic black hatch, so finish it with a worker-side fallback.
      fillUnreachableWithGlobalAverage: true,
      lockToDominantSourceRegion: true,
      dominantSourceColorThreshold: 18,
      requireCompleteComponents: false,
    },
  };
}
