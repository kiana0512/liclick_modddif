import type { SerializedCamera } from './capture';

export type LocalRepaintMode = 'edit_layer_image' | 'repair_current_view';
export type LocalRepaintStatus =
  | 'idle'
  | 'painting'
  | 'submitting'
  | 'preview_ready'
  | 'accepted'
  | 'cancelled'
  | 'error';

export type Rect = { x: number; y: number; w: number; h: number };

export type ImageBitmapLike = {
  width: number;
  height: number;
  url?: string;
  blob?: Blob;
  data?: ImageData;
};

export type MaskBitmap = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export interface LocalRepaintSession {
  id: string;
  mode: LocalRepaintMode;
  targetLayerId?: string;
  targetRepairLayerId?: string;
  cameraState: SerializedCamera;
  workingImage: ImageBitmapLike;
  objectMask: MaskBitmap;
  userMask: MaskBitmap;
  holeMask: MaskBitmap;
  editMask: MaskBitmap;
  protectMask: MaskBitmap;
  roiRect?: Rect;
  prompt: string;
  selectedReferenceIds: string[];
  providerRequest?: unknown;
  providerResponse?: unknown;
  previewResult?: ImageBitmapLike;
  mergedResult?: ImageBitmapLike;
  status: LocalRepaintStatus;
}
