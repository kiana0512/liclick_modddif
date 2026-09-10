import * as THREE from 'three';
import { useSceneStore } from '@/stores/sceneStore';
import { getTargetBounds, createFitObjectCamera } from './captureCurrentView';
import { animateCaptureCamera } from './animateCaptureCamera';
function vectorFromTuple(tuple?: [number, number, number]) { return tuple ? new THREE.Vector3(...tuple) : undefined; }

/** Fit once at submission, then share the immutable camera across every input. */
export async function frameGenerationCapture(
  objectId: string,
  aspect = 1,
  viewDirection?: [number, number, number],
  viewUp?: [number, number, number],
  signal?: AbortSignal,
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
  const fitted = createFitObjectCamera(source, bounds, safeAspect, 0.88,
    viewport.controls?.target, vectorFromTuple(viewDirection), vectorFromTuple(viewUp));
  // Keep the live viewport's aspect/frustum; its square capture frame uses the
  // same vertical extent as the frozen input camera. Never stretch the viewport.
  await animateCaptureCamera(viewport, fitted.camera, fitted.target, signal);
  return { camera: fitted.camera, target: fitted.target, aspect: safeAspect };
}

