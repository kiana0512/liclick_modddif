import * as THREE from 'three';
import { applyTargetOnlyMaterial, renderSceneToPngUrl } from './renderTargetUtils';
import type { CapturePassRequest, CapturePassOutput } from './captureTypes';

export async function captureMask(request: CapturePassRequest): Promise<CapturePassOutput> {
  const restore = applyTargetOnlyMaterial(
    request.scene,
    request.objectId,
    () => new THREE.MeshBasicMaterial({ color: '#ffffff' }),
  );

  try {
    return {
      url: await renderSceneToPngUrl(request),
      warnings: [],
    };
  } finally {
    restore();
  }
}
