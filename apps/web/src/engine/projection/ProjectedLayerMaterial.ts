import * as THREE from 'three';
import type { ProjectionLayerInput, ProjectionLayerStackInput } from './projectionTypes';
import { buildProjectionMatrixBundle } from './projectionMath';

const DEFAULT_PREVIEW_COLOR = '#f0f1ee';
const DEFAULT_FLAT_COLOR = '#f4f5f2';
const DEFAULT_WIRE_COLOR = '#e9ebe8';
const GENERATED_MATERIAL_FLAG = 'liclickGeneratedMaterial';
const DISPOSABLE_TEXTURES_KEY = 'liclickDisposableTextures';
const DISPOSED_MATERIAL_FLAG = 'liclickDisposedMaterial';
const BACKFACE_DOT_LIMIT = 0.42;
const VIEW_CONFIDENCE_MIN = 0.06;
const VIEW_CONFIDENCE_FULL = 0.5;

const vertexShader = `
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vUv;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const fragmentShader = `
  uniform sampler2D projectedMap;
  uniform sampler2D baseMap;
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
  uniform float useBaseMap;
  uniform vec3 baseColor;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vUv;

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

  float unpackDepth(vec4 rgbaDepth) {
    const vec4 bitShift = vec4(
      1.0 / (256.0 * 256.0 * 256.0),
      1.0 / (256.0 * 256.0),
      1.0 / 256.0,
      1.0
    );
    return dot(rgbaDepth, bitShift);
  }

  vec3 linearToSrgb(vec3 color) {
    vec3 cutoff = step(color, vec3(0.0031308));
    vec3 lower = color * 12.92;
    vec3 higher = 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(higher, lower, cutoff);
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
    float normalViewDot = dot(normal, projectorViewDir);
    float frontFacing = 1.0 - step(${BACKFACE_DOT_LIMIT.toFixed(2)}, normalViewDot);
    float backfaceAlpha = mix(1.0, frontFacing, enableBackfaceCulling);

    vec4 maskTexel = texture2D(maskMap, uv);
    float maskValue = dot(maskTexel.rgb, vec3(0.299, 0.587, 0.114));
    float maskAlpha = mix(1.0, step(0.08, maskValue), useMask);

    float projectedDepth = ndc.z * 0.5 + 0.5;
    float capturedDepth = unpackDepth(texture2D(depthMap, uv));
    float depthAlpha = mix(1.0, step(projectedDepth - depthBias, capturedDepth + 0.01), useDepthCheck);

    vec3 lightDir = normalize(vec3(0.35, 0.7, 0.45));
    float lambert = max(dot(normal, lightDir), 0.0) * 0.2 + 0.8;
    vec4 texel = texture2D(projectedMap, uv);
    texel.rgb = applyHslAdjustments(texel.rgb);
    float sourceAlpha = smoothstep(0.015, 0.08, texel.a);
    float projectionAlpha = layerOpacity * inside * featherAlpha * backfaceAlpha * maskAlpha * depthAlpha * sourceAlpha;
    vec3 baseTexel = texture2D(baseMap, vUv).rgb;
    vec3 baseSurfaceColor = mix(baseColor, baseTexel, useBaseMap);
    vec3 shadedBase = baseSurfaceColor * lambert;
    vec3 mixedColor = mix(shadedBase, texel.rgb, projectionAlpha);

    gl_FragColor = vec4(linearToSrgb(clamp(mixedColor, 0.0, 1.0)), 1.0);
  }
`;

function buildStackFragmentShader(layerCount: number) {
  const uniformDeclarations = Array.from({ length: layerCount }, (_, index) => `
  uniform sampler2D projectedMap${index};
  uniform sampler2D maskMap${index};
  uniform sampler2D depthMap${index};
  uniform mat4 projectorMatrix${index};
  uniform mat4 objectMatrixDelta${index};
  uniform mat3 objectNormalDelta${index};
  uniform vec3 projectorPosition${index};
  uniform float layerOpacity${index};
  uniform float useMask${index};
  uniform float useDepthCheck${index};
  uniform float hueShift${index};
  uniform float saturationShift${index};
  uniform float lightnessShift${index};
  uniform float layerPriority${index};
