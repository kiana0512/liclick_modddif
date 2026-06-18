export type UvBakeResolution = 1024 | 2048 | 4096;

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
}

export interface BakeProjectedLayerResult {
  bakedTexture: BakedTexture;
  canvas: HTMLCanvasElement;
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
