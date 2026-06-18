import { captureColor } from './captureColor';
import { captureDepth } from './captureDepth';
import { captureMask } from './captureMask';
import { captureNormal } from './captureNormal';
import type { CaptureCurrentViewRequest, CapturePassRequest } from './captureTypes';
import { serializeCamera } from '@/engine/projection/ProjectionCamera';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import type { Capture } from '@/types/capture';
import * as THREE from 'three';

const maxCaptureSize = 2048;

export async function captureCurrentView(request: CaptureCurrentViewRequest): Promise<Capture> {
  const viewport = useSceneStore.getState().viewport;
  if (!viewport) throw new Error('Viewport is not ready yet.');

  const size = Math.min(request.resolution, maxCaptureSize);
  const warnings: string[] = [];
  if (request.resolution > maxCaptureSize) {
    warnings.push('4K capture was limited to 2048px in this browser MVP to avoid freezing the viewport.');
  }

  const passRequest: CapturePassRequest = {
    gl: viewport.gl,
    scene: viewport.scene,
    camera: viewport.camera,
    objectId: request.objectId,
    width: size,
    height: size,
  };

  const [color, mask, normal, depth] = await Promise.all([
    captureColor(passRequest),
    captureMask(passRequest),
    captureNormal(passRequest),
    captureDepth(passRequest),
  ]);

  const capture: Capture = {
    id: crypto.randomUUID(),
    objectId: request.objectId,
    camera: serializeCamera(viewport.camera, size / size, viewport.controls?.target ?? new THREE.Vector3()),
    width: size,
    height: size,
    colorUrl: color.url,
    maskUrl: mask.url,
    normalUrl: normal.url,
    depthUrl: depth.url,
    createdAt: new Date().toISOString(),
    warnings: [...warnings, ...color.warnings, ...mask.warnings, ...normal.warnings, ...depth.warnings],
  };

  useProjectStore.getState().addCapture(capture);
  console.info('[Liclick 3D Texture] Capture current view:', capture);
  return capture;
}
