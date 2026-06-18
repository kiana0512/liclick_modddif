import * as THREE from 'three';
import type { ProjectionLayerInput } from './projectionTypes';
import { buildProjectionMatrixBundle } from './projectionMath';

const vertexShader = `
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const fragmentShader = `
  uniform sampler2D projectedMap;
  uniform mat4 projectorMatrix;
  uniform float layerOpacity;
  uniform vec3 baseColor;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;

  void main() {
    vec4 projected = projectorMatrix * vec4(vWorldPosition, 1.0);
    vec3 ndc = projected.xyz / projected.w;
    vec2 uv = ndc.xy * 0.5 + 0.5;
    uv.y = 1.0 - uv.y;

    float inX = step(-1.0, ndc.x) * step(ndc.x, 1.0);
    float inY = step(-1.0, ndc.y) * step(ndc.y, 1.0);
    float inZ = step(-1.0, ndc.z) * step(ndc.z, 1.0);
    float inside = inX * inY * inZ;

    vec3 lightDir = normalize(vec3(0.35, 0.7, 0.45));
    float lambert = max(dot(normalize(vWorldNormal), lightDir), 0.0) * 0.45 + 0.55;
    vec4 texel = texture2D(projectedMap, uv);
    vec3 shadedBase = baseColor * lambert;
    vec3 mixedColor = mix(shadedBase, texel.rgb, layerOpacity * inside * texel.a);

    gl_FragColor = vec4(mixedColor, 1.0);
  }
`;

export async function createProjectedLayerMaterial(input: ProjectionLayerInput) {
  const texture = await new THREE.TextureLoader().loadAsync(input.imageUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  return new THREE.ShaderMaterial({
    name: `LiclickProjectedLayer:${input.layerId}`,
    vertexShader,
    fragmentShader,
    uniforms: {
      projectedMap: { value: texture },
      projectorMatrix: { value: buildProjectionMatrixBundle(input.camera).projectorMatrix },
      layerOpacity: { value: input.opacity },
      baseColor: { value: new THREE.Color('#b9a3ff') },
    },
  });
}

export function createDisplayModeMaterial(displayMode: string, selected: boolean, bakedTexture?: THREE.Texture) {
  if (displayMode === 'normal') return new THREE.MeshNormalMaterial();
  if (displayMode === 'wire') {
    return new THREE.MeshStandardMaterial({
      color: '#c4b5fd',
      wireframe: true,
      roughness: 0.8,
      metalness: 0.1,
    });
  }
  if (displayMode === 'flat') {
    return new THREE.MeshBasicMaterial({
      color: bakedTexture ? '#ffffff' : '#d8b4fe',
      map: bakedTexture,
    });
  }

  return new THREE.MeshStandardMaterial({
    color: bakedTexture ? '#ffffff' : '#b9a3ff',
    map: bakedTexture,
    roughness: 0.42,
    metalness: 0.18,
    emissive: selected ? '#3b0764' : '#000000',
    emissiveIntensity: selected ? 0.45 : 0,
  });
}
