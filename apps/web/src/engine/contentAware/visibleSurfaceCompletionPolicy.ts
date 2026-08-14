import type { ContentAwareRepairMaskInput } from './buildRepairMask';
import type { SurfaceAwareRepairInput } from './surfaceAwareRepair';
import { EMPTY_PROJECTION_MAX_VISIBLE_ALPHA } from '../projection/projectionCoverageContract.mjs';

type GapMaskPolicy = Pick<
  ContentAwareRepairMaskInput,
  | 'hardAlphaThreshold'
  | 'weakAlphaThreshold'
  | 'weakGrowPixels'
  | 'includeConservativeCoverage'
  | 'excludeUvIslandBoundary'
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
  | 'outputBleedAlpha'
  | 'nearestAtlasFallback'
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
      // The conservative topology halo is the outline around every UV island,
      // not missing model content. Publishing it is exactly what drew the
      // orange/brown contour network in the sparse repair layer. Restrict
      // writes to strict triangle pixel centres; hidden RGB bleed below keeps
      // linear filtering safe without making those outlines visible.
      includeConservativeCoverage: false,
      // UV rasterization naturally leaves a low-alpha one-pixel perimeter on
      // every island. It is not a renderer-detected missing surface and must
      // never be emitted as a visible contour in the repair layer.
      excludeUvIslandBoundary: true,
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
      // Keep gutter RGB for bilinear filtering without publishing stretched
      // atlas padding as visible repair content. Sparse UV textures do not use
      // mipmaps in the viewport.
      outputBleedAlpha: 0,
      // Fully blank/disconnected micro-islands still need a visible fallback.
      // Nearest-atlas cloning preserves a real texel instead of inventing colour.
      nearestAtlasFallback: true,
      lockToDominantSourceRegion: true,
      dominantSourceColorThreshold: 18,
      requireCompleteComponents: false,
    },
  };
}
