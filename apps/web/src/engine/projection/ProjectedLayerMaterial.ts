import * as THREE from 'three';
import type { ProjectionLayerInput } from './projectionTypes';
import { buildProjectionMatrixBundle } from './projectionMath';

const DEFAULT_PREVIEW_COLOR = '#f0f1ee';
const DEFAULT_FLAT_COLOR = '#f4f5f2';
const DEFAULT_WIRE_COLOR = '#e9ebe8';

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
  uniform sampler2D maskMap;
  uniform sampler2D depthMap;
  uniform mat4 projectorMatrix;
  uniform mat4 objectMatrixDelta;
  uniform mat3 objectNormalDelta;
  uniform vec3 projectorPosition;
  uniform float layerOpacity;
  uniform float useMask;
  uniform float useDepthCheck;
  uniform float enableBackfaceCulling;
  uniform float edgeFeather;
  uniform float depthBias;
  uniform float hueShift;
  uniform float saturationShift;
  uniform float lightnessShift;
  uniform vec3 baseColor;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;

  vec3 applyHslAdjustments(vec3 color) {
    float angle = hueShift * 6.28318530718;
    float s = sin(angle);
    float c = cos(angle);
    mat3 yiqToRgb = mat3(
      1.0, 1.0, 1.0,
      0.956, -0.272, -1.106,
      0.621, -0.647, 1.703
    );
    mat3 rgbToYiq = mat3(
      0.299, 0.587, 0.114,
      0.596, -0.274, -0.322,
      0.211, -0.523, 0.312
    );
    vec3 yiq = rgbToYiq * color;
    float i = yiq.y * c - yiq.z * s;
    float q = yiq.y * s + yiq.z * c;
    vec3 shifted = yiqToRgb * vec3(yiq.x, i, q);
    float luma = dot(shifted, vec3(0.299, 0.587, 0.114));
    shifted = mix(vec3(luma), shifted, max(0.0, 1.0 + saturationShift));
    shifted += lightnessShift;
    return clamp(shifted, 0.0, 1.0);
  }

  void main() {
    vec4 captureWorldPosition = objectMatrixDelta * vec4(vWorldPosition, 1.0);
    vec3 captureWorldNormal = normalize(objectNormalDelta * vWorldNormal);
    vec4 projected = projectorMatrix * captureWorldPosition;
    vec3 ndc = projected.xyz / projected.w;
    vec2 uv = ndc.xy * 0.5 + 0.5;
    uv.y = 1.0 - uv.y;

    float inX = step(-1.0, ndc.x) * step(ndc.x, 1.0);
    float inY = step(-1.0, ndc.y) * step(ndc.y, 1.0);
    float inZ = step(-1.0, ndc.z) * step(ndc.z, 1.0);
    float hasW = step(0.0001, projected.w);
    float inside = inX * inY * inZ * hasW;

    float edgeDistance = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    float featherAlpha = smoothstep(0.0, max(edgeFeather, 0.0001), edgeDistance);

    vec3 normal = captureWorldNormal;
    vec3 projectorViewDir = normalize(captureWorldPosition.xyz - projectorPosition);
    float frontFacing = 1.0 - step(-0.02, dot(normal, projectorViewDir));
    float backfaceAlpha = mix(1.0, frontFacing, enableBackfaceCulling);

    vec4 maskTexel = texture2D(maskMap, uv);
    float maskValue = dot(maskTexel.rgb, vec3(0.299, 0.587, 0.114));
    float maskAlpha = mix(1.0, step(0.08, maskValue), useMask);

    float projectedDepth = ndc.z * 0.5 + 0.5;
    float capturedDepth = texture2D(depthMap, uv).r;
    float depthAlpha = mix(1.0, step(projectedDepth - depthBias, capturedDepth + 0.035), useDepthCheck);

    vec3 lightDir = normalize(vec3(0.35, 0.7, 0.45));
    float lambert = max(dot(normal, lightDir), 0.0) * 0.45 + 0.55;
    vec4 texel = texture2D(projectedMap, uv);
    texel.rgb = applyHslAdjustments(texel.rgb);
    float projectionAlpha = layerOpacity * inside * featherAlpha * backfaceAlpha * maskAlpha * depthAlpha * texel.a;
    vec3 shadedBase = baseColor * lambert;
    vec3 mixedColor = mix(shadedBase, texel.rgb, projectionAlpha);

    gl_FragColor = vec4(mixedColor, 1.0);
  }
