import * as THREE from 'three';
import { applyTargetOnlyMaterial, renderSceneToPngUrl } from './renderTargetUtils';
import type { CapturePassRequest, CapturePassOutput } from './captureTypes';

type NormalCaptureSpace = 'view' | 'world' | 'object';

// NORMAL-CAPTURE-MATERIAL/1.0.0: immutable normal programs belong to the
// renderer, not an individual angle. Weak ownership retains at most three
// materials; renderer.dispose() still releases its GPU program cache.
const normalMaterials = new WeakMap<THREE.WebGLRenderer, Map<NormalCaptureSpace, THREE.Material>>();

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

function getEncodedNormalMaterial(renderer: THREE.WebGLRenderer, space: NormalCaptureSpace) {
  let materials = normalMaterials.get(renderer);
  if (!materials) {
    materials = new Map();
    normalMaterials.set(renderer, materials);
  }
  let material = materials.get(space);
  if (!material) {
    material = createEncodedNormalMaterial(space);
    materials.set(space, material);
  }
  return material;
}

export async function captureNormal(
  request: CapturePassRequest,
  options: { space?: NormalCaptureSpace; geometryGuide?: boolean } = {},
): Promise<CapturePassOutput> {
  const material = getEncodedNormalMaterial(request.gl, options.space ?? 'view');
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
  }
}
