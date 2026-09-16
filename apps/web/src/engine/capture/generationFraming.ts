import * as THREE from 'three';
import { useSceneStore } from '@/stores/sceneStore';
import { getTargetBounds, createFitObjectCamera, vectorFromTuple } from './captureCurrentView';
import { animateCaptureCamera } from './animateCaptureCamera';
import { fitGeometryCapture, verifyTightCapture } from './tightCaptureFraming';

/** Fit once at submission, then share the immutable camera across every input. */
export async function frameGenerationCapture(
  objectId: string,
  aspect = 1,
  viewDirection?: [number, number, number],
  viewUp?: [number, number, number],
  signal?: AbortSignal,
  animate = true,
  fillRatio = 0.92,
) {
  const viewport = useSceneStore.getState().viewport;
  if (!viewport) throw new Error('视口尚未准备完成，请稍后重试。');
  const source = viewport.camera;
  if (!(source instanceof THREE.PerspectiveCamera || source instanceof THREE.OrthographicCamera)) {
    throw new Error('当前相机不支持生成取景。');
  }
  const bounds = getTargetBounds(viewport.scene, objectId);
  if (!bounds || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) {
    throw new Error('当前模型尚未准备好，无法调整生成取景。');
  }
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const fallback = createFitObjectCamera(source, bounds, safeAspect, 0.88,
    viewport.controls?.target, vectorFromTuple(viewDirection), vectorFromTuple(viewUp));
  const startPosition = source.position.clone(), startQuaternion = source.quaternion.clone();
  const startZoom = source.zoom;
  const candidate = await fitGeometryCapture(viewport.scene, objectId, fallback, safeAspect, signal, fillRatio);
  const fitted = await verifyTightCapture(viewport, objectId, candidate, fallback, safeAspect, signal,
    fillRatio >= 0.98 ? 0.005 : 0.025);
  signal?.throwIfAborted();
  // ALG-CAP-007/1.1.1: a fixed batch direction owns its cloned capture camera.
  // Orbit damping/navigation cannot invalidate it or cancel the next group.
  // Interactive framing still must not overwrite a user's newer camera pose.
  if ((animate || !viewDirection) &&
      (!source.position.equals(startPosition) || !source.quaternion.equals(startQuaternion) || source.zoom !== startZoom))
    throw new Error('相机已移动，已取消生成取景。');
  // Keep the live viewport's aspect/frustum; its square capture frame uses the
  // same vertical extent as the frozen input camera. Never stretch the viewport.
  if (animate) await animateCaptureCamera(viewport, fitted.camera, fitted.target, signal);
  return { camera: fitted.camera, target: fitted.target, aspect: safeAspect };
}
