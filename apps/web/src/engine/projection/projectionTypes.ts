import type * as THREE from 'three';
import type { SerializedCamera } from '@/types/capture';

export type ProjectionLayerInput = {
  layerId: string;
  imageUrl: string;
  camera: SerializedCamera;
  objectId: string;
  opacity: number;
  visible: boolean;
  depthTest: boolean;
};

export type ProjectionMatrixBundle = {
  viewMatrix: THREE.Matrix4;
  projectionMatrix: THREE.Matrix4;
  projectorMatrix: THREE.Matrix4;
};
