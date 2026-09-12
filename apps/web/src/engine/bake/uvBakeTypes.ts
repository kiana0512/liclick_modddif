import type { Layer } from '@/types/layer';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import type { ProjectedUvRasterCache } from './ProjectedUvRasterCache';

export type UvBakeResolution = 512 | 1024 | 2048 | 4096 | 8192;
export type GpuUvCompositeMode =
  | 'cpu-parity'
  | 'quality-depth'
  | 'quality-alpha'
  | 'coverage-alpha';
export type BakeProgressPhase =
  | 'loading-assets'
  | 'rasterizing'
  | 'compositing'
  | 'encoding'
  | 'applying'
  | 'persisting';

export interface BakeProgress {
  phase: BakeProgressPhase;
  progress: number;
  layerName?: string;
  layerIndex?: number;
  layerCount?: number;
  processedTriangles?: number;
  totalTriangles?: number;
}

export interface BakeReport {
  id: string;
  objectId: string;
  layerId: string;
  width: number;
  height: number;
  totalTriangles: number;
  processedTriangles: number;
  coveredPixels: number;
  skippedPixels: number;
  totalTexels: number;
  inFrustumTexels: number;
  maskRejectedTexels: number;
  depthRejectedTexels: number;
  backfaceRejectedTexels: number;
  writtenTexels: number;
  coverageRatio: number;
  warnings: string[];
  durationMs: number;
  performanceBreakdown?: Record<string, number>;
}

export interface BakedTexture {
  id: string;
  objectId: string;
  sourceLayerId: string;
  sourceLayerIds?: string[];
  cacheKey?: string;
  imageUrl: string;
  width: number;
  height: number;
  format: 'png';
  createdAt: string;
  coverageRatio: number;
  report: BakeReport;
}

export interface BakeProjectedLayerInput {
  objectId: string;
  layerId: string;
  resolution: UvBakeResolution;
  opacity: number;
  enableBackfaceCulling: boolean;
  enableDilation: boolean;
  dilationPixels: number;
  preferBlobOutput?: boolean;
  onProgress?: (progress: BakeProgress) => void;
}

export interface BakeVisibleProjectedLayersInput {
  /** Renderer-only pre-postprocess state for exact interactive region recomposition. */
  retainRawComposite?: boolean;
  incrementalUv?: { region: import('./incrementalUvComposite').UvBakeRegion;
    base: import('./incrementalUvComposite').RawUvComposite };
  /** Interactive derived pixels may upload during input; authored bakes still wait. */
  allowWhileInteracting?: boolean;
  /** Renderer-owned display calculation for this exact model, independent of selection. */
  sourceModel?: ModelLoadResult;
  /** Optional renderer-owned cache; never persisted or used as authoritative output. */
  rasterCache?: ProjectedUvRasterCache;
  objectId: string;
  layerIds?: string[];
  transientLayers?: Layer[];
  resolution: UvBakeResolution;
  cacheKey?: string;
  enableBackfaceCulling: boolean;
  enableDilation: boolean;
  dilationPixels: number;
  method?: 'auto' | 'gpu' | 'cpu';
  outputAlpha?: 'opaque-viewport' | 'transparent';
  disableGpuFallback?: boolean;
  skipGpuValidation?: boolean;
  minimumCoverageRatio?: number;
  gpuInputTextureFlipY?: boolean;
  gpuProjectedImageUvFlipY?: boolean;
  gpuCompositeMode?: GpuUvCompositeMode;
  /** Reject GPU projection fragments whose captured depth differs by more than maximumDepthError. */
  strictDepthCheck?: boolean;
  maximumDepthError?: number;
  /** Reject weak projected fragments before they can seed dilation. */
  minimumOutputCoverage?: number;
  /**
   * Keep aggregate projection confidence in the output alpha instead of
   * marking every accepted top-three candidate fully opaque. Used by
   * content-aware gap detection; ordinary merged UV output stays opaque.
   */
  preserveCoverageConfidenceAlpha?: boolean;
  /** Keep dilation only where it closes an interior pinhole or narrow crack. */
  constrainDilationToInteriorHoles?: boolean;
  /** Add color padding only outside UV islands to prevent bilinear-filter seams. */
  uvIslandGutterPixels?: number;
  /** Propagate nearby projected color only across texels occupied by model UV topology. */
  uvCoverageGapPixels?: number;
  /** Close only enclosed UV pinholes/narrow cracks that have coverage on opposite sides. */
  uvInteriorHolePixels?: number;
  /** Copy valid color across geometrically paired UV seams when one side missed projection. */
  repairMissingUvSeams?: boolean;
  /** Width of the geometry-aware UV seam repair band. */
  uvSeamRepairPixels?: number;
  debugIgnoreMask?: boolean;
  debugIgnoreDepth?: boolean;
  /** Limit transient runtime visibility captures used by lightweight editor tools. */
  runtimeVisibilityMaxSize?: number;
  /** Depth-only captures avoid a second normal pass when geometric culling is sufficient. */
  runtimeVisibilityIncludeNormal?: boolean;
  commitToProject?: boolean;
  markSourceLayersBaked?: boolean;
  preferBlobOutput?: boolean;
  skipImageEncoding?: boolean;
  /** Return straight RGBA directly and leave the compatibility canvas untouched. */
  skipCanvasUpload?: boolean;
  /** Skip CPU seam/dilation passes when a transparent GPU overlay is already final. */
  skipCpuPostprocess?: boolean;
  /** Throws when a derived display request has been superseded; never persisted. */
  checkCancelled?: () => void;
  onProgress?: (progress: BakeProgress) => void;
}

export interface BakeProjectedLayerResult {
  rawComposite?: import('./incrementalUvComposite').RawUvComposite;
  bakedTexture: BakedTexture;
  canvas: HTMLCanvasElement;
  imageData?: ImageData;
  /** Premultiplied coverage of baked display-color overlays, one byte per texel. */
  renderedColorMask?: Uint8Array;
  imageBlob?: Blob;
  imageUrl: string;
  report: BakeReport;
}

export type UvBakeRequest = {
  objectId: string;
  layerIds: string[];
  resolution: UvBakeResolution;
  output: 'basecolor' | 'normal' | 'mask';
};

export type UvBakeResult = {
  url: string;
  width: UvBakeResolution;
  height: UvBakeResolution;
  createdAt: string;
};
