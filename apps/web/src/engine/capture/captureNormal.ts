import * as THREE from 'three';
import { applyTargetOnlyMaterial, renderSceneToPngUrl } from './renderTargetUtils';
import type { CapturePassRequest, CapturePassOutput } from './captureTypes';

type NormalCaptureSpace = 'view' | 'world' | 'object';

function createEncodedNormalMaterial(space: NormalCaptureSpace) {
  if (space === 'view') return new THREE.MeshNormalMaterial();

  return new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vCaptureNormal;

      void main() {
        vCaptureNormal = normalize(${space === 'world' ? 'mat3(modelMatrix) * normal' : 'normal'});
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vCaptureNormal;

      void main() {
        vec3 n = normalize(vCaptureNormal);
        gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
      }
    `,
    toneMapped: false,
  });
}

export async function captureNormal(
  request: CapturePassRequest,
  options: { space?: NormalCaptureSpace; geometryGuide?: boolean } = {},
): Promise<CapturePassOutput> {
  const material = createEncodedNormalMaterial(options.space ?? 'view');
  const restore = applyTargetOnlyMaterial(
    request.scene,
    request.objectId,
    () => material,
  );

  try {
    return {
      url: await renderSceneToPngUrl(request, {
        onRenderSubmitted: restore,
        ...(options.geometryGuide ? { dataTexture: true, ignoreSceneBackground: true, samples: 0 } : {}),
      }),
      warnings: [],
    };
  } finally {
    restore();
    material.dispose();
  }
}