`;

export async function createProjectedLayerMaterial(input: ProjectionLayerInput) {
  const texture = await new THREE.TextureLoader().loadAsync(input.imageUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  const whitePixel = new Uint8Array([255, 255, 255, 255]);
  const neutralTexture = new THREE.DataTexture(whitePixel, 1, 1, THREE.RGBAFormat);
  neutralTexture.needsUpdate = true;
  const maskTexture = input.maskUrl ? await new THREE.TextureLoader().loadAsync(input.maskUrl) : neutralTexture;
  const depthTexture = input.depthUrl ? await new THREE.TextureLoader().loadAsync(input.depthUrl) : neutralTexture;
  maskTexture.wrapS = THREE.ClampToEdgeWrapping;
  maskTexture.wrapT = THREE.ClampToEdgeWrapping;
  depthTexture.wrapS = THREE.ClampToEdgeWrapping;
  depthTexture.wrapT = THREE.ClampToEdgeWrapping;

  const objectMatrixDelta = new THREE.Matrix4();
  if (input.objectMatrixWorld && input.currentObjectMatrixWorld) {
    objectMatrixDelta
      .fromArray(input.objectMatrixWorld)
      .multiply(new THREE.Matrix4().fromArray(input.currentObjectMatrixWorld).invert());
  }
  const objectNormalDelta = new THREE.Matrix3().getNormalMatrix(objectMatrixDelta);

  return new THREE.ShaderMaterial({
    name: `LiclickProjectedLayer:${input.layerId}`,
    vertexShader,
    fragmentShader,
    uniforms: {
      projectedMap: { value: texture },
      maskMap: { value: maskTexture },
      depthMap: { value: depthTexture },
      projectorMatrix: { value: buildProjectionMatrixBundle(input.camera).projectorMatrix },
      objectMatrixDelta: { value: objectMatrixDelta },
      objectNormalDelta: { value: objectNormalDelta },
      projectorPosition: { value: new THREE.Vector3().fromArray(input.camera.position) },
      layerOpacity: { value: input.opacity },
      useMask: { value: input.useMask && input.maskUrl ? 1 : 0 },
      useDepthCheck: { value: input.useDepthCheck && input.depthUrl ? 1 : 0 },
      enableBackfaceCulling: { value: input.enableBackfaceCulling === false ? 0 : 1 },
      edgeFeather: { value: input.edgeFeather ?? 0.035 },
      depthBias: { value: input.depthBias ?? 0.025 },
      hueShift: { value: input.hue ?? 0 },
      saturationShift: { value: input.saturation ?? 0 },
      lightnessShift: { value: input.lightness ?? 0 },
      baseColor: { value: new THREE.Color(DEFAULT_PREVIEW_COLOR) },
    },
  });
}

export function createDisplayModeMaterial(displayMode: string, selected: boolean, bakedTexture?: THREE.Texture) {
  if (bakedTexture) {
    bakedTexture.colorSpace = THREE.SRGBColorSpace;
    bakedTexture.needsUpdate = true;
  }
  if (displayMode === 'normal') return new THREE.MeshNormalMaterial();
  if (displayMode === 'wire') {
    return new THREE.MeshStandardMaterial({
      color: DEFAULT_WIRE_COLOR,
      wireframe: true,
      roughness: 0.9,
      metalness: 0,
    });
  }
  if (displayMode === 'flat') {
    return new THREE.MeshStandardMaterial({
      color: DEFAULT_FLAT_COLOR,
      roughness: 0.96,
      metalness: 0,
      emissive: '#ffffff',
      emissiveIntensity: 0.04,
    });
  }

  return new THREE.MeshStandardMaterial({
    color: bakedTexture ? '#ffffff' : DEFAULT_PREVIEW_COLOR,
    map: bakedTexture,
    roughness: 0.58,
    metalness: 0,
    emissive: selected ? '#3b0764' : '#000000',
    emissiveIntensity: selected ? 0.2 : 0,
  });
}

function prepareSinglePreviewMaterial(material: THREE.Material, selected: boolean, bakedTexture?: THREE.Texture) {
  if (bakedTexture) return createDisplayModeMaterial('pbr', selected, bakedTexture);
  if (material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhysicalMaterial) {
    if (material.map) {
      material.map.colorSpace = THREE.SRGBColorSpace;
      material.map.needsUpdate = true;
    }
    if (!material.map) {
      material.color.set(DEFAULT_PREVIEW_COLOR);
    }
    material.roughness = Number.isFinite(material.roughness) ? Math.max(0.46, material.roughness) : 0.58;
    material.metalness = Number.isFinite(material.metalness) ? Math.min(0.25, material.metalness) : 0;
    material.needsUpdate = true;
    return material;
  }
  return new THREE.MeshStandardMaterial({
    color: DEFAULT_PREVIEW_COLOR,
    roughness: 0.58,
    metalness: 0,
  });
}

export function createPbrPreviewMaterial(
  originalMaterial: THREE.Material | THREE.Material[] | undefined,
  selected: boolean,
  bakedTexture?: THREE.Texture,
) {
  if (!originalMaterial) return createDisplayModeMaterial('pbr', selected, bakedTexture);
  return Array.isArray(originalMaterial)
    ? originalMaterial.map((material) => prepareSinglePreviewMaterial(material, selected, bakedTexture))
    : prepareSinglePreviewMaterial(originalMaterial, selected, bakedTexture);
}
