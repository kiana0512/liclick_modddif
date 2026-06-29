import type * as THREE from 'three';
import type { SerializedCamera } from '@/types/capture';
import type { BlendMode } from '@/types/layer';

export type ProjectionLayerInput = {
  layerId: string;
  imageUrl: string;
  maskUrl?: string;
  depthUrl?: string;
  camera: SerializedCamera;
  objectId: string;
  objectMatrixWorld?: number[];
  currentObjectMatrixWorld?: number[];
  baseTexture?: THREE.Texture;
  baseColor?: THREE.ColorRepresentation;
  opacity: number;
  strength?: number;
  blendMode?: BlendMode;
  visible: boolean;
  depthTest: boolean;
  useMask?: boolean;
  useDepthCheck?: boolean;
  enableBackfaceCulling?: boolean;
  edgeFeather?: number;
  depthBias?: number;
  hue?: number;
  saturation?: number;
  lightness?: number;
};

export type ProjectionLayerStackInput = Omit<ProjectionLayerInput, 'layerId' | 'imageUrl' | 'maskUrl' | 'depthUrl' | 'camera' | 'objectMatrixWorld' | 'opacity' | 'strength' | 'blendMode' | 'visible' | 'hue' | 'saturation' | 'lightness' | 'useMask' | 'useDepthCheck'> & {
  layers: Array<Pick<ProjectionLayerInput, 'layerId' | 'imageUrl' | 'maskUrl' | 'depthUrl' | 'camera' | 'objectMatrixWorld' | 'opacity' | 'strength' | 'blendMode' | 'visible' | 'hue' | 'saturation' | 'lightness' | 'useMask' | 'useDepthCheck'>>;
};

export type ProjectionMatrixBundle = {
  viewMatrix: THREE.Matrix4;
  projectionMatrix: THREE.Matrix4;
  projectorMatrix: THREE.Matrix4;
};
