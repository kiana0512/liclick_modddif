import type * as THREE from 'three';
import type { SerializedCamera } from '@/types/capture';
import type { BlendMode, LayerMaskSpace } from '@/types/layer';

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
  baseRenderedColorMaskTexture?: THREE.Texture;
  uvOverlayTexture?: THREE.Texture;
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
  /** Reject projected fragments below this absolute geometric face-on cosine. */
  minimumProjectionFacing?: number;
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
  | 'minimumProjectionFacing'
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
    >
  >;
};

export type ProjectionMatrixBundle = {
  viewMatrix: THREE.Matrix4;
  projectionMatrix: THREE.Matrix4;
  projectorMatrix: THREE.Matrix4;
};
