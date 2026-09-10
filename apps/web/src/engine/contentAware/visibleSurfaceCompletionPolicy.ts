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
  | 'localBoundaryBlend'
>;

export type VisibleSurfaceCompletionPolicy = {
  gapMask: GapMaskPolicy;
  propagation: SurfacePropagationPolicy;
};

/**
 * Selects low-confidence texels inside the model's UV sampling footprint,
 * repairing only those with reliable nearby same-region color evidence.
 * Empty atlas space outside that footprint is never selected.
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
      // Do not borrow a material from another island (e.g. outer skin into
      // an untextured mouth). Each side of a UV seam uses its own local border.
      maxSeamCrossings: 0,
      // The mask has already rejected weak projection fringe. Padding the source
      // exclusion again removes the only valid border texel on thin UV islands
      // and turns a reachable gap into a false no-donor component.
      sourcePaddingPixels: 0,
      // 16 texels at 2K, scaled with output size. Wide/no-evidence gaps stay
      // open instead of being filled from a distant part of the model.
      maxDistance: Math.max(4, Math.ceil(Math.max(width, height) / 128)),
      minSourceAlpha: 224,
      sourceColorOutlierThreshold: 64,
      connectivity: 4,
      coverageSkirtPixels: 1,
      coverageSkirtMaxInputAlpha: EMPTY_PROJECTION_MAX_VISIBLE_ALPHA,
      outputBleedPixels: 4,
      fillUnreachableWithGlobalAverage: false,
      lockToDominantSourceRegion: false,
      dominantSourceColorThreshold: 18,
      requireCompleteComponents: false,
      localBoundaryBlend: true,
    },
  };
}
