import type { SerializedCamera } from './capture';

export type LayerType = 'uv' | 'projected' | 'patch' | 'normal';
export type LayerRole =
  | 'base-color'
  | 'merged-uv'
  | 'local-repaint-draft'
  | 'local-repaint-overlay'
  | 'content-aware-underlay';
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'soft-light';
export type LayerMaskSpace = 'projection' | 'uv';

export type LayerAdjustments = {
  hue: number;
  saturation: number;
  lightness: number;
};

export type Layer = {
  id: string;
  name: string;
  type: LayerType;
  role?: LayerRole;
  imageUrl: string;
  maskUrl?: string;
  maskSpace?: LayerMaskSpace;
  depthUrl?: string;
  depthEncoding?: 'linear-view';
  /** Runtime geometric-normal visibility captured from the projection camera. */
  normalUrl?: string;
  objectId?: string;
  objectMatrixWorld?: number[];
  camera?: SerializedCamera;
  generationId?: string;
  captureId?: string;
  replacementTargetLayerId?: string;
  /** Original generated view retained for non-destructive local repaint saves. */
  localRepaintSourceUrl?: string;
  /** Cumulative projection-space brush alpha retained without RGBA readback. */
  localRepaintMaskUrl?: string;
  renderedColor?: boolean;
  /** Minimum absolute face-on cosine accepted by projection; 0 disables the guard. */
  minimumProjectionFacing?: number;
  visible: boolean;
  opacity: number;
  strength?: number;
  blendMode: BlendMode;
  adjustments?: LayerAdjustments;
  order: number;
  bakedTextureId?: string;
  bakedAt?: string;
  isBaked?: boolean;
  needsRebake?: boolean;
  contentRevision?: number;
  createdAt: string;
};
