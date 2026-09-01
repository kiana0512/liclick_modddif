import * as THREE from 'three';

export type LiveLocalRepaintFastPreview = {
  root: THREE.Group;
  material: THREE.ShaderMaterial;
  meshes: THREE.Mesh[];
  sourceKey: string;
  layerId: string;
};

type CreateFastPreviewInput = {
  modelGroup: THREE.Object3D;
  meshes: readonly THREE.Mesh[];
  sourceKey: string;
  layerId: string;
  sourceTexture: THREE.Texture;
  maskTexture: THREE.Texture;
  worldToSourceClip: THREE.Matrix4;
  renderOrder: number;
};

function createFastPreviewMaterial(input: CreateFastPreviewInput) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      projectedMap: { value: input.sourceTexture },
      maskMap: { value: input.maskTexture },
      projectorMatrix: { value: input.worldToSourceClip.clone() },
      layerOpacity: { value: 1 },
    },
    vertexShader: `
      uniform mat4 projectorMatrix;
      varying vec4 vProjectedPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vProjectedPosition = projectorMatrix * worldPosition;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D projectedMap;
      uniform sampler2D maskMap;
      uniform float layerOpacity;
      varying vec4 vProjectedPosition;
      void main() {
        if (vProjectedPosition.w <= 0.0001) discard;
        vec3 ndc = vProjectedPosition.xyz / vProjectedPosition.w;
        if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0 || abs(ndc.z) > 1.0) discard;
        vec2 projectedUv = ndc.xy * 0.5 + 0.5;
        projectedUv.y = 1.0 - projectedUv.y;
        vec4 maskTexel = texture2D(maskMap, projectedUv);
        float maskAlpha = dot(maskTexel.rgb, vec3(0.299, 0.587, 0.114)) * maskTexel.a;
        float alpha = maskAlpha * layerOpacity;
        if (alpha <= 0.01) discard;
        vec4 source = texture2D(projectedMap, projectedUv);
        gl_FragColor = vec4(source.rgb, alpha);
      }
    `,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -16,
    polygonOffsetUnits: -16,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  material.name = 'Liclick Live Local Repaint Fast Preview';
  material.forceSinglePass = true;
  return material;
}

/**
 * Creates a deliberately simple, renderer-only repaint preview. It only applies
 * capture projection + the live mask, so it can remain responsive while the
 * depth-aware ordered material is asynchronously packed and uploaded.
 */
export function createLiveLocalRepaintFastPreview(
  input: CreateFastPreviewInput,
): LiveLocalRepaintFastPreview {
  input.modelGroup.updateMatrixWorld(true);
  const material = createFastPreviewMaterial(input);
  const root = new THREE.Group();
  root.name = 'Liclick Live Local Repaint Fast Preview';
  root.userData.liclickPaintOverlay = true;
  root.userData.liclickLocalRepaintFastPreview = true;
  root.matrixAutoUpdate = false;
  root.visible = false;
  const inverseRoot = input.modelGroup.matrixWorld.clone().invert();
  const meshes = input.meshes.map((target) => {
    const mesh = new THREE.Mesh(target.geometry, material);
    mesh.name = `Liclick Fast Local Repaint - ${target.name || target.uuid}`;
    mesh.userData.liclickPaintOverlay = true;
    mesh.userData.liclickLocalRepaintFastPreview = true;
    mesh.frustumCulled = target.frustumCulled;
    mesh.renderOrder = input.renderOrder;
    mesh.matrix.copy(inverseRoot.clone().multiply(target.matrixWorld));
    mesh.matrixAutoUpdate = false;
    mesh.raycast = () => undefined;
    root.add(mesh);
    return mesh;
  });
  input.modelGroup.add(root);
  return {
    root,
    material,
    meshes,
    sourceKey: input.sourceKey,
    layerId: input.layerId,
  };
}

export function syncLiveLocalRepaintFastPreview(
  preview: LiveLocalRepaintFastPreview,
  input: {
    sourceTexture: THREE.Texture;
    maskTexture: THREE.Texture;
    worldToSourceClip: THREE.Matrix4;
    opacity: number;
    visible: boolean;
  },
) {
  preview.material.uniforms.projectedMap.value = input.sourceTexture;
  preview.material.uniforms.maskMap.value = input.maskTexture;
  preview.material.uniforms.projectorMatrix.value.copy(input.worldToSourceClip);
  preview.material.uniforms.layerOpacity.value = input.opacity;
  const changed = preview.root.visible !== input.visible;
  preview.root.visible = input.visible;
  return changed;
}

export function disposeLiveLocalRepaintFastPreview(
  preview: LiveLocalRepaintFastPreview | undefined,
) {
  if (!preview) return;
  preview.root.removeFromParent();
  preview.meshes.forEach((mesh) => mesh.removeFromParent());
  preview.material.dispose();
}