`).join('');

  const layerEvaluations = Array.from({ length: layerCount }, (_, index) => `
    {
      vec4 captureWorldPosition = objectMatrixDelta${index} * vec4(vWorldPosition, 1.0);
      vec3 captureWorldNormal = normalize(objectNormalDelta${index} * vWorldNormal);
      vec4 projected = projectorMatrix${index} * captureWorldPosition;
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
      vec3 projectorViewDir = normalize(captureWorldPosition.xyz - projectorPosition${index});
      float normalViewDot = dot(normal, projectorViewDir);
      float frontFacing = 1.0 - step(${BACKFACE_DOT_LIMIT.toFixed(2)}, normalViewDot);
      float backfaceAlpha = mix(1.0, frontFacing, enableBackfaceCulling);
      float viewConfidence = smoothstep(${VIEW_CONFIDENCE_MIN.toFixed(2)}, ${VIEW_CONFIDENCE_FULL.toFixed(2)}, -normalViewDot);

      vec4 maskTexel = texture2D(maskMap${index}, uv);
      float maskValue = dot(maskTexel.rgb, vec3(0.299, 0.587, 0.114));
      float maskAlpha = mix(1.0, step(0.08, maskValue), useMask${index});

      float projectedDepth = ndc.z * 0.5 + 0.5;
      float capturedDepth = unpackDepth(texture2D(depthMap${index}, uv));
      float depthAlpha = mix(1.0, step(projectedDepth - depthBias, capturedDepth + 0.01), useDepthCheck${index});

      vec4 texel = texture2D(projectedMap${index}, uv);
      texel.rgb = applyHslAdjustments(texel.rgb, hueShift${index}, saturationShift${index}, lightnessShift${index});
      float sourceAlpha = smoothstep(0.015, 0.08, texel.a);
      float validAlpha = layerOpacity${index} * inside * featherAlpha * backfaceAlpha * maskAlpha * depthAlpha * sourceAlpha;
      float candidateScore = validAlpha * (0.15 + viewConfidence * 0.85) + layerPriority${index};
      if (validAlpha > 0.02 && candidateScore > bestScore) {
        bestScore = candidateScore;
        bestAlpha = validAlpha;
        bestColor = texel.rgb;
      }
    }
`).join('');

  return `
  ${uniformDeclarations}
  uniform float enableBackfaceCulling;
  uniform float edgeFeather;
  uniform float depthBias;
  uniform vec3 baseColor;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vUv;

  vec3 applyHslAdjustments(vec3 color, float hueShift, float saturationShift, float lightnessShift) {
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

  float unpackDepth(vec4 rgbaDepth) {
    const vec4 bitShift = vec4(
      1.0 / (256.0 * 256.0 * 256.0),
      1.0 / (256.0 * 256.0),
      1.0 / 256.0,
      1.0
    );
    return dot(rgbaDepth, bitShift);
  }

  vec3 linearToSrgb(vec3 color) {
    vec3 cutoff = step(color, vec3(0.0031308));
    vec3 lower = color * 12.92;
    vec3 higher = 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(higher, lower, cutoff);
  }

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 lightDir = normalize(vec3(0.35, 0.7, 0.45));
    float lambert = max(dot(normal, lightDir), 0.0) * 0.2 + 0.8;
    vec3 shadedBase = baseColor * lambert;
    vec3 bestColor = shadedBase;
    float bestAlpha = 0.0;
    float bestScore = 0.0;

    ${layerEvaluations}

    vec3 mixedColor = mix(shadedBase, bestColor, clamp(bestAlpha, 0.0, 1.0));
    gl_FragColor = vec4(linearToSrgb(clamp(mixedColor, 0.0, 1.0)), 1.0);
  }
