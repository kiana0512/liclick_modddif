import type { CameraSnapshot } from '@/types/capture';

export type ProjectionLayerInput = {
  layerId: string;
  imageUrl: string;
  camera: CameraSnapshot;
  objectId: string;
  depthTest: boolean;
};

export type ProjectionMatrixBundle = {
  viewMatrix: number[];
  projectionMatrix: number[];
  inverseViewProjectionMatrix: number[];
};
