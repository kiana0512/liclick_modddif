import * as THREE from 'three';
import { applyTargetOnlyMaterial, renderSceneToPngUrl } from './renderTargetUtils';
import type { CapturePassRequest, CapturePassOutput } from './captureTypes';

function createLinearViewDepthMaterial(camera: THREE.Camera) {
  const near =
    camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera
      ? camera.near
      : 0.01;
  const far =
    camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera
      ? camera.far
      : 100;
  return new THREE.ShaderMaterial({
    uniforms: {
      captureNear: { value: near },
      captureFar: { value: far },
    },
    vertexShader: `
      #include <common>
      #include <batching_pars_vertex>
      #include <morphtarget_pars_vertex>
      #include <skinning_pars_vertex>
      uniform float captureNear;
      uniform float captureFar;
      varying float vLinearViewDepth;

      void main() {
        #include <batching_vertex>
        #include <skinbase_vertex>
        #include <begin_vertex>
        #include <morphtarget_vertex>
        #include <skinning_vertex>
        #include <project_vertex>
        vLinearViewDepth = clamp(
          (-mvPosition.z - captureNear) / max(captureFar - captureNear, 0.000001),
          0.0,
          1.0
        );
      }
    `,
    fragmentShader: `
      #include <packing>
      varying float vLinearViewDepth;

      void main() {
        // Keep alpha fully opaque. Canvas/PNG encoding may premultiply RGB by
        // alpha, which corrupts packed RGBA depth and causes noisy visibility.
        gl_FragColor = vec4(packDepthToRGB(vLinearViewDepth), 1.0);
      }
    `,
    side: THREE.DoubleSide,
    blending: THREE.NoBlending,
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
  });
}

export async function captureDepth(request: CapturePassRequest): Promise<CapturePassOutput> {
  const restore = applyTargetOnlyMaterial(
    request.scene,
    request.objectId,
    () => createLinearViewDepthMaterial(request.camera),
  );

  try {
    return {
      url: await renderSceneToPngUrl(
        { ...request, clearColor: '#ffffff', clearAlpha: 1 },
        { dataTexture: true, samples: 0, ignoreSceneBackground: true },
      ),
      warnings: [],
    };
  } finally {
    restore();
  }
}
