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
export type ProjectionVisibilityPolicy = 'standard' | 'surface-locked-v1';

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
  /** Canonical active projection source retained for non-destructive repaint saves. */
  localRepaintSourceUrl?: string;
  /** Untouched result retained alongside a seam-enhanced projection source. */
  localRepaintRawSourceUrl?: string;
  /** Version of boundary-only seam harmonization used by the active source. */
  localRepaintSeamHarmonizationVersion?: number;
  /** Cumulative projection-space brush alpha retained without RGBA readback. */
  localRepaintMaskUrl?: string;
  /** Ignore the generated image alpha; the authored brush mask is the only repaint coverage. */
  ignoreSourceAlpha?: boolean;
  renderedColor?: boolean;
  /** Per-UV-texel weight whose color already contains viewport lighting/exposure. */
  renderedColorMaskUrl?: string;
  /** Minimum absolute face-on cosine accepted by projection; 0 disables the guard. */
  minimumProjectionFacing?: number;
  /** Local repaint visibility must remain attached to the captured front surface. */
  projectionVisibilityPolicy?: ProjectionVisibilityPolicy;
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
  /** Version of the editor-side projected/UV flattening semantics. */
  uvMergeVersion?: number;
  createdAt: string;
};
