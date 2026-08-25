import * as THREE from 'three';
import { applyTargetOnlyMaterial, renderSceneToPngUrl } from './renderTargetUtils';
import type { CapturePassRequest, CapturePassOutput } from './captureTypes';

type NormalCaptureSpace = 'view' | 'world' | 'object';

function createEncodedNormalMaterial(space: NormalCaptureSpace) {
  if (space === 'view') return new THREE.MeshNormalMaterial();

  return new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vNormalObject;
      varying vec3 vNormalWorld;

      void main() {
        vNormalObject = normalize(normal);
        vNormalWorld = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vNormalObject;
      varying vec3 vNormalWorld;

      void main() {
        vec3 n = normalize(${space === 'world' ? 'vNormalWorld' : 'vNormalObject'});
        gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
      }
    `,
    toneMapped: false,
  });
}

export async function captureNormal(
  request: CapturePassRequest,
  options: { space?: NormalCaptureSpace } = {},
): Promise<CapturePassOutput> {
  const restore = applyTargetOnlyMaterial(
    request.scene,
    request.objectId,
    () => createEncodedNormalMaterial(options.space ?? 'view'),
  );

  try {
    return {
      url: await renderSceneToPngUrl(request, { onRenderSubmitted: restore }),
      warnings: [],
    };
  } finally {
    restore();
  }
}
