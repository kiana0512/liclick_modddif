import * as THREE from 'three';
import { renderSceneToPngUrl } from '@/engine/capture/renderTargetUtils';
import type { SerializedCamera } from '@/types/capture';

type RuntimeProjectionDepthRequest = {
  renderer: THREE.WebGLRenderer;
  group: THREE.Group;
  camera: SerializedCamera;
  captureObjectMatrixWorld?: number[];
  width: number;
  height: number;
};

export type RuntimeProjectionVisibility = {
  depthUrl: string;
  normalUrl: string;
};

const cacheByRenderer = new WeakMap<
  THREE.WebGLRenderer,
  Map<string, Promise<RuntimeProjectionVisibility>>
>();

function stableNumbers(values?: number[]) {
  return values?.map((value) => value.toFixed(6)).join(',') ?? '';
}

function createCacheKey(request: RuntimeProjectionDepthRequest) {
  return [
    request.group.uuid,
    request.width,
    request.height,
    stableNumbers(request.camera.viewMatrix),
    stableNumbers(request.camera.projectionMatrix),
    stableNumbers(request.captureObjectMatrixWorld),
  ].join(':');
}

function createCamera(snapshot: SerializedCamera) {
  const camera =
    snapshot.type === 'orthographic'
      ? new THREE.OrthographicCamera(-1, 1, 1, -1, snapshot.near, snapshot.far)
      : new THREE.PerspectiveCamera(
          snapshot.fov ?? 45,
          snapshot.aspect || 1,
          snapshot.near,
          snapshot.far,
        );
  camera.position.fromArray(snapshot.position);
  camera.quaternion.fromArray(snapshot.quaternion);
  camera.updateMatrixWorld(true);
  if (snapshot.projectionMatrix.length === 16) {
    camera.projectionMatrix.fromArray(snapshot.projectionMatrix);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }
  return camera;
}

function createLinearViewDepthMaterial(camera: SerializedCamera) {
  return new THREE.ShaderMaterial({
    uniforms: {
      captureNear: { value: camera.near },
      captureFar: { value: camera.far },
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
        // Keep alpha fully opaque so the canvas/PNG round trip cannot
        // premultiply and corrupt the packed depth channels.
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

function createGeometricViewNormalMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: `
      #include <common>
      #include <batching_pars_vertex>
      #include <morphtarget_pars_vertex>
      #include <skinning_pars_vertex>
      varying vec3 vCaptureViewPosition;

      void main() {
        #include <batching_vertex>
        #include <skinbase_vertex>
        #include <begin_vertex>
        #include <morphtarget_vertex>
        #include <skinning_vertex>
        vec4 captureViewPosition = modelViewMatrix * vec4(transformed, 1.0);
        vCaptureViewPosition = captureViewPosition.xyz;
        gl_Position = projectionMatrix * captureViewPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vCaptureViewPosition;

      void main() {
        // Derivatives yield a flat geometric face normal. Unlike interpolated
        // vertex normals, this changes exactly at a model crease.
        vec3 faceNormal = normalize(cross(dFdx(vCaptureViewPosition), dFdy(vCaptureViewPosition)));
        gl_FragColor = vec4(faceNormal * 0.5 + 0.5, 1.0);
      }
    `,
    side: THREE.DoubleSide,
    blending: THREE.NoBlending,
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
  });
}

function cloneVisibilityGeometry(group: THREE.Group) {
  const originalUserData: Array<{ object: THREE.Object3D; userData: Record<string, unknown> }> = [];
  group.traverse((object) => {
    originalUserData.push({ object, userData: object.userData });
    object.userData = {
      ...(object.userData.liclickObjectId
        ? { liclickObjectId: object.userData.liclickObjectId }
        : {}),
      ...(object.userData.liclickPaintOverlay
        ? { liclickPaintOverlay: true }
        : {}),
    };
  });
  try {
    // Object3D.clone serializes userData through JSON. Imported meshes keep
    // source/original materials and runtime textures in userData, so cloning
    // them directly converts every ImageBitmap to a data URL. Visibility passes
    // only need hierarchy, transforms and the paint-overlay marker.
    return group.clone(true);
  } finally {
    originalUserData.forEach(({ object, userData }) => {
      object.userData = userData;
    });
  }
}

async function renderRuntimeProjectionDepth(request: RuntimeProjectionDepthRequest) {
  request.group.updateMatrixWorld(true);
  const clone = cloneVisibilityGeometry(request.group);
  const captureRootMatrix = request.captureObjectMatrixWorld?.length === 16
    ? new THREE.Matrix4().fromArray(request.captureObjectMatrixWorld)
    : request.group.matrixWorld.clone();
  clone.matrixAutoUpdate = false;
  clone.matrix.copy(captureRootMatrix);
  clone.matrixWorld.copy(captureRootMatrix);
  clone.matrixWorldAutoUpdate = true;

  const depthMaterial = createLinearViewDepthMaterial(request.camera);
  const normalMaterial = createGeometricViewNormalMaterial();
  clone.traverse((object) => {
    if (object.userData.liclickPaintOverlay) {
      object.visible = false;
      return;
    }
    if (!(object instanceof THREE.Mesh)) return;
    object.material = depthMaterial;
    object.frustumCulled = false;
  });

  const scene = new THREE.Scene();
  scene.add(clone);
  scene.updateMatrixWorld(true);
  const camera = createCamera(request.camera);
  try {
    const depthUrl = await renderSceneToPngUrl(
      {
        gl: request.renderer,
        scene,
        camera,
        objectId: '',
        width: request.width,
        height: request.height,
        clearColor: '#ffffff',
        clearAlpha: 1,
      },
      { dataTexture: true, samples: 0, ignoreSceneBackground: true },
    );
    clone.traverse((object) => {
      if (object instanceof THREE.Mesh && object.visible) object.material = normalMaterial;
    });
    const normalUrl = await renderSceneToPngUrl(
      {
        gl: request.renderer,
        scene,
        camera,
        objectId: '',
        width: request.width,
        height: request.height,
        // Zero-length decoded normals mark background and fail closed.
        clearColor: new THREE.Color(0.5, 0.5, 0.5),
        clearAlpha: 1,
      },
      { dataTexture: true, samples: 0, ignoreSceneBackground: true },
    );
    return { depthUrl, normalUrl };
  } finally {
    depthMaterial.dispose();
    normalMaterial.dispose();
    scene.remove(clone);
  }
}

export function createRuntimeProjectionDepth(request: RuntimeProjectionDepthRequest) {
  let cache = cacheByRenderer.get(request.renderer);
  if (!cache) {
    cache = new Map();
    cacheByRenderer.set(request.renderer, cache);
  }
  const key = createCacheKey(request);
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = renderRuntimeProjectionDepth(request).catch((error) => {
    cache?.delete(key);
    throw error;
  });
  cache.set(key, promise);
  return promise;
}
