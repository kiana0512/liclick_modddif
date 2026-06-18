import type { CameraSnapshot } from '@/types/capture';

export function createProjectionCameraSnapshot(camera: Partial<CameraSnapshot>): CameraSnapshot {
  return {
    projection: camera.projection ?? 'perspective',
    position: camera.position ?? [0, 0, 5],
    target: camera.target ?? [0, 0, 0],
    fov: camera.fov ?? 45,
    near: camera.near ?? 0.1,
    far: camera.far ?? 100,
    viewMatrix: camera.viewMatrix ?? [],
    projectionMatrix: camera.projectionMatrix ?? [],
  };
}
