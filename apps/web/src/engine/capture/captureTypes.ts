import type { CameraSnapshot, CapturePass, CaptureResult } from '@/types/capture';

export type CaptureRequest = {
  objectId: string;
  width: number;
  height: number;
  camera: CameraSnapshot;
};

export type CapturePassRunner = (request: CaptureRequest) => Promise<CaptureResult>;

export const mockCameraSnapshot: CameraSnapshot = {
  projection: 'perspective',
  position: [3.2, 2.4, 4],
  target: [0, 0.5, 0],
  fov: 45,
  near: 0.1,
  far: 100,
  viewMatrix: [],
  projectionMatrix: [],
};

export function makeMockCapture(pass: CapturePass, color: string): CaptureResult {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${color}"/><text x="56" y="120" fill="white" font-size="64" font-family="Arial">${pass}</text></svg>`;
  return {
    pass,
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    width: 1024,
    height: 1024,
    createdAt: new Date().toISOString(),
  };
}
