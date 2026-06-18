import * as THREE from 'three';
import { applyTargetOnlyMaterial, renderSceneToDataUrl } from './renderTargetUtils';
import type { CapturePassRequest, CapturePassOutput } from './captureTypes';

export async function captureDepth(request: CapturePassRequest): Promise<CapturePassOutput> {
  const restore = applyTargetOnlyMaterial(
    request.scene,
    request.objectId,
    () =>
      new THREE.MeshDepthMaterial({
        depthPacking: THREE.BasicDepthPacking,
      }),
  );

  try {
    return {
      url: renderSceneToDataUrl(request),
      warnings: ['Depth is encoded as viewport grayscale depth for MVP preview.'],
    };
  } finally {
    restore();
  }
}
