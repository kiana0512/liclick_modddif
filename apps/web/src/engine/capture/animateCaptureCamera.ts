import * as THREE from 'three';
import type { ViewportRuntime } from '@/stores/sceneStore';
import { waitForBrowserPaint } from '@/utils/browserScheduling';

/** Camera-only 240ms transition: no rendering, bounds walks, or image work. */
export async function animateCaptureCamera(
  viewport: ViewportRuntime,
  fitted: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  target: THREE.Vector3,
  signal?: AbortSignal,
) {
  const camera = viewport.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
  viewport.controls?.update(); // cancel wheel inertia before the deliberate move
  const startPosition = camera.position.clone();
  const startQuaternion = camera.quaternion.clone();
  const startUp = camera.up.clone();
  const startTarget = viewport.controls?.target.clone() ?? target.clone();
  const startZoom = camera.zoom;
  const endZoom = camera instanceof THREE.OrthographicCamera && fitted instanceof THREE.OrthographicCamera
    ? (camera.top - camera.bottom) / (fitted.top - fitted.bottom) : fitted.zoom;
  const expectedPosition = startPosition.clone();
  const expectedQuaternion = startQuaternion.clone();
  let expectedZoom = startZoom;
  const started = performance.now();
  let progress = 0;
  do {
    await waitForBrowserPaint();
    if (signal?.aborted) throw new DOMException('已取消取景。', 'AbortError');
    if (!camera.position.equals(expectedPosition) || !camera.quaternion.equals(expectedQuaternion) || camera.zoom !== expectedZoom) {
      throw new Error('取景期间相机已移动，请重新生成。');
    }
    progress = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      ? 1 : Math.min(1, (performance.now() - started) / 240);
    const t = progress * progress * (3 - 2 * progress);
    camera.position.lerpVectors(startPosition, fitted.position, t);
    camera.quaternion.slerpQuaternions(startQuaternion, fitted.quaternion, t);
    camera.up.lerpVectors(startUp, fitted.up, t).normalize();
    camera.zoom = Math.exp(Math.log(startZoom) * (1 - t) + Math.log(endZoom) * t);
    viewport.controls?.target.lerpVectors(startTarget, target, t);
    // Keep navigation planes broad; the separate fitted camera owns capture depth.
    camera.near = Math.min(camera.near, fitted.near, 0.01);
    camera.far = Math.max(camera.far, fitted.far, 100);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    expectedPosition.copy(camera.position);
    expectedQuaternion.copy(camera.quaternion);
    expectedZoom = camera.zoom;
  } while (progress < 1);
  camera.zoom = endZoom;
  camera.updateProjectionMatrix();
  viewport.controls?.update();
  await waitForBrowserPaint();
  if (signal?.aborted) throw new DOMException('已取消取景。', 'AbortError');
}
