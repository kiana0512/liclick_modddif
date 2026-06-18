export type CameraSnapshot = {
  projection: 'perspective' | 'orthographic';
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  near: number;
  far: number;
  viewMatrix: number[];
  projectionMatrix: number[];
};

export type Capture = {
  id: string;
  objectId: string;
  camera: CameraSnapshot;
  colorUrl: string;
  maskUrl: string;
  depthUrl: string;
  normalUrl: string;
  createdAt: string;
};

export type CapturePass = 'color' | 'mask' | 'depth' | 'normal';

export type CaptureResult = {
  pass: CapturePass;
  url: string;
  width: number;
  height: number;
  createdAt: string;
};
