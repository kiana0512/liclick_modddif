import type * as THREE from 'three';
import type { SerializedCamera } from '@/types/capture';
import type { BlendMode, LayerMaskSpace, ProjectionVisibilityPolicy } from '@/types/layer';

export type ProjectionLayerInput = {
  layerId: string;
  imageUrl: string;
  maskUrl?: string;
  maskSpace?: LayerMaskSpace;
  depthUrl?: string;
  /** The depth sampler stores linear camera-space distance normalized by near/far. */
  depthIsLinearView?: boolean;
  /** Frontmost geometric face normals from the capture view, used to lock cuts to creases. */
  normalUrl?: string;
  camera: SerializedCamera;
  objectId: string;
  objectMatrixWorld?: number[];
  currentObjectMatrixWorld?: number[];
  baseTexture?: THREE.Texture;
  /** Compile the base-map branch before its resident texture finishes decoding. */
  reserveBaseMapSampler?: boolean;
  /** Runtime visibility/opacity for a resident base texture; does not change shader structure. */
  baseTextureOpacity?: number;
  baseRenderedColorMaskTexture?: THREE.Texture;
  uvOverlayTexture?: THREE.Texture;
  uvOverlayRenderedColor?: boolean;
  uvOverlayRenderedColorMaskTexture?: THREE.Texture;
  /** Compile the UV-overlay branch before its resident texture finishes decoding. */
  reserveUvOverlaySampler?: boolean;
  /** Runtime visibility/opacity for a resident UV overlay; does not change shader structure. */
  uvOverlayOpacity?: number;
  uvOverlayHue?: number;
  uvOverlaySaturation?: number;
  uvOverlayLightness?: number;
  /** UV patch that is ordered above the projected stack and composites last. */
  topUvOverlayTexture?: THREE.Texture;
  topUvOverlayOpacity?: number;
  topUvOverlayRenderedColor?: boolean;
  topUvOverlayHue?: number;
  topUvOverlaySaturation?: number;
  topUvOverlayLightness?: number;
  /** Live UV keep-mask multiplied over one projected layer while the eraser moves. */
  liveEraserMaskTexture?: THREE.Texture;
  liveEraserLayerId?: string;
  baseColor?: THREE.ColorRepresentation;
  opacity: number;
  strength?: number;
  blendMode?: BlendMode;
  /** Internal preview ordering independent from the user-facing blend mode. */
  compositeRole?: 'normal' | 'overlay' | 'underlay';
  visible: boolean;
  depthTest: boolean;
  useMask?: boolean;
  useDepthCheck?: boolean;
  useNormalCheck?: boolean;
  renderedColor?: boolean;
  /** Render only accepted projection pixels and keep all other fragments transparent. */
  transparentProjectionOnly?: boolean;
  /** Reject projected fragments below this absolute geometric face-on cosine. */
  minimumProjectionFacing?: number;
  projectionVisibilityPolicy?: ProjectionVisibilityPolicy;
  enableBackfaceCulling?: boolean;
  edgeFeather?: number;
  depthBias?: number;
  hue?: number;
  saturation?: number;
  lightness?: number;
  normalPreview?: boolean;
  wirePreview?: boolean;
  previewLighting?: ProjectionPreviewLighting;
};

export type ProjectionPreviewLighting = {
  enabled: boolean;
  exposure: number;
  ambientIntensity: number;
  keyLightIntensity: number;
  keyLightDirection: [number, number, number];
};

export type ProjectionLayerDisplayInput = Pick<
  ProjectionLayerInput,
  | 'layerId'
  | 'opacity'
  | 'strength'
  | 'blendMode'
  | 'visible'
  | 'hue'
  | 'saturation'
  | 'lightness'
>;

export type ProjectionLayerStackInput = Omit<
  ProjectionLayerInput,
  | 'layerId'
  | 'imageUrl'
  | 'maskUrl'
  | 'maskSpace'
  | 'depthUrl'
  | 'depthIsLinearView'
  | 'normalUrl'
  | 'camera'
  | 'objectMatrixWorld'
  | 'opacity'
  | 'strength'
  | 'blendMode'
  | 'visible'
  | 'hue'
  | 'saturation'
  | 'lightness'
  | 'useMask'
  | 'useDepthCheck'
  | 'useNormalCheck'
  | 'renderedColor'
  | 'transparentProjectionOnly'
  | 'minimumProjectionFacing'
  | 'projectionVisibilityPolicy'
> & {
  layers: Array<
    Pick<
      ProjectionLayerInput,
      | 'layerId'
      | 'imageUrl'
      | 'maskUrl'
      | 'maskSpace'
      | 'depthUrl'
      | 'depthIsLinearView'
      | 'normalUrl'
      | 'camera'
      | 'objectMatrixWorld'
      | 'opacity'
      | 'strength'
      | 'blendMode'
      | 'compositeRole'
      | 'visible'
      | 'hue'
      | 'saturation'
      | 'lightness'
      | 'useMask'
      | 'useDepthCheck'
      | 'useNormalCheck'
      | 'renderedColor'
      | 'minimumProjectionFacing'
      | 'projectionVisibilityPolicy'
    >
  >;
};

export type ProjectionMatrixBundle = {
  viewMatrix: THREE.Matrix4;
  projectionMatrix: THREE.Matrix4;
  projectorMatrix: THREE.Matrix4;
};
