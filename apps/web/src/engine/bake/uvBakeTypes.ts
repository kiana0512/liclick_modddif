export type UvBakeResolution = 1024 | 2048 | 4096 | 8192;
export type BakeProgressPhase = 'loading-assets' | 'rasterizing' | 'compositing' | 'encoding' | 'applying' | 'persisting';

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
  objectId: string;
  layerIds?: string[];
  resolution: UvBakeResolution;
  cacheKey?: string;
  enableBackfaceCulling: boolean;
  enableDilation: boolean;
  dilationPixels: number;
  method?: 'auto' | 'gpu' | 'cpu';
  outputAlpha?: 'opaque-viewport' | 'transparent';
  commitToProject?: boolean;
  markSourceLayersBaked?: boolean;
  preferBlobOutput?: boolean;
  onProgress?: (progress: BakeProgress) => void;
}

export interface BakeProjectedLayerResult {
  bakedTexture: BakedTexture;
  canvas: HTMLCanvasElement;
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
