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
      // Geometry coverage must not contain the viewport's configurable background.
      url: await renderSceneToPngUrl(request, { ignoreSceneBackground: true, onRenderSubmitted: restore }),
      warnings: [],
    };
  } finally {
    restore();
  }
}
