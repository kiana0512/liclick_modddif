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
  const megapixelScale = pixelCount / (1024 * 1024);
  return {
    gapMask: {
      // This is the live shader's exact hatch feather boundary. Running at the
      // selected viewport resolution avoids the former 2K/4K disagreement.
      hardAlphaThreshold: EMPTY_PROJECTION_MAX_VISIBLE_ALPHA,
      weakAlphaThreshold: 64,
      weakGrowPixels: 1,
      // Restore the original quality filter: isolated raster misses must not
      // seed a visible repair layer, while long narrow seams are retained.
      minimumComponentPixels: Math.max(4, Math.round(16 * megapixelScale)),
      minimumComponentSpan: Math.max(4, Math.round(12 * Math.sqrt(megapixelScale))),
    },
    propagation: {
      // Only one verified physical seam may provide a donor. Never cascade
      // through an arbitrary chain of UV islands.
      maxSeamCrossings: 1,
      // The mask has already rejected weak projection fringe. Padding the source
      // exclusion again removes the only valid border texel on thin UV islands
      // and turns a reachable gap into a false no-donor component.
      sourcePaddingPixels: 0,
      // The queue is linear and stops when no reachable texels remain, so a
      // pixel-count upper bound guarantees completion without adding work past
      // the actual topology diameter. A fixed 64/128px radius left the centre
      // of large visible gaps transparent.
      maxDistance: pixelCount,
      minSourceAlpha: 64,
      sourceColorOutlierThreshold: 64,
      connectivity: 4,
      coverageSkirtPixels: 1,
      coverageSkirtMaxInputAlpha: EMPTY_PROJECTION_MAX_VISIBLE_ALPHA,
      outputBleedPixels: 4,
      // Gap selection is already restricted to strict visible UV coverage. If a
      // selected component has no local/seam donor, use the authored-source mean
      // as a final opaque fallback so the viewport never exposes hatch/alpha.
      // Empty atlas space remains outside writeMask and is never painted.
      fillUnreachableWithGlobalAverage: true,
      lockToDominantSourceRegion: true,
      dominantSourceColorThreshold: 18,
      requireCompleteComponents: false,
    },
  };
}