`;
}

export async function createProjectedLayerMaterial(input: ProjectionLayerInput) {
  const texture = await new THREE.TextureLoader().loadAsync(input.imageUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;

  const whitePixel = new Uint8Array([255, 255, 255, 255]);
  const neutralTexture = new THREE.DataTexture(whitePixel, 1, 1, THREE.RGBAFormat);
  neutralTexture.needsUpdate = true;
  const maskTexture = input.maskUrl ? await new THREE.TextureLoader().loadAsync(input.maskUrl) : neutralTexture;
  const depthTexture = input.depthUrl ? await new THREE.TextureLoader().loadAsync(input.depthUrl) : neutralTexture;
  const baseTexture = input.baseTexture ?? neutralTexture;
  if (input.baseTexture) {
    input.baseTexture.colorSpace = THREE.SRGBColorSpace;
    input.baseTexture.flipY = false;
    input.baseTexture.wrapS = THREE.ClampToEdgeWrapping;
    input.baseTexture.wrapT = THREE.ClampToEdgeWrapping;
    input.baseTexture.minFilter = THREE.LinearMipmapLinearFilter;
    input.baseTexture.magFilter = THREE.LinearFilter;
    input.baseTexture.generateMipmaps = true;
    input.baseTexture.needsUpdate = true;
  }
  maskTexture.flipY = false;
  depthTexture.flipY = false;
  maskTexture.wrapS = THREE.ClampToEdgeWrapping;
  maskTexture.wrapT = THREE.ClampToEdgeWrapping;
  depthTexture.wrapS = THREE.ClampToEdgeWrapping;
  depthTexture.wrapT = THREE.ClampToEdgeWrapping;
  maskTexture.minFilter = THREE.LinearFilter;
  maskTexture.magFilter = THREE.LinearFilter;
  depthTexture.minFilter = THREE.NearestFilter;
  depthTexture.magFilter = THREE.NearestFilter;

  const objectMatrixDelta = new THREE.Matrix4();
  if (input.objectMatrixWorld && input.currentObjectMatrixWorld) {
    objectMatrixDelta
      .fromArray(input.objectMatrixWorld)
      .multiply(new THREE.Matrix4().fromArray(input.currentObjectMatrixWorld).invert());
  }
  const objectNormalDelta = new THREE.Matrix3().getNormalMatrix(objectMatrixDelta);
  const material = new THREE.ShaderMaterial({
    name: `LiclickProjectedLayer:${input.layerId}`,
    vertexShader,
    fragmentShader,
    uniforms: {
      projectedMap: { value: texture },
      baseMap: { value: baseTexture },
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
      useBaseMap: { value: input.baseTexture ? 1 : 0 },
    },
  });
  material.userData[GENERATED_MATERIAL_FLAG] = true;
  material.userData[DISPOSABLE_TEXTURES_KEY] = [...new Set([texture, maskTexture, depthTexture])];
  return material;
}

function stableLayerPriority(layerId: string) {
  let hash = 2166136261;
  for (let index = 0; index < layerId.length; index += 1) {
    hash ^= layerId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) * 0.00000001;
}

async function loadProjectedTexture(imageUrl: string, colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace) {
  const texture = await new THREE.TextureLoader().loadAsync(imageUrl);
  texture.colorSpace = colorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  return texture;
}

export async function createProjectedLayerStackMaterial(input: ProjectionLayerStackInput) {
  const layers = input.layers.filter((layer) => layer.visible && layer.imageUrl && layer.camera);
  if (layers.length === 0) return undefined;
  if (layers.length === 1) {
    const [layer] = layers;
    return createProjectedLayerMaterial({
      ...input,
      layerId: layer.layerId,
      imageUrl: layer.imageUrl,
      maskUrl: layer.maskUrl,
      depthUrl: layer.depthUrl,
      camera: layer.camera,
      objectMatrixWorld: layer.objectMatrixWorld,
      opacity: layer.opacity,
      visible: layer.visible,
      hue: layer.hue,
      saturation: layer.saturation,
      lightness: layer.lightness,
      useMask: layer.useMask,
      useDepthCheck: layer.useDepthCheck,
    });
  }

  const whitePixel = new Uint8Array([255, 255, 255, 255]);
  const neutralTexture = new THREE.DataTexture(whitePixel, 1, 1, THREE.RGBAFormat);
  neutralTexture.needsUpdate = true;
  neutralTexture.flipY = false;

  const uniforms: Record<string, { value: unknown }> = {
    enableBackfaceCulling: { value: input.enableBackfaceCulling === false ? 0 : 1 },
    edgeFeather: { value: input.edgeFeather ?? 0.004 },
    depthBias: { value: input.depthBias ?? 0.025 },
    baseColor: { value: new THREE.Color(DEFAULT_PREVIEW_COLOR) },
  };
  const disposableTextures: THREE.Texture[] = [neutralTexture];

  await Promise.all(
    layers.map(async (layer, index) => {
      const texture = await loadProjectedTexture(layer.imageUrl);
      const maskTexture = layer.maskUrl ? await loadProjectedTexture(layer.maskUrl, THREE.NoColorSpace) : neutralTexture;
      const depthTexture = layer.depthUrl ? await loadProjectedTexture(layer.depthUrl, THREE.NoColorSpace) : neutralTexture;
      if (layer.maskUrl) {
        maskTexture.minFilter = THREE.LinearFilter;
        maskTexture.magFilter = THREE.LinearFilter;
      }
      if (layer.depthUrl) {
        depthTexture.minFilter = THREE.NearestFilter;
        depthTexture.magFilter = THREE.NearestFilter;
      }

      const objectMatrixDelta = new THREE.Matrix4();
      if (layer.objectMatrixWorld && input.currentObjectMatrixWorld) {
        objectMatrixDelta
          .fromArray(layer.objectMatrixWorld)
          .multiply(new THREE.Matrix4().fromArray(input.currentObjectMatrixWorld).invert());
      }
      const objectNormalDelta = new THREE.Matrix3().getNormalMatrix(objectMatrixDelta);

      uniforms[`projectedMap${index}`] = { value: texture };
      uniforms[`maskMap${index}`] = { value: maskTexture };
      uniforms[`depthMap${index}`] = { value: depthTexture };
      uniforms[`projectorMatrix${index}`] = { value: buildProjectionMatrixBundle(layer.camera).projectorMatrix };
      uniforms[`objectMatrixDelta${index}`] = { value: objectMatrixDelta };
      uniforms[`objectNormalDelta${index}`] = { value: objectNormalDelta };
      uniforms[`projectorPosition${index}`] = { value: new THREE.Vector3().fromArray(layer.camera.position) };
      uniforms[`layerOpacity${index}`] = { value: layer.opacity };
      uniforms[`useMask${index}`] = { value: layer.useMask && layer.maskUrl ? 1 : 0 };
      uniforms[`useDepthCheck${index}`] = { value: layer.useDepthCheck && layer.depthUrl ? 1 : 0 };
      uniforms[`hueShift${index}`] = { value: layer.hue ?? 0 };
      uniforms[`saturationShift${index}`] = { value: layer.saturation ?? 0 };
      uniforms[`lightnessShift${index}`] = { value: layer.lightness ?? 0 };
      uniforms[`layerPriority${index}`] = { value: stableLayerPriority(layer.layerId) };
      disposableTextures.push(texture, maskTexture, depthTexture);
    }),
  );

  const material = new THREE.ShaderMaterial({
    name: `LiclickProjectedLayerStack:${layers.map((layer) => layer.layerId).join(',')}`,
    vertexShader,
    fragmentShader: buildStackFragmentShader(layers.length),
    uniforms,
  });
  material.userData[GENERATED_MATERIAL_FLAG] = true;
  material.userData[DISPOSABLE_TEXTURES_KEY] = [...new Set(disposableTextures)];
  return material;
}

function markGeneratedMaterial<T extends THREE.Material>(material: T) {
  material.userData[GENERATED_MATERIAL_FLAG] = true;
  return material;
}

function disposeGeneratedMaterial(material: THREE.Material) {
  if (!material.userData[GENERATED_MATERIAL_FLAG]) return;
  if (material.userData[DISPOSED_MATERIAL_FLAG]) return;
  material.userData[DISPOSED_MATERIAL_FLAG] = true;
  const textures = material.userData[DISPOSABLE_TEXTURES_KEY] as THREE.Texture[] | undefined;
  textures?.forEach((texture) => texture.dispose());
  material.dispose();
}

export function disposeGeneratedMaterialTree(material: THREE.Material | THREE.Material[] | undefined) {
  if (Array.isArray(material)) {
    material.forEach(disposeGeneratedMaterial);
    return;
  }
  if (material) disposeGeneratedMaterial(material);
}

export function createDisplayModeMaterial(displayMode: string, selected: boolean, bakedTexture?: THREE.Texture) {
  if (bakedTexture) {
    bakedTexture.colorSpace = THREE.SRGBColorSpace;
    bakedTexture.wrapS = THREE.ClampToEdgeWrapping;
    bakedTexture.wrapT = THREE.ClampToEdgeWrapping;
    bakedTexture.minFilter = THREE.LinearMipmapLinearFilter;
    bakedTexture.magFilter = THREE.LinearFilter;
    bakedTexture.generateMipmaps = true;
    bakedTexture.anisotropy = 8;
    bakedTexture.needsUpdate = true;
  }
  if (displayMode === 'normal') return markGeneratedMaterial(new THREE.MeshNormalMaterial());
  if (displayMode === 'wire') {
    return markGeneratedMaterial(new THREE.MeshStandardMaterial({
      color: DEFAULT_WIRE_COLOR,
      wireframe: true,
      roughness: 0.9,
      metalness: 0,
    }));
  }
  if (displayMode === 'flat') {
    if (bakedTexture) {
      return markGeneratedMaterial(new THREE.MeshStandardMaterial({
        color: '#ffffff',
        map: bakedTexture,
        roughness: 0.92,
        metalness: 0,
        emissive: '#ffffff',
        emissiveMap: bakedTexture,
        emissiveIntensity: 0.18,
      }));
    }
    const material = markGeneratedMaterial(new THREE.MeshStandardMaterial({
      color: DEFAULT_FLAT_COLOR,
      roughness: 0.96,
      metalness: 0,
      emissive: '#ffffff',
      emissiveIntensity: 0.04,
    }));
    return material;
  }

  const material = markGeneratedMaterial(new THREE.MeshStandardMaterial({
    color: bakedTexture ? '#ffffff' : DEFAULT_PREVIEW_COLOR,
    roughness: 0.58,
    metalness: 0,
    emissive: !bakedTexture && selected ? '#3b0764' : '#000000',
    emissiveIntensity: !bakedTexture && selected ? 0.2 : 0,
  }));
  if (bakedTexture) material.map = bakedTexture;
  return material;
}

function prepareSinglePreviewMaterial(material: THREE.Material, bakedTexture?: THREE.Texture) {
  if (bakedTexture) {
    return markGeneratedMaterial(new THREE.MeshStandardMaterial({
      color: '#ffffff',
      map: bakedTexture,
      roughness: material instanceof THREE.MeshStandardMaterial ? Math.max(0.42, material.roughness) : 0.58,
      metalness: material instanceof THREE.MeshStandardMaterial ? Math.min(0.18, material.metalness) : 0,
      emissive: '#000000',
      emissiveIntensity: 0,
    }));
  }
  if (material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhysicalMaterial) {
    const previewMaterial = material.clone();
    if (previewMaterial.map) {
      previewMaterial.map.colorSpace = THREE.SRGBColorSpace;
      previewMaterial.map.needsUpdate = true;
    }
    if (!previewMaterial.map) {
      previewMaterial.color.set(DEFAULT_PREVIEW_COLOR);
    }
    previewMaterial.roughness = Number.isFinite(previewMaterial.roughness) ? Math.max(0.46, previewMaterial.roughness) : 0.58;
    previewMaterial.metalness = Number.isFinite(previewMaterial.metalness) ? Math.min(0.25, previewMaterial.metalness) : 0;
    previewMaterial.needsUpdate = true;
    return markGeneratedMaterial(previewMaterial);
  }
  if (material instanceof THREE.MeshBasicMaterial && material.map) {
    material.map.colorSpace = THREE.SRGBColorSpace;
    material.map.needsUpdate = true;
    return markGeneratedMaterial(new THREE.MeshStandardMaterial({
      color: '#ffffff',
      map: material.map,
      roughness: 0.58,
      metalness: 0,
    }));
  }
  return markGeneratedMaterial(new THREE.MeshStandardMaterial({
    color: DEFAULT_PREVIEW_COLOR,
    roughness: 0.58,
    metalness: 0,
  }));
}

export function createPbrPreviewMaterial(
  originalMaterial: THREE.Material | THREE.Material[] | undefined,
  selected: boolean,
  bakedTexture?: THREE.Texture,
) {
  if (!originalMaterial) return createDisplayModeMaterial('pbr', selected, bakedTexture);
  return Array.isArray(originalMaterial)
    ? originalMaterial.map((material) => prepareSinglePreviewMaterial(material, bakedTexture))
    : prepareSinglePreviewMaterial(originalMaterial, bakedTexture);
}
