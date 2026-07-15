import type * as THREE from 'three';
import type { SerializedCamera } from '@/types/capture';
import type { BlendMode, LayerMaskSpace } from '@/types/layer';

export type ProjectionLayerInput = {
  layerId: string;
  imageUrl: string;
  maskUrl?: string;
  maskSpace?: LayerMaskSpace;
  depthUrl?: string;
  camera: SerializedCamera;
  objectId: string;
  objectMatrixWorld?: number[];
  currentObjectMatrixWorld?: number[];
  baseTexture?: THREE.Texture;
  uvOverlayTexture?: THREE.Texture;
  baseColor?: THREE.ColorRepresentation;
  opacity: number;
  strength?: number;
  blendMode?: BlendMode;
  visible: boolean;
  depthTest: boolean;
  useMask?: boolean;
  useDepthCheck?: boolean;
  renderedColor?: boolean;
  enableBackfaceCulling?: boolean;
  edgeFeather?: number;
  depthBias?: number;
  hue?: number;
  saturation?: number;
  lightness?: number;
  previewLighting?: ProjectionPreviewLighting;
};

export type ProjectionPreviewLighting = {
  enabled: boolean;
  exposure: number;
  ambientIntensity: number;
  keyLightIntensity: number;
  keyLightDirection: [number, number, number];
};

export type ProjectionLayerStackInput = Omit<ProjectionLayerInput, 'layerId' | 'imageUrl' | 'maskUrl' | 'maskSpace' | 'depthUrl' | 'camera' | 'objectMatrixWorld' | 'opacity' | 'strength' | 'blendMode' | 'visible' | 'hue' | 'saturation' | 'lightness' | 'useMask' | 'useDepthCheck' | 'renderedColor'> & {
  layers: Array<Pick<ProjectionLayerInput, 'layerId' | 'imageUrl' | 'maskUrl' | 'maskSpace' | 'depthUrl' | 'camera' | 'objectMatrixWorld' | 'opacity' | 'strength' | 'blendMode' | 'visible' | 'hue' | 'saturation' | 'lightness' | 'useMask' | 'useDepthCheck' | 'renderedColor'>>;
};

export type ProjectionMatrixBundle = {
  viewMatrix: THREE.Matrix4;
  projectionMatrix: THREE.Matrix4;
  projectorMatrix: THREE.Matrix4;
};
