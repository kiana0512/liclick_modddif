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
  const repairResolution = Math.max(width, height);
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
      sourcePaddingPixels: Math.max(2, Math.min(4, Math.round(repairResolution / 768))),
      maxDistance: Math.max(64, Math.min(128, Math.round(repairResolution / 16))),
      minSourceAlpha: 64,
      sourceColorOutlierThreshold: 64,
      connectivity: 4,
      coverageSkirtPixels: 1,
      coverageSkirtMaxInputAlpha: EMPTY_PROJECTION_MAX_VISIBLE_ALPHA,
      outputBleedPixels: 4,
      // The global-average fallback introduced after the original algorithm
      // paints unrelated/unseen UV islands skin-coloured or brown. A component
      // without local/verified-seam evidence must remain untouched.
      fillUnreachableWithGlobalAverage: false,
      lockToDominantSourceRegion: true,
      dominantSourceColorThreshold: 18,
      requireCompleteComponents: false,
    },
  };
}
