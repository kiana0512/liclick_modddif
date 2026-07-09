export type SerializedCamera = {
  type: 'perspective' | 'orthographic';
  projection: 'perspective' | 'orthographic';
  position: [number, number, number];
  quaternion: [number, number, number, number];
  target: [number, number, number];
  near: number;
  far: number;
  fov?: number;
  zoom: number;
  projectionMatrix: number[];
  matrixWorld: number[];
  viewMatrix: number[];
  aspect: number;
};

export type CameraSnapshot = SerializedCamera & {
  fov: number;
};

export type Capture = {
  id: string;
  objectId: string;
  camera: SerializedCamera;
  width: number;
  height: number;
  colorUrl: string;
  maskUrl: string;
  depthUrl?: string;
  normalUrl?: string;
  createdAt: string;
  warnings: string[];
};

export type CapturePass = 'color' | 'mask' | 'depth' | 'normal';

export type CapturePassImage = {
  pass: CapturePass;
  url: string;
  width: number;
  height: number;
  createdAt: string;
  warnings: string[];
};

export type CaptureResult = Capture;
