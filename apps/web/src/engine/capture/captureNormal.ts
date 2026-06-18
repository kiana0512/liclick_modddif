import * as THREE from 'three';
import { applyTargetOnlyMaterial, renderSceneToDataUrl } from './renderTargetUtils';
import type { CapturePassRequest, CapturePassOutput } from './captureTypes';

export async function captureNormal(request: CapturePassRequest): Promise<CapturePassOutput> {
  const restore = applyTargetOnlyMaterial(request.scene, request.objectId, () => new THREE.MeshNormalMaterial());

  try {
    return {
      url: renderSceneToDataUrl(request),
      warnings: [],
    };
  } finally {
    restore();
  }
}
