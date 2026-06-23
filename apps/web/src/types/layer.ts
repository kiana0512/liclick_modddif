import type { SerializedCamera } from './capture';

export type LayerType = 'uv' | 'projected' | 'patch' | 'normal';
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'soft-light';

export type LayerAdjustments = {
  hue: number;
  saturation: number;
  lightness: number;
};

export type Layer = {
  id: string;
  name: string;
  type: LayerType;
  imageUrl: string;
  maskUrl?: string;
  depthUrl?: string;
  objectId?: string;
  objectMatrixWorld?: number[];
  camera?: SerializedCamera;
  generationId?: string;
  captureId?: string;
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
  adjustments?: LayerAdjustments;
  order: number;
  bakedTextureId?: string;
  bakedAt?: string;
  isBaked?: boolean;
  needsRebake?: boolean;
  createdAt: string;
};
