import * as THREE from 'three';
import type {
  ProjectionLayerInput,
  ProjectionLayerStackInput,
  ProjectionPreviewLighting,
} from './projectionTypes';
import { buildProjectionMatrixBundle } from './projectionMath';
import {
  getLiveProjectedCanvasTexture,
  isLiveProjectedCanvasUrl,
} from './liveProjectedCanvasTextureRegistry';

const DEFAULT_PREVIEW_COLOR = '#f0f1ee';
const DEFAULT_FLAT_COLOR = '#f4f5f2';
const DEFAULT_WIRE_COLOR = '#e9ebe8';
const GENERATED_MATERIAL_FLAG = 'liclickGeneratedMaterial';
const DISPOSABLE_TEXTURES_KEY = 'liclickDisposableTextures';
const DISPOSED_MATERIAL_FLAG = 'liclickDisposedMaterial';
const PROJECTED_LAYER_STACK_STATE_KEY = 'liclickProjectedLayerStackState';
const UV_OVERLAY_PREVIEW_MATERIAL_FLAG = 'liclickUvOverlayPreviewMaterial';
const PROJECTED_LAYER_SAMPLER_BUDGET_KEY = 'liclickProjectedLayerSamplerBudget';
export const PROJECTED_LAYER_MATERIAL_USER_DATA_KEY = 'liclickProjectedLayerProjectionData';
export type ProjectedLayerProjectionData = {
  layers: Array<{
    objectMatrixWorld?: number[];
    objectMatrixDeltaUniform: string;
    objectNormalDeltaUniform: string;
  }>;
};

/**
 * Keeps capture-space projection coordinates attached to the model while its
 * root transform changes. The shader evaluates the current world position, so
 * it must first be mapped back into the world space used when the layer was
 * captured: captureObjectMatrix * inverse(currentObjectMatrix).
 */
export function syncProjectedLayerMaterialProjection(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const currentObjectMatrixInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const matrixDelta = new THREE.Matrix4();
  const normalDelta = new THREE.Matrix3();

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      const projectionData = material.userData[PROJECTED_LAYER_MATERIAL_USER_DATA_KEY] as
        | ProjectedLayerProjectionData
        | undefined;
      if (!projectionData?.layers?.length || !(material instanceof THREE.ShaderMaterial)) continue;

      for (const layer of projectionData.layers) {
        if (layer.objectMatrixWorld) {
          matrixDelta.fromArray(layer.objectMatrixWorld).multiply(currentObjectMatrixInverse);
        } else {
          matrixDelta.identity();
        }
        normalDelta.getNormalMatrix(matrixDelta);

        const matrixUniform = material.uniforms[layer.objectMatrixDeltaUniform];
        const normalUniform = material.uniforms[layer.objectNormalDeltaUniform];
        if (matrixUniform?.value instanceof THREE.Matrix4) {
          matrixUniform.value.copy(matrixDelta);
        } else if (matrixUniform) {
          matrixUniform.value = matrixDelta.clone();
        }
        if (normalUniform?.value instanceof THREE.Matrix3) {
          normalUniform.value.copy(normalDelta);
        } else if (normalUniform) {
          normalUniform.value = normalDelta.clone();
        }
      }
    }
  });
}
const NDV_HARD_REJECT = -0.35;
const NDV_COVERAGE_START = -0.25;
const NDV_COVERAGE_END = 0.08;
const NDV_QUALITY_START = 0.02;
const NDV_QUALITY_END = 0.25;
const BASE_ANGLE_GAMMA = 4;
const MAX_STRENGTH_FOR_ANGLE = 3;
const BLEND_POWER = 4;
const RESIDUAL_MIX = 0.05;
const DOMINANT_QUALITY_RATIO = 1.18;
const DOMINANT_QUALITY_MARGIN = 0.035;
const COVERAGE_THRESHOLD = 0.02;
const QUALITY_FLOOR_FROM_COVERAGE = 0.08;
const DEPTH_EPSILON = 0.08;
const IMAGE_COVERAGE_EDGE_FADE = 0.015;
const IMAGE_QUALITY_EDGE_FADE = 0.035;
const DEFAULT_PREVIEW_LIGHTING: ProjectionPreviewLighting = {
  enabled: true,
  exposure: 1,
  ambientIntensity: 0.5,
  keyLightIntensity: 1.22,
  keyLightDirection: [0.35, 0.7, 0.45],
};

type ProjectedLayerUniformBinding = {
  layerId: string;
  imageUrl: string;
  projectedMapUniform: string;
  opacityUniform: string;
  strengthUniform: string;
  hueUniform: string;
  saturationUniform: string;
  lightnessUniform: string;
};

type ProjectedLayerMaterialState = {
  signature: string;
  bindings: ProjectedLayerUniformBinding[];
  usesTextureArrays?: boolean;
};

export type ProjectedLayerSamplerBudget = {
  required: number;
  available: number;
  fixed: number;
  projected: number;
  masks: number;
  depths: number;
  withinBudget: boolean;
};

const SINGLE_LAYER_FIXED_SAMPLERS = 7;

type ProjectedLayerSamplerFeatures = {
  useBaseMap?: boolean;
  useBaseRenderedColorMaskMap?: boolean;
  useUvOverlayMap?: boolean;
  useTopUvOverlayMap?: boolean;
  useTextureArrays?: boolean;
};

function normalizeSamplerFeatures(features: ProjectedLayerSamplerFeatures = {}) {
  const useBaseMap = features.useBaseMap === true;
  return {
    useBaseMap,
    useBaseRenderedColorMaskMap: useBaseMap && features.useBaseRenderedColorMaskMap === true,
    useUvOverlayMap: features.useUvOverlayMap === true,
    useTopUvOverlayMap: features.useTopUvOverlayMap === true,
    useTextureArrays: features.useTextureArrays === true,
  };
}

export function getProjectedLayerSamplerBudget(
  layers: ProjectionLayerStackInput['layers'],
  available: number,
  features: ProjectedLayerSamplerFeatures = {},
): ProjectedLayerSamplerBudget {
  const renderableLayers = layers.filter((layer) => layer.imageUrl && layer.camera);
  const projected = renderableLayers.length;
  const maskLayers = renderableLayers.filter((layer) => layer.useMask && layer.maskUrl);
  const depthLayers = renderableLayers.filter((layer) => layer.useDepthCheck && layer.depthUrl);
  const normalizedFeatures = normalizeSamplerFeatures(features);
  const stackFixed =
    Number(normalizedFeatures.useBaseMap) +
    Number(normalizedFeatures.useBaseRenderedColorMaskMap) +
    Number(normalizedFeatures.useUvOverlayMap) +
    Number(normalizedFeatures.useTopUvOverlayMap);
  const fixed =
    projected === 0
      ? 0
      : projected === 1
        ? SINGLE_LAYER_FIXED_SAMPLERS - 1
        : stackFixed;
  const masks =
    projected === 1
      ? 0
      : normalizedFeatures.useTextureArrays
        ? maskLayers.filter((layer) => isLiveProjectedCanvasUrl(layer.maskUrl)).length +
          Number(maskLayers.some((layer) => !isLiveProjectedCanvasUrl(layer.maskUrl)))
        : maskLayers.length;
  const depths =
    projected === 1
      ? 0
      : normalizedFeatures.useTextureArrays
        ? depthLayers.filter((layer) => isLiveProjectedCanvasUrl(layer.depthUrl)).length +
          Number(depthLayers.some((layer) => !isLiveProjectedCanvasUrl(layer.depthUrl)))
        : depthLayers.length;
  const projectedSamplers =
    projected > 1 && normalizedFeatures.useTextureArrays
      ? renderableLayers.filter((layer) => isLiveProjectedCanvasUrl(layer.imageUrl)).length +
        Number(renderableLayers.some((layer) => !isLiveProjectedCanvasUrl(layer.imageUrl)))
      : projected;
  const required = fixed + projectedSamplers + masks + depths;
  return {
    required,
    available,
    fixed,
    projected: projectedSamplers,
    masks,
    depths,
    withinBudget: required <= available,
  };
}

export class ProjectedLayerSamplerBudgetError extends Error {
  readonly budget: ProjectedLayerSamplerBudget;

  constructor(budget: ProjectedLayerSamplerBudget) {
    super(
      `Projected layer preview requires ${budget.required} fragment texture units; this device exposes ${budget.available}.`,
    );
    this.name = 'ProjectedLayerSamplerBudgetError';
    this.budget = budget;
  }
}

const PREPARED_TEXTURE_PROFILE_KEY = 'liclickPreparedTextureProfile';
const UV_OVERLAY_TEXTURE_PROFILE = 'uv-overlay-v3';
const BASE_PREVIEW_TEXTURE_PROFILE = 'base-preview-v2';

const vertexShader = `
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vUv;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    mat3 viewToWorldNormal = mat3(
      viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0],
      viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1],
      viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]
    );
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(viewToWorldNormal * normalMatrix * normal);
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const fragmentShader = `
  uniform sampler2D projectedMap;
  uniform sampler2D baseMap;
  uniform sampler2D uvOverlayMap;
  uniform sampler2D topUvOverlayMap;
  uniform sampler2D maskMap;
  uniform sampler2D depthMap;
  uniform mat4 projectorMatrix;
  uniform mat4 objectMatrixDelta;
  uniform mat3 objectNormalDelta;
  uniform vec3 projectorPosition;
  uniform float layerOpacity;
  uniform float layerStrength;
  uniform float projectedIsRenderedColor;
  uniform float projectedBlendModeOverlay;
  uniform float projectedCompositeUnderlay;
  uniform float useMask;
  uniform float maskUsesUv;
  uniform float useDepthCheck;
  uniform float enableBackfaceCulling;
  uniform float edgeFeather;
  uniform float depthBias;
  uniform float hueShift;
  uniform float saturationShift;
  uniform float lightnessShift;
  uniform float uvOverlayHueShift;
  uniform float uvOverlaySaturationShift;
  uniform float uvOverlayLightnessShift;
  uniform float useBaseMap;
  uniform sampler2D baseRenderedColorMaskMap;
  uniform float useBaseRenderedColorMaskMap;
  uniform float useUvOverlayMap;
  uniform float useTopUvOverlayMap;
  uniform float topUvOverlayOpacity;
  uniform float topUvOverlayRenderedColor;
  uniform float topUvOverlayHueShift;
  uniform float topUvOverlaySaturationShift;
  uniform float topUvOverlayLightnessShift;
  uniform float previewLightingEnabled;
  uniform float previewExposure;
  uniform float ambientLightIntensity;
  uniform float keyLightIntensity;
  uniform vec3 keyLightDirection;
  uniform vec3 baseColor;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vUv;

  vec3 linearToSrgb(vec3 color) {
    vec3 low = color * 12.92;
    vec3 high = 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(low, high, step(vec3(0.0031308), color));
  }

  vec3 srgbToLinear(vec3 color) {
    vec3 low = color / 12.92;
    vec3 high = pow(max((color + 0.055) / 1.055, vec3(0.0)), vec3(2.4));
    return mix(low, high, step(vec3(0.04045), color));
  }

  vec3 rgbToHsv(vec3 color) {
    vec4 k = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(color.bg, k.wz), vec4(color.gb, k.xy), step(color.b, color.g));
    vec4 q = mix(vec4(p.xyw, color.r), vec4(color.r, p.yzx), step(p.x, color.r));
    float delta = q.x - min(q.w, q.y);
    float epsilon = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * delta + epsilon)), delta / (q.x + epsilon), q.x);
  }

  vec3 hsvToRgb(vec3 hsv) {
    vec3 channels = abs(fract(hsv.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return hsv.z * mix(vec3(1.0), clamp(channels - 1.0, 0.0, 1.0), hsv.y);
  }

  vec3 applyHsvAdjustments(vec3 color, float hue, float saturation, float lightness) {
    if (abs(hue) < 0.0001 && abs(saturation) < 0.0001 && abs(lightness) < 0.0001) {
      return color;
    }
    vec3 hsv = rgbToHsv(linearToSrgb(clamp(color, 0.0, 1.0)));
    hsv.x = mod(hsv.x + hue + 1.0, 1.0);
    hsv.y = clamp(hsv.y + saturation, 0.0, 1.0);
    // This uniform keeps its legacy name for saved-project compatibility, but
    // the UI control is HSV Value and must preserve hue and saturation.
    hsv.z = clamp(hsv.z + lightness, 0.0, 1.0);
    return srgbToLinear(hsvToRgb(hsv));
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

  float computeAngleWeight(float ndv, float strength) {
    float strengthClamped = clamp(strength, 0.25, ${MAX_STRENGTH_FOR_ANGLE.toFixed(1)});
    float gamma = ${BASE_ANGLE_GAMMA.toFixed(1)} / strengthClamped;
    float frontFade = smoothstep(${NDV_QUALITY_START.toFixed(2)}, ${NDV_QUALITY_END.toFixed(2)}, ndv);
    return frontFade * pow(clamp(ndv, 0.0, 1.0), gamma);
  }

  float computeImageEdgeFade(vec2 uv, float edge) {
    float edgeDistance = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    return smoothstep(0.0, edge, edgeDistance);
  }

  float computePreviewLight(vec3 normal) {
    vec3 lightDir = normalize(keyLightDirection);
    float diffuse = max(dot(normal, lightDir), 0.0);
    float lit = clamp(ambientLightIntensity + diffuse * keyLightIntensity * 0.55, 0.0, 2.0);
    return mix(1.0, lit, previewLightingEnabled);
  }

  vec3 computeProjectionEmptyPreviewColor(vec3 baseSurfaceColor) {
    // Keep uncovered texels visually distinct from actual projected content.
    // This is display-only and does not alter the source or baked resolution.
    float stripe = step(0.5, fract((gl_FragCoord.x - gl_FragCoord.y) * 0.095));
    return mix(vec3(0.012), vec3(0.09), stripe * 0.62);
  }

  void main() {
    vec4 captureWorldPosition = objectMatrixDelta * vec4(vWorldPosition, 1.0);
    vec3 captureWorldNormal = normalize(objectNormalDelta * vWorldNormal);
    vec4 projected = projectorMatrix * captureWorldPosition;
    float projectedW = projected.w <= 0.0 ? -max(abs(projected.w), 0.0001) : max(projected.w, 0.0001);
    vec3 ndc = projected.xyz / projectedW;
    vec2 uv = ndc.xy * 0.5 + 0.5;
    uv.y = 1.0 - uv.y;

    float inX = step(-1.0, ndc.x) * step(ndc.x, 1.0);
    float inY = step(-1.0, ndc.y) * step(ndc.y, 1.0);
    float inZ = step(-1.0, ndc.z) * step(ndc.z, 1.0);
    float hasW = step(0.0001, projected.w);
    float inside = inX * inY * inZ * hasW;

    vec3 normal = captureWorldNormal;
    vec3 projectorViewDir = normalize(projectorPosition - captureWorldPosition.xyz);
    float ndv = dot(normal, projectorViewDir);
    float frontFacing = step(${NDV_HARD_REJECT.toFixed(2)}, ndv);
    float backfaceAlpha = mix(1.0, frontFacing, enableBackfaceCulling);

    vec2 maskUv = mix(uv, vec2(vUv.x, 1.0 - vUv.y), maskUsesUv);
    vec4 maskTexel = texture2D(maskMap, maskUv);
    float maskValue = dot(maskTexel.rgb, vec3(0.299, 0.587, 0.114)) * maskTexel.a;
    float maskAlpha = mix(1.0, maskValue, useMask);

    float projectedDepth = ndc.z * 0.5 + 0.5;
    float capturedDepth = unpackDepth(texture2D(depthMap, uv));
    float depthErr = abs(projectedDepth - capturedDepth);
    float depthWeight = mix(
      1.0,
      0.2 + 0.8 * exp(-pow(depthErr / max(${DEPTH_EPSILON.toFixed(2)}, 0.000001), 2.0)),
      useDepthCheck
    );

    float lambert = computePreviewLight(normal);
    vec4 texel = texture2D(projectedMap, uv);
    texel.rgb = applyHsvAdjustments(texel.rgb, hueShift, saturationShift, lightnessShift);
    float sourceAlpha = texel.a * maskAlpha;
    float alphaCoverage = step(0.01, sourceAlpha);
    float angleCoverage = smoothstep(${NDV_COVERAGE_START.toFixed(2)}, ${NDV_COVERAGE_END.toFixed(2)}, ndv);
    float coverageEdge = computeImageEdgeFade(uv, ${IMAGE_COVERAGE_EDGE_FADE.toFixed(3)});
    float coverage = clamp(layerOpacity * sourceAlpha * angleCoverage * mix(0.35, 1.0, coverageEdge), 0.0, 1.0);
    float angleWeight = computeAngleWeight(ndv, layerStrength);
    float qualityEdge = computeImageEdgeFade(uv, ${IMAGE_QUALITY_EDGE_FADE.toFixed(3)});
    float quality = coverage * depthWeight * angleWeight * mix(0.3, 1.0, qualityEdge);
    float projectionAlpha = inside * backfaceAlpha * alphaCoverage * coverage * step(${COVERAGE_THRESHOLD.toFixed(2)}, coverage);
    float overlayQualityFade = smoothstep(0.0, 0.15, max(quality, coverage * 0.25));
    float overlayProjectionAlpha = inside * backfaceAlpha * alphaCoverage * coverage * mix(0.75, 1.0, overlayQualityFade) * step(${COVERAGE_THRESHOLD.toFixed(2)}, coverage);
    projectionAlpha = mix(projectionAlpha, overlayProjectionAlpha, projectedBlendModeOverlay);
    // A repair underlay is a fallback texel, not a translucent decal. Hardening
    // its accepted coverage prevents the mask edge from blending with the
    // diagnostic black empty-preview color.
    projectionAlpha = mix(
      projectionAlpha,
      step(${COVERAGE_THRESHOLD.toFixed(2)}, projectionAlpha),
      projectedCompositeUnderlay
    );
    vec4 baseTexel = texture2D(baseMap, vUv);
    float baseRenderedColor = texture2D(baseRenderedColorMaskMap, vUv).r * useBaseRenderedColorMaskMap;
    vec4 uvOverlayTexel = texture2D(uvOverlayMap, vUv);
    uvOverlayTexel.rgb = applyHsvAdjustments(
      uvOverlayTexel.rgb,
      uvOverlayHueShift,
      uvOverlaySaturationShift,
      uvOverlayLightnessShift
    );
    vec3 baseSurfaceColor = mix(baseColor, baseTexel.rgb, useBaseMap * baseTexel.a);
    // Local repaint images are captured display colors: they already contain the
    // viewport exposure. LinearToneMapping applies the renderer exposure once more
    // at the end of this shader, so cancel that second exposure for rendered
    // colors while ordinary texture layers still receive preview lighting.
    float renderedColorExposureCompensation = 1.0 / max(previewExposure, 0.0001);
    vec3 emptyPreviewColor = mix(
      computeProjectionEmptyPreviewColor(baseColor),
      baseTexel.rgb * mix(lambert, renderedColorExposureCompensation, baseRenderedColor),
      useBaseMap * baseTexel.a
    );
    vec3 projectedDisplayColor = texel.rgb * mix(
      lambert,
      renderedColorExposureCompensation,
      projectedIsRenderedColor
    );
    vec3 mixedColor = mix(emptyPreviewColor, projectedDisplayColor, projectionAlpha);
    mixedColor = mix(
      mixedColor,
      uvOverlayTexel.rgb * lambert,
      uvOverlayTexel.a * useUvOverlayMap
    );
    vec4 topUvOverlayTexel = texture2D(topUvOverlayMap, vUv);
    topUvOverlayTexel.rgb = applyHsvAdjustments(
      topUvOverlayTexel.rgb,
      topUvOverlayHueShift,
      topUvOverlaySaturationShift,
      topUvOverlayLightnessShift
    );
    float topUvOverlayAlpha = clamp(
      topUvOverlayTexel.a * useTopUvOverlayMap * topUvOverlayOpacity,
      0.0,
      1.0
    );
    vec3 topUvOverlayDisplayColor = topUvOverlayTexel.rgb * mix(
      lambert,
      renderedColorExposureCompensation,
      topUvOverlayRenderedColor
    );
    mixedColor = mix(mixedColor, topUvOverlayDisplayColor, topUvOverlayAlpha);

    gl_FragColor = vec4(clamp(mixedColor, 0.0, 1.0), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function buildStackFragmentShader(
  layers: Array<{
    imageUrl: string;
    useMask?: boolean;
    useDepthCheck?: boolean;
    maskUrl?: string;
    maskSpace?: 'projection' | 'uv';
    depthUrl?: string;
    renderedColor?: boolean;
    blendMode?: ProjectionLayerStackInput['layers'][number]['blendMode'];
    compositeRole?: ProjectionLayerStackInput['layers'][number]['compositeRole'];
  }>,
  requestedFeatures: ProjectedLayerSamplerFeatures = {},
) {
  const features = normalizeSamplerFeatures(requestedFeatures);
  const layerCount = layers.length;
  const layerUsesMask = (index: number) => Boolean(layers[index].useMask && layers[index].maskUrl);
  const layerUsesDepth = (index: number) =>
    Boolean(layers[index].useDepthCheck && layers[index].depthUrl);
  const layerUsesProjectedArray = (index: number) =>
    features.useTextureArrays && !isLiveProjectedCanvasUrl(layers[index].imageUrl);
  const layerUsesMaskArray = (index: number) =>
    features.useTextureArrays && !isLiveProjectedCanvasUrl(layers[index].maskUrl);
  const layerUsesDepthArray = (index: number) =>
    features.useTextureArrays && !isLiveProjectedCanvasUrl(layers[index].depthUrl);
  const arraySliceIndex = (index: number, predicate: (candidateIndex: number) => boolean) =>
    Array.from({ length: index }, (_, candidateIndex) => candidateIndex).filter(predicate).length;
  const projectedArraySlice = (index: number) => arraySliceIndex(index, layerUsesProjectedArray);
  const maskArraySlice = (index: number) =>
    arraySliceIndex(
      index,
      (candidateIndex) => layerUsesMask(candidateIndex) && layerUsesMaskArray(candidateIndex),
    );
  const depthArraySlice = (index: number) =>
    arraySliceIndex(
      index,
      (candidateIndex) => layerUsesDepth(candidateIndex) && layerUsesDepthArray(candidateIndex),
    );
  const projectedSample = (index: number, uv: string) =>
    layerUsesProjectedArray(index)
      ? `texture(projectedMaps, vec3((${uv}) * projectedMapUvScale${index}, ${projectedArraySlice(index).toFixed(1)}))`
      : `texture2D(projectedMap${index}, ${uv})`;
  const maskSample = (index: number, uv: string) =>
    layerUsesMaskArray(index)
      ? `texture(maskMaps, vec3((${uv}) * maskMapUvScale${index}, ${maskArraySlice(index).toFixed(1)}))`
      : `texture2D(maskMap${index}, ${uv})`;
  const depthSample = (index: number, uv: string) =>
    layerUsesDepthArray(index)
      ? `texture(depthMaps, vec3((${uv}) * depthMapUvScale${index}, ${depthArraySlice(index).toFixed(1)}))`
      : `texture2D(depthMap${index}, ${uv})`;
  const uniformDeclarations = Array.from(
    { length: layerCount },
    (_, index) => `
  ${layerUsesProjectedArray(index) ? `uniform vec2 projectedMapUvScale${index};` : `uniform sampler2D projectedMap${index};`}
  ${layerUsesMask(index) ? (layerUsesMaskArray(index) ? `uniform vec2 maskMapUvScale${index};` : `uniform sampler2D maskMap${index};`) : ''}
  ${layerUsesDepth(index) ? (layerUsesDepthArray(index) ? `uniform vec2 depthMapUvScale${index};` : `uniform sampler2D depthMap${index};`) : ''}
  uniform mat4 projectorMatrix${index};
  uniform mat4 objectMatrixDelta${index};
  uniform mat3 objectNormalDelta${index};
  uniform vec3 projectorPosition${index};
  uniform float layerOpacity${index};
  uniform float layerStrength${index};
  uniform float hueShift${index};
  uniform float saturationShift${index};
  uniform float lightnessShift${index};
`,
  ).join('');

  const buildCandidateEvaluations = (role: 'normal' | 'underlay') =>
    Array.from({ length: layerCount }, (_, index) =>
    (layers[index].compositeRole ?? (layers[index].blendMode === 'overlay' ? 'overlay' : 'normal')) !== role
      ? ''
      : `
    if (layerOpacity${index} > 0.0001) {
      vec4 captureWorldPosition = objectMatrixDelta${index} * vec4(vWorldPosition, 1.0);
      vec3 captureWorldNormal = normalize(objectNormalDelta${index} * vWorldNormal);
      vec4 projected = projectorMatrix${index} * captureWorldPosition;
      float projectedW = projected.w <= 0.0 ? -max(abs(projected.w), 0.0001) : max(projected.w, 0.0001);
      vec3 ndc = projected.xyz / projectedW;
      vec2 uv = ndc.xy * 0.5 + 0.5;
      uv.y = 1.0 - uv.y;

      float inX = step(-1.0, ndc.x) * step(ndc.x, 1.0);
      float inY = step(-1.0, ndc.y) * step(ndc.y, 1.0);
      float inZ = step(-1.0, ndc.z) * step(ndc.z, 1.0);
      float hasW = step(0.0001, projected.w);
      float inside = inX * inY * inZ * hasW;

      vec3 normal = captureWorldNormal;
      vec3 projectorViewDir = normalize(projectorPosition${index} - captureWorldPosition.xyz);
      float ndv = dot(normal, projectorViewDir);
      float frontFacing = step(${NDV_HARD_REJECT.toFixed(2)}, ndv);
      float backfaceAlpha = mix(1.0, frontFacing, enableBackfaceCulling);

      vec4 maskTexel = ${layerUsesMask(index) ? maskSample(index, layers[index].maskSpace === 'uv' ? 'vec2(vUv.x, 1.0 - vUv.y)' : 'uv') : 'vec4(1.0)'};
      float maskAlpha = dot(maskTexel.rgb, vec3(0.299, 0.587, 0.114)) * maskTexel.a;

      float projectedDepth = ndc.z * 0.5 + 0.5;
      float depthWeight = ${
        layerUsesDepth(index)
          ? `0.2 + 0.8 * exp(-pow(abs(projectedDepth - unpackDepth(${depthSample(index, 'uv')})) / max(${DEPTH_EPSILON.toFixed(2)}, 0.000001), 2.0))`
          : '1.0'
      };

      vec4 texel = ${projectedSample(index, 'uv')};
      texel.rgb = applyHsvAdjustments(texel.rgb, hueShift${index}, saturationShift${index}, lightnessShift${index});
      texel.rgb *= mix(
        lambert,
        1.0 / max(previewExposure, 0.0001),
        ${layers[index].renderedColor ? '1.0' : '0.0'}
      );
      float sourceAlpha = texel.a * maskAlpha;
      float alphaCoverage = step(0.01, sourceAlpha);
      float angleCoverage = smoothstep(${NDV_COVERAGE_START.toFixed(2)}, ${NDV_COVERAGE_END.toFixed(2)}, ndv);
      float coverageEdge = computeImageEdgeFade(uv, ${IMAGE_COVERAGE_EDGE_FADE.toFixed(3)});
      float coverage = clamp(layerOpacity${index} * sourceAlpha * angleCoverage * mix(0.35, 1.0, coverageEdge), 0.0, 1.0);
      float angleWeight = computeAngleWeight(ndv, layerStrength${index});
      float qualityEdge = computeImageEdgeFade(uv, ${IMAGE_QUALITY_EDGE_FADE.toFixed(3)});
      float quality = coverage * depthWeight * angleWeight * mix(0.3, 1.0, qualityEdge);
      if (inside * backfaceAlpha * alphaCoverage > 0.5 && coverage > ${COVERAGE_THRESHOLD.toFixed(2)}) {
        insertBlendCandidate(texel.rgb, coverage, quality);
      }
    }
`,
  ).join('');
  const underlayEvaluations = buildCandidateEvaluations('underlay');
  const blendEvaluations = buildCandidateEvaluations('normal');

  const overlayEvaluations = Array.from({ length: layerCount }, (_, index) =>
    layers[index].blendMode !== 'overlay'
      ? ''
      : `
    if (layerOpacity${index} > 0.0001) {
      vec4 captureWorldPosition = objectMatrixDelta${index} * vec4(vWorldPosition, 1.0);
      vec3 captureWorldNormal = normalize(objectNormalDelta${index} * vWorldNormal);
      vec4 projected = projectorMatrix${index} * captureWorldPosition;
      float projectedW = projected.w <= 0.0 ? -max(abs(projected.w), 0.0001) : max(projected.w, 0.0001);
      vec3 ndc = projected.xyz / projectedW;
      vec2 uv = ndc.xy * 0.5 + 0.5;
      uv.y = 1.0 - uv.y;

      float inX = step(-1.0, ndc.x) * step(ndc.x, 1.0);
      float inY = step(-1.0, ndc.y) * step(ndc.y, 1.0);
      float inZ = step(-1.0, ndc.z) * step(ndc.z, 1.0);
      float hasW = step(0.0001, projected.w);
      float inside = inX * inY * inZ * hasW;

      vec3 normal = captureWorldNormal;
      vec3 projectorViewDir = normalize(projectorPosition${index} - captureWorldPosition.xyz);
      float ndv = dot(normal, projectorViewDir);
      float frontFacing = step(${NDV_HARD_REJECT.toFixed(2)}, ndv);
      float backfaceAlpha = mix(1.0, frontFacing, enableBackfaceCulling);

      vec4 maskTexel = ${layerUsesMask(index) ? maskSample(index, layers[index].maskSpace === 'uv' ? 'vec2(vUv.x, 1.0 - vUv.y)' : 'uv') : 'vec4(1.0)'};
      float maskAlpha = dot(maskTexel.rgb, vec3(0.299, 0.587, 0.114)) * maskTexel.a;

      float projectedDepth = ndc.z * 0.5 + 0.5;
      float depthWeight = ${
        layerUsesDepth(index)
          ? `0.2 + 0.8 * exp(-pow(abs(projectedDepth - unpackDepth(${depthSample(index, 'uv')})) / max(${DEPTH_EPSILON.toFixed(2)}, 0.000001), 2.0))`
          : '1.0'
      };

      vec4 texel = ${projectedSample(index, 'uv')};
      texel.rgb = applyHsvAdjustments(texel.rgb, hueShift${index}, saturationShift${index}, lightnessShift${index});
      texel.rgb *= mix(
        lambert,
        1.0 / max(previewExposure, 0.0001),
        ${layers[index].renderedColor ? '1.0' : '0.0'}
      );
      float sourceAlpha = texel.a * maskAlpha;
      float alphaCoverage = step(0.01, sourceAlpha);
      float angleCoverage = smoothstep(${NDV_COVERAGE_START.toFixed(2)}, ${NDV_COVERAGE_END.toFixed(2)}, ndv);
      float coverageEdge = computeImageEdgeFade(uv, ${IMAGE_COVERAGE_EDGE_FADE.toFixed(3)});
      float coverage = clamp(layerOpacity${index} * sourceAlpha * angleCoverage * mix(0.35, 1.0, coverageEdge), 0.0, 1.0);
      float angleWeight = computeAngleWeight(ndv, layerStrength${index});
      float qualityEdge = computeImageEdgeFade(uv, ${IMAGE_QUALITY_EDGE_FADE.toFixed(3)});
      float quality = coverage * depthWeight * angleWeight * mix(0.3, 1.0, qualityEdge);
      if (inside * backfaceAlpha * alphaCoverage > 0.5 && coverage > ${COVERAGE_THRESHOLD.toFixed(2)}) {
        float qualityFade = smoothstep(0.0, 0.15, max(quality, coverage * 0.25));
        float overlayAlpha = clamp(coverage * mix(0.75, 1.0, qualityFade), 0.0, 1.0);
        mixedColor = mix(mixedColor, texel.rgb, overlayAlpha);
      }
    }
`,
  ).join('');

  return `
  ${uniformDeclarations}
  ${layers.some((_layer, index) => layerUsesProjectedArray(index)) ? 'uniform highp sampler2DArray projectedMaps;' : ''}
  ${layers.some((_layer, index) => layerUsesMask(index) && layerUsesMaskArray(index)) ? 'uniform highp sampler2DArray maskMaps;' : ''}
  ${layers.some((_layer, index) => layerUsesDepth(index) && layerUsesDepthArray(index)) ? 'uniform highp sampler2DArray depthMaps;' : ''}
  uniform float enableBackfaceCulling;
  uniform float edgeFeather;
  uniform float depthBias;
  ${features.useBaseMap ? 'uniform sampler2D baseMap;' : ''}
  ${features.useBaseRenderedColorMaskMap ? 'uniform sampler2D baseRenderedColorMaskMap;' : ''}
  ${features.useUvOverlayMap ? 'uniform sampler2D uvOverlayMap;' : ''}
  ${features.useUvOverlayMap ? 'uniform float uvOverlayHueShift;' : ''}
  ${features.useUvOverlayMap ? 'uniform float uvOverlaySaturationShift;' : ''}
  ${features.useUvOverlayMap ? 'uniform float uvOverlayLightnessShift;' : ''}
  ${features.useTopUvOverlayMap ? 'uniform sampler2D topUvOverlayMap;' : ''}
  ${features.useTopUvOverlayMap ? 'uniform float topUvOverlayOpacity;' : ''}
  ${features.useTopUvOverlayMap ? 'uniform float topUvOverlayRenderedColor;' : ''}
  ${features.useTopUvOverlayMap ? 'uniform float topUvOverlayHueShift;' : ''}
  ${features.useTopUvOverlayMap ? 'uniform float topUvOverlaySaturationShift;' : ''}
  ${features.useTopUvOverlayMap ? 'uniform float topUvOverlayLightnessShift;' : ''}
  uniform float previewLightingEnabled;
  uniform float previewExposure;
  uniform float ambientLightIntensity;
  uniform float keyLightIntensity;
  uniform vec3 keyLightDirection;
  uniform vec3 baseColor;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vUv;

  vec3 linearToSrgb(vec3 color) {
    vec3 low = color * 12.92;
    vec3 high = 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(low, high, step(vec3(0.0031308), color));
  }

  vec3 srgbToLinear(vec3 color) {
    vec3 low = color / 12.92;
    vec3 high = pow(max((color + 0.055) / 1.055, vec3(0.0)), vec3(2.4));
    return mix(low, high, step(vec3(0.04045), color));
  }

  vec3 rgbToHsv(vec3 color) {
    vec4 k = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(color.bg, k.wz), vec4(color.gb, k.xy), step(color.b, color.g));
    vec4 q = mix(vec4(p.xyw, color.r), vec4(color.r, p.yzx), step(p.x, color.r));
    float delta = q.x - min(q.w, q.y);
    float epsilon = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * delta + epsilon)), delta / (q.x + epsilon), q.x);
  }

  vec3 hsvToRgb(vec3 hsv) {
    vec3 channels = abs(fract(hsv.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return hsv.z * mix(vec3(1.0), clamp(channels - 1.0, 0.0, 1.0), hsv.y);
  }

  vec3 applyHsvAdjustments(vec3 color, float hueShift, float saturationShift, float lightnessShift) {
    if (abs(hueShift) < 0.0001 && abs(saturationShift) < 0.0001 && abs(lightnessShift) < 0.0001) {
      return color;
    }
    vec3 hsv = rgbToHsv(linearToSrgb(clamp(color, 0.0, 1.0)));
    hsv.x = mod(hsv.x + hueShift + 1.0, 1.0);
    hsv.y = clamp(hsv.y + saturationShift, 0.0, 1.0);
    hsv.z = clamp(hsv.z + lightnessShift, 0.0, 1.0);
    return srgbToLinear(hsvToRgb(hsv));
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

  float computeAngleWeight(float ndv, float strength) {
    float strengthClamped = clamp(strength, 0.25, ${MAX_STRENGTH_FOR_ANGLE.toFixed(1)});
    float gamma = ${BASE_ANGLE_GAMMA.toFixed(1)} / strengthClamped;
    float frontFade = smoothstep(${NDV_QUALITY_START.toFixed(2)}, ${NDV_QUALITY_END.toFixed(2)}, ndv);
    return frontFade * pow(clamp(ndv, 0.0, 1.0), gamma);
  }

  float computeImageEdgeFade(vec2 uv, float edge) {
    float edgeDistance = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    return smoothstep(0.0, edge, edgeDistance);
  }

  float computePreviewLight(vec3 normal) {
    vec3 lightDir = normalize(keyLightDirection);
    float diffuse = max(dot(normal, lightDir), 0.0);
    float lit = clamp(ambientLightIntensity + diffuse * keyLightIntensity * 0.55, 0.0, 2.0);
    return mix(1.0, lit, previewLightingEnabled);
  }

  vec3 computeProjectionEmptyPreviewColor(vec3 baseSurfaceColor) {
    // Match the UV-layer empty-area treatment so projection gaps never look
    // like a valid white texture contribution.
    float stripe = step(0.5, fract((gl_FragCoord.x - gl_FragCoord.y) * 0.095));
    return mix(vec3(0.012), vec3(0.09), stripe * 0.62);
  }

  float topQuality0 = 0.0;
  float topQuality1 = 0.0;
  float topQuality2 = 0.0;
  vec3 topColor0 = vec3(0.0);
  vec3 topColor1 = vec3(0.0);
  vec3 topColor2 = vec3(0.0);

  float topCoverage0 = 0.0;
  float topCoverage1 = 0.0;
  float topCoverage2 = 0.0;

  void insertBlendCandidate(vec3 color, float coverage, float quality) {
    float score = max(quality, coverage * ${QUALITY_FLOOR_FROM_COVERAGE.toFixed(2)});
    if (score > topQuality0) {
      topCoverage2 = topCoverage1;
      topQuality2 = topQuality1;
      topColor2 = topColor1;
      topCoverage1 = topCoverage0;
      topQuality1 = topQuality0;
      topColor1 = topColor0;
      topCoverage0 = coverage;
      topQuality0 = score;
      topColor0 = color;
    } else if (score > topQuality1) {
      topCoverage2 = topCoverage1;
      topQuality2 = topQuality1;
      topColor2 = topColor1;
      topCoverage1 = coverage;
      topQuality1 = score;
      topColor1 = color;
    } else if (score > topQuality2) {
      topCoverage2 = coverage;
      topQuality2 = score;
      topColor2 = color;
    }
  }

  vec3 composeBlendBase(vec3 fallbackColor) {
    float candidateCount =
      step(${COVERAGE_THRESHOLD.toFixed(2)}, topCoverage0) +
      step(${COVERAGE_THRESHOLD.toFixed(2)}, topCoverage1) +
      step(${COVERAGE_THRESHOLD.toFixed(2)}, topCoverage2);
    if (candidateCount <= 0.5) return fallbackColor;
    if (candidateCount <= 1.5) return topColor0;
    if (
      topQuality0 >= topQuality1 * ${DOMINANT_QUALITY_RATIO.toFixed(2)} ||
      topQuality0 - topQuality1 >= ${DOMINANT_QUALITY_MARGIN.toFixed(3)}
    ) {
      return topColor0;
    }

    float sumStrong =
      pow(max(topQuality0, 0.0), ${BLEND_POWER.toFixed(1)}) +
      pow(max(topQuality1, 0.0), ${BLEND_POWER.toFixed(1)}) +
      pow(max(topQuality2, 0.0), ${BLEND_POWER.toFixed(1)});
    float sumSoft = topCoverage0 + topCoverage1 + topCoverage2;
    if (sumSoft <= 0.0001) return fallbackColor;

    float w0 = mix(pow(topQuality0, ${BLEND_POWER.toFixed(1)}) / max(sumStrong, 0.000001), topCoverage0 / sumSoft, ${RESIDUAL_MIX.toFixed(2)});
    float w1 = mix(pow(topQuality1, ${BLEND_POWER.toFixed(1)}) / max(sumStrong, 0.000001), topCoverage1 / sumSoft, ${RESIDUAL_MIX.toFixed(2)});
    float w2 = mix(pow(topQuality2, ${BLEND_POWER.toFixed(1)}) / max(sumStrong, 0.000001), topCoverage2 / sumSoft, ${RESIDUAL_MIX.toFixed(2)});
    return topColor0 * w0 + topColor1 * w1 + topColor2 * w2;
  }

  void main() {
    vec3 normal = normalize(vWorldNormal);
    float lambert = computePreviewLight(normal);
    ${features.useBaseMap ? 'vec4 baseTexel = texture2D(baseMap, vUv);' : ''}
    ${features.useBaseRenderedColorMaskMap ? 'float baseRenderedColor = texture2D(baseRenderedColorMaskMap, vUv).r;' : 'float baseRenderedColor = 0.0;'}
    ${
      features.useUvOverlayMap
        ? `
    vec4 uvOverlayTexel = texture2D(uvOverlayMap, vUv);
    uvOverlayTexel.rgb = applyHsvAdjustments(
      uvOverlayTexel.rgb,
      uvOverlayHueShift,
      uvOverlaySaturationShift,
      uvOverlayLightnessShift
    );`
        : ''
    }
    ${
      features.useTopUvOverlayMap
        ? `
    vec4 topUvOverlayTexel = texture2D(topUvOverlayMap, vUv);
    topUvOverlayTexel.rgb = applyHsvAdjustments(
      topUvOverlayTexel.rgb,
      topUvOverlayHueShift,
      topUvOverlaySaturationShift,
      topUvOverlayLightnessShift
    );`
        : ''
    }
    float renderedColorExposureCompensation = 1.0 / max(previewExposure, 0.0001);
    vec3 shadedBase = ${
      features.useBaseMap
        ? `mix(
      computeProjectionEmptyPreviewColor(baseColor),
      baseTexel.rgb * mix(lambert, renderedColorExposureCompensation, baseRenderedColor),
      baseTexel.a
    )`
        : 'computeProjectionEmptyPreviewColor(baseColor)'
    };
    topCoverage0 = 0.0;
    topCoverage1 = 0.0;
    topCoverage2 = 0.0;
    topQuality0 = 0.0;
    topQuality1 = 0.0;
    topQuality2 = 0.0;
    topColor0 = vec3(0.0);
    topColor1 = vec3(0.0);
    topColor2 = vec3(0.0);

    ${underlayEvaluations}

    vec3 underlayColor = composeBlendBase(shadedBase);
    topCoverage0 = 0.0;
    topCoverage1 = 0.0;
    topCoverage2 = 0.0;
    topQuality0 = 0.0;
    topQuality1 = 0.0;
    topQuality2 = 0.0;
    topColor0 = vec3(0.0);
    topColor1 = vec3(0.0);
    topColor2 = vec3(0.0);

    ${blendEvaluations}

    vec3 mixedColor = composeBlendBase(underlayColor);
    ${overlayEvaluations}
    ${
      features.useUvOverlayMap
        ? `mixedColor = mix(
      mixedColor,
      uvOverlayTexel.rgb * lambert,
      uvOverlayTexel.a
    );`
        : ''
    }
    ${
      features.useTopUvOverlayMap
        ? `float topUvOverlayAlpha = clamp(
      topUvOverlayTexel.a * topUvOverlayOpacity,
      0.0,
      1.0
    );
    vec3 topUvOverlayDisplayColor = topUvOverlayTexel.rgb * mix(
      lambert,
      renderedColorExposureCompensation,
      topUvOverlayRenderedColor
    );
    mixedColor = mix(mixedColor, topUvOverlayDisplayColor, topUvOverlayAlpha);`
        : ''
    }
    gl_FragColor = vec4(clamp(mixedColor, 0.0, 1.0), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
}

function getPreviewLighting(input?: ProjectionPreviewLighting) {
  const lighting = input ?? DEFAULT_PREVIEW_LIGHTING;
  const direction = new THREE.Vector3(...lighting.keyLightDirection);
  if (direction.lengthSq() <= 0.000001)
    direction.set(...DEFAULT_PREVIEW_LIGHTING.keyLightDirection);
  direction.normalize();
  return {
    enabled: lighting.enabled ? 1 : 0,
    exposure: Math.max(0.0001, lighting.exposure),
    ambientIntensity: Math.max(0, lighting.ambientIntensity),
    keyLightIntensity: Math.max(0, lighting.keyLightIntensity),
    keyLightDirection: direction,
  };
}

function prepareUvTexture(texture: THREE.Texture) {
  if (texture.userData[PREPARED_TEXTURE_PROFILE_KEY] === UV_OVERLAY_TEXTURE_PROFILE) return;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.userData[PREPARED_TEXTURE_PROFILE_KEY] = UV_OVERLAY_TEXTURE_PROFILE;
}

function prepareExistingBaseTexture(texture: THREE.Texture) {
  if (texture.userData[PREPARED_TEXTURE_PROFILE_KEY] === BASE_PREVIEW_TEXTURE_PROFILE) return;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = texture.isRenderTargetTexture
    ? THREE.LinearFilter
    : THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = !texture.isRenderTargetTexture;
  if (!texture.isRenderTargetTexture) texture.needsUpdate = true;
  texture.userData[PREPARED_TEXTURE_PROFILE_KEY] = BASE_PREVIEW_TEXTURE_PROFILE;
}

function getLayerCameraSignature(camera: ProjectionLayerStackInput['layers'][number]['camera']) {
  return [
    camera?.position?.join(',') ?? '',
    camera?.target?.join(',') ?? '',
    camera?.viewMatrix?.join(',') ?? '',
    camera?.projectionMatrix?.join(',') ?? '',
    camera?.projection ?? '',
  ].join('/');
}

function getProjectionLayerStructureSignature(
  layers: ProjectionLayerStackInput['layers'],
  features: ProjectedLayerSamplerFeatures = {},
) {
  const normalizedFeatures = normalizeSamplerFeatures(features);
  return (
    `${Number(normalizedFeatures.useBaseMap)}${Number(
      normalizedFeatures.useBaseRenderedColorMaskMap,
    )}${Number(normalizedFeatures.useUvOverlayMap)}${Number(
      normalizedFeatures.useTopUvOverlayMap,
    )}${Number(
      normalizedFeatures.useTextureArrays,
    )}:` +
    layers
      .map((layer) =>
        [
          layer.layerId,
          layer.imageUrl,
          layer.maskUrl ?? '',
          layer.depthUrl ?? '',
          layer.useMask ? 1 : 0,
          layer.maskSpace ?? 'projection',
          layer.useDepthCheck ? 1 : 0,
          layer.renderedColor ? 1 : 0,
          layer.blendMode ?? 'normal',
          layer.compositeRole ?? 'normal',
          layer.objectMatrixWorld?.join(',') ?? '',
          getLayerCameraSignature(layer.camera),
        ].join('~'),
      )
      .join('|')
  );
}

function updateLayerUniforms(
  material: THREE.ShaderMaterial,
  binding: ProjectedLayerUniformBinding,
  layer: ProjectionLayerStackInput['layers'][number],
) {
  if (binding.imageUrl !== layer.imageUrl) {
    const requestedImageUrl = layer.imageUrl;
    binding.imageUrl = requestedImageUrl;
    void loadProjectedTexture(requestedImageUrl)
      .then((texture) => {
        if (binding.imageUrl !== requestedImageUrl) return;
        const projectedMapUniform = material.uniforms[binding.projectedMapUniform];
        if (!projectedMapUniform) return;
        projectedMapUniform.value = texture;
        texture.needsUpdate = true;
        material.needsUpdate = true;
      })
      .catch((error) => {
        console.warn(
          '[Liclick 3D Texture] Could not update projected layer image; keeping previous texture.',
          error,
        );
      });
  }
  const opacityUniform = material.uniforms[binding.opacityUniform];
  if (opacityUniform) opacityUniform.value = layer.visible ? layer.opacity : 0;
  const strengthUniform = material.uniforms[binding.strengthUniform];
  if (strengthUniform) strengthUniform.value = layer.strength ?? 1;
  const hueUniform = material.uniforms[binding.hueUniform];
  if (hueUniform) hueUniform.value = layer.hue ?? 0;
  const saturationUniform = material.uniforms[binding.saturationUniform];
  if (saturationUniform) saturationUniform.value = layer.saturation ?? 0;
  const lightnessUniform = material.uniforms[binding.lightnessUniform];
  if (lightnessUniform) lightnessUniform.value = layer.lightness ?? 0;
}

function updateSharedPreviewUniforms(
  material: THREE.ShaderMaterial,
  input: ProjectionLayerStackInput,
) {
  const previewLighting = getPreviewLighting(input.previewLighting);
  if (material.uniforms.baseMap && input.baseTexture)
    material.uniforms.baseMap.value = input.baseTexture;
  if (material.uniforms.baseRenderedColorMaskMap && input.baseRenderedColorMaskTexture)
    material.uniforms.baseRenderedColorMaskMap.value = input.baseRenderedColorMaskTexture;
  if (material.uniforms.uvOverlayMap && input.uvOverlayTexture)
    material.uniforms.uvOverlayMap.value = input.uvOverlayTexture;
  if (material.uniforms.topUvOverlayMap && input.topUvOverlayTexture)
    material.uniforms.topUvOverlayMap.value = input.topUvOverlayTexture;
  if (material.uniforms.useBaseMap) material.uniforms.useBaseMap.value = input.baseTexture ? 1 : 0;
  if (material.uniforms.useBaseRenderedColorMaskMap)
    material.uniforms.useBaseRenderedColorMaskMap.value = input.baseRenderedColorMaskTexture
      ? 1
      : 0;
  if (material.uniforms.useUvOverlayMap)
    material.uniforms.useUvOverlayMap.value = input.uvOverlayTexture ? 1 : 0;
  if (material.uniforms.useTopUvOverlayMap)
    material.uniforms.useTopUvOverlayMap.value = input.topUvOverlayTexture ? 1 : 0;
  if (material.uniforms.topUvOverlayOpacity)
    material.uniforms.topUvOverlayOpacity.value = input.topUvOverlayOpacity ?? 1;
  if (material.uniforms.topUvOverlayRenderedColor)
    material.uniforms.topUvOverlayRenderedColor.value = input.topUvOverlayRenderedColor ? 1 : 0;
  if (material.uniforms.topUvOverlayHueShift)
    material.uniforms.topUvOverlayHueShift.value = input.topUvOverlayHue ?? 0;
  if (material.uniforms.topUvOverlaySaturationShift)
    material.uniforms.topUvOverlaySaturationShift.value = input.topUvOverlaySaturation ?? 0;
  if (material.uniforms.topUvOverlayLightnessShift)
    material.uniforms.topUvOverlayLightnessShift.value = input.topUvOverlayLightness ?? 0;
  if (material.uniforms.uvOverlayHueShift)
    material.uniforms.uvOverlayHueShift.value = input.uvOverlayHue ?? 0;
  if (material.uniforms.uvOverlaySaturationShift)
    material.uniforms.uvOverlaySaturationShift.value = input.uvOverlaySaturation ?? 0;
  if (material.uniforms.uvOverlayLightnessShift)
    material.uniforms.uvOverlayLightnessShift.value = input.uvOverlayLightness ?? 0;
  if (material.uniforms.baseColor)
    material.uniforms.baseColor.value.set(input.baseColor ?? DEFAULT_PREVIEW_COLOR);
  if (material.uniforms.previewLightingEnabled)
    material.uniforms.previewLightingEnabled.value = previewLighting.enabled;
  if (material.uniforms.previewExposure)
    material.uniforms.previewExposure.value = previewLighting.exposure;
  if (material.uniforms.ambientLightIntensity)
    material.uniforms.ambientLightIntensity.value = previewLighting.ambientIntensity;
  if (material.uniforms.keyLightIntensity)
    material.uniforms.keyLightIntensity.value = previewLighting.keyLightIntensity;
  if (material.uniforms.keyLightDirection)
    material.uniforms.keyLightDirection.value = previewLighting.keyLightDirection;
  if (input.baseTexture) prepareExistingBaseTexture(input.baseTexture);
  if (input.uvOverlayTexture) prepareUvTexture(input.uvOverlayTexture);
  if (input.topUvOverlayTexture) prepareUvTexture(input.topUvOverlayTexture);
}

export function updateProjectedLayerStackMaterial(
  material: THREE.Material | THREE.Material[] | undefined,
  input: ProjectionLayerStackInput,
) {
  if (!(material instanceof THREE.ShaderMaterial)) return false;
  const state = material.userData[PROJECTED_LAYER_STACK_STATE_KEY] as
    | ProjectedLayerMaterialState
    | undefined;
  if (!state) return false;
  const layers = input.layers.filter((layer) => layer.imageUrl && layer.camera);
  if (layers.length === 0) return false;
  if (
    state.signature !==
    getProjectionLayerStructureSignature(layers, {
      useBaseMap: Boolean(input.baseTexture),
      useBaseRenderedColorMaskMap: Boolean(input.baseRenderedColorMaskTexture),
      useUvOverlayMap: Boolean(input.uvOverlayTexture),
      useTopUvOverlayMap: Boolean(input.topUvOverlayTexture),
      useTextureArrays: state.usesTextureArrays,
    })
  )
    return false;
  updateSharedPreviewUniforms(material, input);
  for (let index = 0; index < layers.length; index += 1) {
    const binding = state.bindings[index];
    const layer = layers[index];
    if (!binding || binding.layerId !== layer.layerId) return false;
    updateLayerUniforms(material, binding, layer);
  }
  return true;
}

export type ProjectedTextureProfile = 'image' | 'mask' | 'depth';

const projectedTextureCache = new Map<string, Promise<THREE.Texture>>();

function getProjectedTextureCacheKey(
  imageUrl: string,
  colorSpace: THREE.ColorSpace,
  profile: ProjectedTextureProfile,
) {
  return `${profile}:${colorSpace}:${imageUrl}`;
}

export function primeProjectedImageTexture(imageUrl: string, image: HTMLImageElement) {
  const cacheKey = getProjectedTextureCacheKey(imageUrl, THREE.SRGBColorSpace, 'image');
  if (projectedTextureCache.has(cacheKey)) return;
  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  projectedTextureCache.set(cacheKey, Promise.resolve(texture));
}

export async function loadProjectedTexture(
  imageUrl: string,
  colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace,
  profile: ProjectedTextureProfile = 'image',
) {
  if (isLiveProjectedCanvasUrl(imageUrl)) {
    const liveTexture = getLiveProjectedCanvasTexture(imageUrl, colorSpace);
    if (liveTexture) return liveTexture;
  }
  const cacheKey = getProjectedTextureCacheKey(imageUrl, colorSpace, profile);
  const cachedTexture = projectedTextureCache.get(cacheKey);
  if (cachedTexture) return cachedTexture;

  const texturePromise = new THREE.TextureLoader()
    .loadAsync(imageUrl)
    .then((texture) => {
      texture.colorSpace = colorSpace;
      texture.flipY = false;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter =
        profile === 'depth' ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
      texture.magFilter = profile === 'depth' ? THREE.NearestFilter : THREE.LinearFilter;
      texture.generateMipmaps = profile !== 'depth';
      texture.anisotropy = profile === 'image' ? 8 : 1;
      texture.needsUpdate = true;
      return texture;
    })
    .catch((error) => {
      projectedTextureCache.delete(cacheKey);
      throw error;
    });

  projectedTextureCache.set(cacheKey, texturePromise);
  return texturePromise;
}

type ProjectedTextureArrayBundle = {
  texture: THREE.DataArrayTexture;
  uvScales: THREE.Vector2[];
};

const PROJECTED_ARRAY_PREVIEW_MEMORY_BUDGET = 192 * 1024 * 1024;
const PROJECTED_ARRAY_MIN_PREVIEW_SIDE = 256;

function getTexturePixelSize(texture: THREE.Texture) {
  const image = texture.image as
    | { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number }
    | undefined;
  const width = Math.round(image?.naturalWidth ?? image?.width ?? 0);
  const height = Math.round(image?.naturalHeight ?? image?.height ?? 0);
  if (width <= 0 || height <= 0) {
    throw new Error('Projected texture array received an image without valid dimensions.');
  }
  return { width, height };
}

function yieldProjectedArrayUploadFrame() {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

function clearWebGlErrors(context: WebGL2RenderingContext) {
  while (context.getError() !== context.NO_ERROR) {
    // Clear stale renderer errors so allocation/upload checks only observe this operation.
  }
}

function assertNoProjectedArrayWebGlError(
  context: WebGL2RenderingContext,
  operation: 'allocation' | 'upload',
) {
  const error = context.getError();
  if (error !== context.NO_ERROR) {
    throw new Error(`Projected texture array ${operation} failed (WebGL ${error}).`);
  }
}

async function createProjectedTextureArray(
  renderer: THREE.WebGLRenderer,
  sources: Array<THREE.Texture | undefined>,
  profile: ProjectedTextureProfile,
  isCancelled?: () => boolean,
  maxPreviewSide = renderer.capabilities.maxTextureSize,
): Promise<ProjectedTextureArrayBundle> {
  if (!renderer.capabilities.isWebGL2) {
    throw new Error('High-capacity projected preview requires WebGL 2 texture arrays.');
  }
  const context = renderer.getContext() as WebGL2RenderingContext;
  const maxLayers = context.getParameter(context.MAX_ARRAY_TEXTURE_LAYERS) as number;
  if (sources.length > maxLayers) {
    throw new Error(
      `This GPU supports ${maxLayers} texture-array layers, but ${sources.length} projected layers were requested.`,
    );
  }
  const sourceSizes = sources.map((source) => (source ? getTexturePixelSize(source) : undefined));
  const sourceWidth = Math.max(1, ...sourceSizes.map((size) => size?.width ?? 1));
  const sourceHeight = Math.max(1, ...sourceSizes.map((size) => size?.height ?? 1));
  const previewScale = Math.min(
    1,
    maxPreviewSide / sourceWidth,
    maxPreviewSide / sourceHeight,
  );
  const width = Math.max(1, Math.floor(sourceWidth * previewScale));
  const height = Math.max(1, Math.floor(sourceHeight * previewScale));
  const previewSizes = sourceSizes.map((size) =>
    size
      ? {
          width: Math.max(1, Math.floor(size.width * previewScale)),
          height: Math.max(1, Math.floor(size.height * previewScale)),
        }
      : undefined,
  );
  if (
    width > renderer.capabilities.maxTextureSize ||
    height > renderer.capabilities.maxTextureSize
  ) {
    throw new Error(
      `Projected texture array needs ${width}x${height}px, but this GPU supports at most ${renderer.capabilities.maxTextureSize}px.`,
    );
  }

  const texture = new THREE.DataArrayTexture(null, width, height, sources.length);
  texture.name = `LiclickProjected${profile[0].toUpperCase()}${profile.slice(1)}Array`;
  texture.colorSpace = profile === 'image' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = profile === 'depth' ? THREE.NearestFilter : THREE.LinearFilter;
  texture.magFilter = profile === 'depth' ? THREE.NearestFilter : THREE.LinearFilter;
  // Array previews are memory-bound. Avoid a 33% mip-chain surcharge; the source
  // images remain untouched and export/bake paths still use their full resolution.
  texture.generateMipmaps = false;
  texture.anisotropy = 1;
  // DataArrayTexture starts at version 0. Without this flag WebGLRenderer only
  // binds an undefined texture and never allocates TEXTURE_2D_ARRAY storage.
  texture.needsUpdate = true;

  let uploadTexture: THREE.CanvasTexture | undefined;

  try {
    clearWebGlErrors(context);
    renderer.initTexture(texture);
    assertNoProjectedArrayWebGlError(context, 'allocation');
    const textureProperties = renderer.properties.get(texture) as {
      __webglTexture?: WebGLTexture;
    };
    if (!textureProperties.__webglTexture) {
      throw new Error('Could not allocate projected texture array storage.');
    }

    let uploadCanvas: HTMLCanvasElement | undefined;
    let uploadContext: CanvasRenderingContext2D | undefined;
    if (previewScale < 1) {
      uploadCanvas = document.createElement('canvas');
      uploadCanvas.width = width;
      uploadCanvas.height = height;
      uploadContext = uploadCanvas.getContext('2d', { alpha: true }) ?? undefined;
      if (!uploadContext) throw new Error('Could not prepare projected preview resizing.');
      uploadContext.imageSmoothingEnabled = profile !== 'depth';
      uploadContext.imageSmoothingQuality = 'high';
      uploadTexture = new THREE.CanvasTexture(uploadCanvas);
      uploadTexture.colorSpace =
        profile === 'image' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      uploadTexture.flipY = false;
      uploadTexture.generateMipmaps = false;
      uploadTexture.minFilter =
        profile === 'depth' ? THREE.NearestFilter : THREE.LinearFilter;
      uploadTexture.magFilter =
        profile === 'depth' ? THREE.NearestFilter : THREE.LinearFilter;
    }

    let uploadedPixelsThisFrame = 0;
    for (let index = 0; index < sources.length; index += 1) {
      if (isCancelled?.()) throw new Error('Projected texture array upload was cancelled.');
      const source = sources[index];
      const size = sourceSizes[index];
      const previewSize = previewSizes[index];
      if (!source || !size || !previewSize) continue;
      let uploadSource: THREE.Texture = source;
      let uploadWidth = size.width;
      let uploadHeight = size.height;
      if (uploadCanvas && uploadContext && uploadTexture) {
        uploadContext.clearRect(0, 0, width, height);
        uploadContext.drawImage(
          source.image as CanvasImageSource,
          0,
          0,
          size.width,
          size.height,
          0,
          0,
          previewSize.width,
          previewSize.height,
        );
        uploadTexture.needsUpdate = true;
        uploadSource = uploadTexture;
        uploadWidth = width;
        uploadHeight = height;
      }
      renderer.copyTextureToTexture(
        uploadSource,
        texture,
        new THREE.Box2(new THREE.Vector2(0, 0), new THREE.Vector2(uploadWidth, uploadHeight)),
        new THREE.Vector3(0, 0, index),
      );
      uploadedPixelsThisFrame += previewSize.width * previewSize.height;
      if (uploadedPixelsThisFrame >= 4_194_304 && index < sources.length - 1) {
        uploadedPixelsThisFrame = 0;
        await yieldProjectedArrayUploadFrame();
        if (isCancelled?.()) throw new Error('Projected texture array upload was cancelled.');
      }
    }
    assertNoProjectedArrayWebGlError(context, 'upload');
  } catch (error) {
    texture.dispose();
    throw error;
  } finally {
    uploadTexture?.dispose();
  }

  return {
    texture,
    uvScales: previewSizes.map(
      (size) => new THREE.Vector2((size?.width ?? 1) / width, (size?.height ?? 1) / height),
    ),
  };
}

function getProjectedArrayPreviewSide(
  renderer: THREE.WebGLRenderer,
  totalSlices: number,
) {
  const budgetSide = Math.floor(
    Math.sqrt(PROJECTED_ARRAY_PREVIEW_MEMORY_BUDGET / (4 * Math.max(1, totalSlices))),
  );
  return Math.max(
    PROJECTED_ARRAY_MIN_PREVIEW_SIDE,
    Math.min(renderer.capabilities.maxTextureSize, budgetSide),
  );
}

export async function createProjectedLayerMaterial(input: ProjectionLayerInput) {
  const materialLayer = {
    layerId: input.layerId,
    imageUrl: input.imageUrl,
    maskUrl: input.maskUrl,
    depthUrl: input.depthUrl,
    camera: input.camera,
    objectMatrixWorld: input.objectMatrixWorld,
    opacity: input.opacity,
    strength: input.strength,
    blendMode: input.blendMode,
    compositeRole: input.compositeRole,
    visible: input.visible,
    hue: input.hue,
    saturation: input.saturation,
    lightness: input.lightness,
    useMask: input.useMask,
    useDepthCheck: input.useDepthCheck,
    renderedColor: input.renderedColor,
  };
  const texture = await loadProjectedTexture(input.imageUrl);

  const whitePixel = new Uint8Array([255, 255, 255, 255]);
  const neutralTexture = new THREE.DataTexture(whitePixel, 1, 1, THREE.RGBAFormat);
  neutralTexture.needsUpdate = true;
  // A requested projection mask must fail closed. Falling back to the white
  // neutral texture (or disabling useMask) exposes the complete generated
  // frame for one material rebuild, which is especially visible when a local
  // repaint stroke first creates its live canvas mask.
  const hiddenMaskTexture = new THREE.DataTexture(
    new Uint8Array([0, 0, 0, 255]),
    1,
    1,
    THREE.RGBAFormat,
  );
  hiddenMaskTexture.needsUpdate = true;
  const maskTexture = input.maskUrl
    ? await loadProjectedTexture(input.maskUrl, THREE.NoColorSpace, 'mask').catch((error) => {
        console.warn(
          '[Liclick 3D Texture] Could not load projected layer mask; keeping layer hidden.',
          error,
        );
        return hiddenMaskTexture;
      })
    : neutralTexture;
  const depthTexture = input.depthUrl
    ? await loadProjectedTexture(input.depthUrl, THREE.NoColorSpace, 'depth').catch((error) => {
        console.warn(
          '[Liclick 3D Texture] Could not load projected layer depth; continuing without depth check.',
          error,
        );
        return neutralTexture;
      })
    : neutralTexture;
  const baseTexture = input.baseTexture ?? neutralTexture;
  const uvOverlayTexture = input.uvOverlayTexture ?? neutralTexture;
  const topUvOverlayTexture = input.topUvOverlayTexture ?? neutralTexture;
  if (input.baseTexture) prepareExistingBaseTexture(input.baseTexture);
  if (input.uvOverlayTexture) prepareUvTexture(input.uvOverlayTexture);
  if (input.topUvOverlayTexture) prepareUvTexture(input.topUvOverlayTexture);
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

  const captureObjectMatrixWorld = input.objectMatrixWorld ?? input.currentObjectMatrixWorld;
  const objectMatrixDelta = new THREE.Matrix4();
  if (captureObjectMatrixWorld && input.currentObjectMatrixWorld) {
    objectMatrixDelta
      .fromArray(captureObjectMatrixWorld)
      .multiply(new THREE.Matrix4().fromArray(input.currentObjectMatrixWorld).invert());
  }
  const objectNormalDelta = new THREE.Matrix3().getNormalMatrix(objectMatrixDelta);
  const previewLighting = getPreviewLighting(input.previewLighting);
  const material = new THREE.ShaderMaterial({
    name: `LiclickProjectedLayer:${input.layerId}`,
    vertexShader,
    fragmentShader,
    uniforms: {
      projectedMap: { value: texture },
      baseMap: { value: baseTexture },
      baseRenderedColorMaskMap: { value: input.baseRenderedColorMaskTexture ?? neutralTexture },
      uvOverlayMap: { value: uvOverlayTexture },
      topUvOverlayMap: { value: topUvOverlayTexture },
      maskMap: { value: maskTexture },
      depthMap: { value: depthTexture },
      projectorMatrix: { value: buildProjectionMatrixBundle(input.camera).projectorMatrix },
      objectMatrixDelta: { value: objectMatrixDelta },
      objectNormalDelta: { value: objectNormalDelta },
      projectorPosition: { value: new THREE.Vector3().fromArray(input.camera.position) },
      layerOpacity: { value: input.visible ? input.opacity : 0 },
      layerStrength: { value: input.strength ?? 1 },
      projectedIsRenderedColor: { value: input.renderedColor ? 1 : 0 },
      projectedBlendModeOverlay: { value: input.blendMode === 'overlay' ? 1 : 0 },
      projectedCompositeUnderlay: { value: input.compositeRole === 'underlay' ? 1 : 0 },
      useMask: { value: input.useMask && input.maskUrl ? 1 : 0 },
      maskUsesUv: { value: input.maskSpace === 'uv' ? 1 : 0 },
      useDepthCheck: {
        value: input.useDepthCheck && input.depthUrl && depthTexture !== neutralTexture ? 1 : 0,
      },
      enableBackfaceCulling: { value: input.enableBackfaceCulling === false ? 0 : 1 },
      edgeFeather: { value: input.edgeFeather ?? 0.035 },
      depthBias: { value: input.depthBias ?? 0.025 },
      hueShift: { value: input.hue ?? 0 },
      saturationShift: { value: input.saturation ?? 0 },
      lightnessShift: { value: input.lightness ?? 0 },
      uvOverlayHueShift: { value: input.uvOverlayHue ?? 0 },
      uvOverlaySaturationShift: { value: input.uvOverlaySaturation ?? 0 },
      uvOverlayLightnessShift: { value: input.uvOverlayLightness ?? 0 },
      baseColor: { value: new THREE.Color(input.baseColor ?? DEFAULT_PREVIEW_COLOR) },
      useBaseMap: { value: input.baseTexture ? 1 : 0 },
      useBaseRenderedColorMaskMap: { value: input.baseRenderedColorMaskTexture ? 1 : 0 },
      useUvOverlayMap: { value: input.uvOverlayTexture ? 1 : 0 },
      useTopUvOverlayMap: { value: input.topUvOverlayTexture ? 1 : 0 },
      topUvOverlayOpacity: { value: input.topUvOverlayOpacity ?? 1 },
      topUvOverlayRenderedColor: { value: input.topUvOverlayRenderedColor ? 1 : 0 },
      topUvOverlayHueShift: { value: input.topUvOverlayHue ?? 0 },
      topUvOverlaySaturationShift: { value: input.topUvOverlaySaturation ?? 0 },
      topUvOverlayLightnessShift: { value: input.topUvOverlayLightness ?? 0 },
      previewLightingEnabled: { value: previewLighting.enabled },
      previewExposure: { value: previewLighting.exposure },
      ambientLightIntensity: { value: previewLighting.ambientIntensity },
      keyLightIntensity: { value: previewLighting.keyLightIntensity },
      keyLightDirection: { value: previewLighting.keyLightDirection },
    },
    toneMapped: true,
  });
  material.userData[GENERATED_MATERIAL_FLAG] = true;
  material.userData[DISPOSABLE_TEXTURES_KEY] = [neutralTexture, hiddenMaskTexture];
  material.userData[PROJECTED_LAYER_STACK_STATE_KEY] = {
    signature: getProjectionLayerStructureSignature([materialLayer], {
      useBaseMap: Boolean(input.baseTexture),
      useBaseRenderedColorMaskMap: Boolean(input.baseRenderedColorMaskTexture),
      useUvOverlayMap: Boolean(input.uvOverlayTexture),
      useTopUvOverlayMap: Boolean(input.topUvOverlayTexture),
    }),
    bindings: [
      {
        layerId: input.layerId,
        imageUrl: input.imageUrl,
        projectedMapUniform: 'projectedMap',
        opacityUniform: 'layerOpacity',
        strengthUniform: 'layerStrength',
        hueUniform: 'hueShift',
        saturationUniform: 'saturationShift',
        lightnessUniform: 'lightnessShift',
      },
    ],
    usesTextureArrays: false,
  } satisfies ProjectedLayerMaterialState;
  material.userData[PROJECTED_LAYER_MATERIAL_USER_DATA_KEY] = {
    layers: [
      {
        objectMatrixWorld: captureObjectMatrixWorld,
        objectMatrixDeltaUniform: 'objectMatrixDelta',
        objectNormalDeltaUniform: 'objectNormalDelta',
      },
    ],
  } satisfies ProjectedLayerProjectionData;
  return material;
}

export async function createProjectedLayerStackMaterial(
  input: ProjectionLayerStackInput,
  options: {
    maxTextureImageUnits?: number;
    renderer?: THREE.WebGLRenderer;
    isCancelled?: () => boolean;
  } = {},
) {
  const layers = input.layers.filter((layer) => layer.imageUrl && layer.camera);
  if (layers.length === 0) return undefined;
  const maxTextureImageUnits = options.maxTextureImageUnits ?? Number.POSITIVE_INFINITY;
  const samplerFeatures = {
    useBaseMap: Boolean(input.baseTexture),
    useBaseRenderedColorMaskMap: Boolean(input.baseRenderedColorMaskTexture),
    useUvOverlayMap: Boolean(input.uvOverlayTexture),
    useTopUvOverlayMap: Boolean(input.topUvOverlayTexture),
  };
  const directSamplerBudget = getProjectedLayerSamplerBudget(
    layers,
    maxTextureImageUnits,
    samplerFeatures,
  );
  const useTextureArrays =
    layers.length > 1 &&
    !directSamplerBudget.withinBudget &&
    Boolean(options.renderer?.capabilities.isWebGL2);
  const samplerBudget = useTextureArrays
    ? getProjectedLayerSamplerBudget(layers, maxTextureImageUnits, {
        ...samplerFeatures,
        useTextureArrays: true,
      })
    : directSamplerBudget;
  if (!samplerBudget.withinBudget) throw new ProjectedLayerSamplerBudgetError(samplerBudget);
  if (layers.length === 1) {
    const [layer] = layers;
    const material = await createProjectedLayerMaterial({
      ...input,
      layerId: layer.layerId,
      imageUrl: layer.imageUrl,
      maskUrl: layer.maskUrl,
      maskSpace: layer.maskSpace,
      depthUrl: layer.depthUrl,
      camera: layer.camera,
      objectMatrixWorld: layer.objectMatrixWorld,
      opacity: layer.opacity,
      strength: layer.strength,
      blendMode: layer.blendMode,
      visible: layer.visible,
      hue: layer.hue,
      saturation: layer.saturation,
      lightness: layer.lightness,
      useMask: layer.useMask,
      useDepthCheck: layer.useDepthCheck,
      renderedColor: layer.renderedColor,
    });
    material.userData[PROJECTED_LAYER_SAMPLER_BUDGET_KEY] = samplerBudget;
    return material;
  }

  const whitePixel = new Uint8Array([255, 255, 255, 255]);
  const neutralTexture = new THREE.DataTexture(whitePixel, 1, 1, THREE.RGBAFormat);
  neutralTexture.needsUpdate = true;
  neutralTexture.flipY = false;

  const uniforms: Record<string, { value: unknown }> = {
    enableBackfaceCulling: { value: input.enableBackfaceCulling === false ? 0 : 1 },
    edgeFeather: { value: input.edgeFeather ?? 0.004 },
    depthBias: { value: input.depthBias ?? 0.025 },
    baseColor: { value: new THREE.Color(input.baseColor ?? DEFAULT_PREVIEW_COLOR) },
    baseMap: { value: input.baseTexture ?? neutralTexture },
    baseRenderedColorMaskMap: { value: input.baseRenderedColorMaskTexture ?? neutralTexture },
    uvOverlayMap: { value: input.uvOverlayTexture ?? neutralTexture },
    topUvOverlayMap: { value: input.topUvOverlayTexture ?? neutralTexture },
    useBaseMap: { value: input.baseTexture ? 1 : 0 },
    useBaseRenderedColorMaskMap: { value: input.baseRenderedColorMaskTexture ? 1 : 0 },
    useUvOverlayMap: { value: input.uvOverlayTexture ? 1 : 0 },
    useTopUvOverlayMap: { value: input.topUvOverlayTexture ? 1 : 0 },
    topUvOverlayOpacity: { value: input.topUvOverlayOpacity ?? 1 },
    topUvOverlayRenderedColor: { value: input.topUvOverlayRenderedColor ? 1 : 0 },
    topUvOverlayHueShift: { value: input.topUvOverlayHue ?? 0 },
    topUvOverlaySaturationShift: { value: input.topUvOverlaySaturation ?? 0 },
    topUvOverlayLightnessShift: { value: input.topUvOverlayLightness ?? 0 },
    uvOverlayHueShift: { value: input.uvOverlayHue ?? 0 },
    uvOverlaySaturationShift: { value: input.uvOverlaySaturation ?? 0 },
    uvOverlayLightnessShift: { value: input.uvOverlayLightness ?? 0 },
  };
  const previewLighting = getPreviewLighting(input.previewLighting);
  uniforms.previewLightingEnabled = { value: previewLighting.enabled };
  uniforms.previewExposure = { value: previewLighting.exposure };
  uniforms.ambientLightIntensity = { value: previewLighting.ambientIntensity };
  uniforms.keyLightIntensity = { value: previewLighting.keyLightIntensity };
  uniforms.keyLightDirection = { value: previewLighting.keyLightDirection };
  if (input.baseTexture) prepareExistingBaseTexture(input.baseTexture);
  if (input.uvOverlayTexture) prepareUvTexture(input.uvOverlayTexture);
  if (input.topUvOverlayTexture) prepareUvTexture(input.topUvOverlayTexture);
  const disposableTextures: THREE.Texture[] = [neutralTexture];
  const captureObjectMatrices: Array<number[] | undefined> = [];
  const projectedTextures: THREE.Texture[] = [];
  const maskTextures: THREE.Texture[] = [];
  const depthTextures: THREE.Texture[] = [];
  const projectedArraySlices: number[] = [];
  const maskArraySlices: number[] = [];
  const depthArraySlices: number[] = [];

  const loadedLayers: typeof layers = [];
  const preparedLayers = await Promise.all(
    layers.map(async (layer) => {
      const requestedMask = Boolean(layer.useMask && layer.maskUrl);
      const requestedDepth = Boolean(layer.useDepthCheck && layer.depthUrl);
      const [texture, maskTexture, depthTexture] = await Promise.all([
        loadProjectedTexture(layer.imageUrl).catch((error) => {
          console.warn(
            '[Liclick 3D Texture] Could not load projected layer image; skipping layer in live preview.',
            error,
          );
          return undefined;
        }),
        requestedMask
          ? loadProjectedTexture(layer.maskUrl!, THREE.NoColorSpace, 'mask').catch((error) => {
              console.warn(
                '[Liclick 3D Texture] Could not load projected layer mask; keeping layer hidden.',
                error,
              );
              return undefined;
            })
          : Promise.resolve(undefined),
        requestedDepth
          ? loadProjectedTexture(layer.depthUrl!, THREE.NoColorSpace, 'depth').catch((error) => {
              console.warn(
                '[Liclick 3D Texture] Could not load projected layer depth; continuing without depth check.',
                error,
              );
              return undefined;
            })
          : Promise.resolve(undefined),
      ]);
      if (!texture) return undefined;
      return { layer, texture, maskTexture, depthTexture };
    }),
  );
  if (options.isCancelled?.()) {
    neutralTexture.dispose();
    return undefined;
  }

  for (const prepared of preparedLayers) {
    if (!prepared) continue;
    const { layer, texture, maskTexture, depthTexture } = prepared;
    const requestedMask = Boolean(layer.useMask && layer.maskUrl);
    const requestedDepth = Boolean(layer.useDepthCheck && layer.depthUrl);
    // Never reinterpret a masked layer as an unmasked layer. In particular, the
    // renderer-only local repaint preview is created before its first brush
    // upload; a transient mask lookup miss must not reveal its full source image.
    if (requestedMask && !maskTexture) continue;
    const index = loadedLayers.length;
    const shouldUseMask = requestedMask && Boolean(maskTexture);
    const shouldUseDepth = requestedDepth && Boolean(depthTexture);
    if (shouldUseMask) {
      maskTexture!.minFilter = THREE.LinearFilter;
      maskTexture!.magFilter = THREE.LinearFilter;
    }
    if (shouldUseDepth) {
      depthTexture!.minFilter = THREE.NearestFilter;
      depthTexture!.magFilter = THREE.NearestFilter;
    }

    const captureObjectMatrixWorld = layer.objectMatrixWorld ?? input.currentObjectMatrixWorld;
    const objectMatrixDelta = new THREE.Matrix4();
    if (captureObjectMatrixWorld && input.currentObjectMatrixWorld) {
      objectMatrixDelta
        .fromArray(captureObjectMatrixWorld)
        .multiply(new THREE.Matrix4().fromArray(input.currentObjectMatrixWorld).invert());
    }
    const objectNormalDelta = new THREE.Matrix3().getNormalMatrix(objectMatrixDelta);

    const usesProjectedArray = useTextureArrays && !isLiveProjectedCanvasUrl(layer.imageUrl);
    const usesMaskArray = useTextureArrays && !isLiveProjectedCanvasUrl(layer.maskUrl);
    const usesDepthArray = useTextureArrays && !isLiveProjectedCanvasUrl(layer.depthUrl);
    const projectedArraySlice = usesProjectedArray ? projectedTextures.length : -1;
    const maskArraySlice = shouldUseMask && usesMaskArray ? maskTextures.length : -1;
    const depthArraySlice = shouldUseDepth && usesDepthArray ? depthTextures.length : -1;
    if (!usesProjectedArray) {
      uniforms[`projectedMap${index}`] = { value: texture };
    }
    if (shouldUseMask && !usesMaskArray) uniforms[`maskMap${index}`] = { value: maskTexture };
    if (shouldUseDepth && !usesDepthArray) uniforms[`depthMap${index}`] = { value: depthTexture };
    uniforms[`projectorMatrix${index}`] = {
      value: buildProjectionMatrixBundle(layer.camera).projectorMatrix,
    };
    uniforms[`objectMatrixDelta${index}`] = { value: objectMatrixDelta };
    uniforms[`objectNormalDelta${index}`] = { value: objectNormalDelta };
    uniforms[`projectorPosition${index}`] = {
      value: new THREE.Vector3().fromArray(layer.camera.position),
    };
    uniforms[`layerOpacity${index}`] = { value: layer.visible ? layer.opacity : 0 };
    uniforms[`layerStrength${index}`] = { value: layer.strength ?? 1 };
    uniforms[`hueShift${index}`] = { value: layer.hue ?? 0 };
    uniforms[`saturationShift${index}`] = { value: layer.saturation ?? 0 };
    uniforms[`lightnessShift${index}`] = { value: layer.lightness ?? 0 };
    captureObjectMatrices.push(captureObjectMatrixWorld);
    if (usesProjectedArray) projectedTextures.push(texture);
    if (maskArraySlice >= 0) maskTextures.push(maskTexture!);
    if (depthArraySlice >= 0) depthTextures.push(depthTexture!);
    projectedArraySlices.push(projectedArraySlice);
    maskArraySlices.push(maskArraySlice);
    depthArraySlices.push(depthArraySlice);
    loadedLayers.push({ ...layer, useMask: shouldUseMask, useDepthCheck: shouldUseDepth });
  }
  if (loadedLayers.length === 0) return undefined;

  if (useTextureArrays) {
    const renderer = options.renderer;
    if (!renderer) throw new Error('Projected texture array renderer is unavailable.');
    const arrayPreviewSide = getProjectedArrayPreviewSide(
      renderer,
      projectedTextures.length + maskTextures.length + depthTextures.length,
    );
    try {
      const projectedArray =
        projectedTextures.length > 0
          ? await createProjectedTextureArray(
              renderer,
              projectedTextures,
              'image',
              options.isCancelled,
              arrayPreviewSide,
            )
          : undefined;
      if (projectedArray) disposableTextures.push(projectedArray.texture);
      const hasMasks = maskTextures.length > 0;
      const hasDepths = depthTextures.length > 0;
      const maskArray = hasMasks
        ? await createProjectedTextureArray(
            renderer,
            maskTextures,
            'mask',
            options.isCancelled,
            arrayPreviewSide,
          )
        : undefined;
      if (maskArray) disposableTextures.push(maskArray.texture);
      const depthArray = hasDepths
        ? await createProjectedTextureArray(
            renderer,
            depthTextures,
            'depth',
            options.isCancelled,
            arrayPreviewSide,
          )
        : undefined;
      if (depthArray) disposableTextures.push(depthArray.texture);
      if (projectedArray) uniforms.projectedMaps = { value: projectedArray.texture };
      if (maskArray) uniforms.maskMaps = { value: maskArray.texture };
      if (depthArray) uniforms.depthMaps = { value: depthArray.texture };
      for (let index = 0; index < loadedLayers.length; index += 1) {
        const projectedArraySlice = projectedArraySlices[index];
        const maskArraySlice = maskArraySlices[index];
        const depthArraySlice = depthArraySlices[index];
        if (projectedArraySlice >= 0 && projectedArray)
          uniforms[`projectedMapUvScale${index}`] = {
            value: projectedArray.uvScales[projectedArraySlice],
          };
        if (maskArraySlice >= 0 && maskArray)
          uniforms[`maskMapUvScale${index}`] = { value: maskArray.uvScales[maskArraySlice] };
        if (depthArraySlice >= 0 && depthArray)
          uniforms[`depthMapUvScale${index}`] = { value: depthArray.uvScales[depthArraySlice] };
      }
      // The cache keeps each source image in CPU memory, so release any previous
      // standalone GPU allocation after it has been copied into the arrays. This
      // prevents the direct-to-array transition from permanently doubling VRAM.
      for (const source of new Set([...projectedTextures, ...maskTextures, ...depthTextures])) {
        if (!source) continue;
        source.dispose();
        source.needsUpdate = true;
      }
    } catch (error) {
      for (const texture of disposableTextures) texture.dispose();
      throw error;
    }
  }

  const material = new THREE.ShaderMaterial({
    name: `LiclickProjectedLayerStack:${loadedLayers.map((layer) => layer.layerId).join(',')}`,
    vertexShader,
    fragmentShader: buildStackFragmentShader(loadedLayers, {
      useBaseMap: Boolean(input.baseTexture),
      useBaseRenderedColorMaskMap: Boolean(input.baseRenderedColorMaskTexture),
      useUvOverlayMap: Boolean(input.uvOverlayTexture),
      useTopUvOverlayMap: Boolean(input.topUvOverlayTexture),
      useTextureArrays,
    }),
    ...(useTextureArrays ? { glslVersion: THREE.GLSL3 } : {}),
    uniforms,
    toneMapped: true,
  });
  material.userData[GENERATED_MATERIAL_FLAG] = true;
  material.userData[PROJECTED_LAYER_SAMPLER_BUDGET_KEY] = samplerBudget;
  material.userData[DISPOSABLE_TEXTURES_KEY] = [...new Set(disposableTextures)];
  material.userData[PROJECTED_LAYER_STACK_STATE_KEY] = {
    signature: getProjectionLayerStructureSignature(loadedLayers, {
      useBaseMap: Boolean(input.baseTexture),
      useBaseRenderedColorMaskMap: Boolean(input.baseRenderedColorMaskTexture),
      useUvOverlayMap: Boolean(input.uvOverlayTexture),
      useTopUvOverlayMap: Boolean(input.topUvOverlayTexture),
      useTextureArrays,
    }),
    bindings: loadedLayers.map((layer, index) => ({
      layerId: layer.layerId,
      imageUrl: layer.imageUrl,
      projectedMapUniform:
        useTextureArrays && !isLiveProjectedCanvasUrl(layer.imageUrl)
          ? 'projectedMaps'
          : `projectedMap${index}`,
      opacityUniform: `layerOpacity${index}`,
      strengthUniform: `layerStrength${index}`,
      hueUniform: `hueShift${index}`,
      saturationUniform: `saturationShift${index}`,
      lightnessUniform: `lightnessShift${index}`,
    })),
    usesTextureArrays: useTextureArrays,
  } satisfies ProjectedLayerMaterialState;
  material.userData[PROJECTED_LAYER_MATERIAL_USER_DATA_KEY] = {
    layers: loadedLayers.map((_layer, index) => ({
      objectMatrixWorld: captureObjectMatrices[index],
      objectMatrixDeltaUniform: `objectMatrixDelta${index}`,
      objectNormalDeltaUniform: `objectNormalDelta${index}`,
    })),
  } satisfies ProjectedLayerProjectionData;
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

export function disposeGeneratedMaterialTree(
  material: THREE.Material | THREE.Material[] | undefined,
) {
  if (Array.isArray(material)) {
    material.forEach(disposeGeneratedMaterial);
    return;
  }
  if (material) disposeGeneratedMaterial(material);
}

export function createDisplayModeMaterial(
  displayMode: string,
  selected: boolean,
  bakedTexture?: THREE.Texture,
) {
  if (bakedTexture) {
    bakedTexture.colorSpace = THREE.SRGBColorSpace;
    bakedTexture.flipY = true;
    bakedTexture.wrapS = THREE.ClampToEdgeWrapping;
    bakedTexture.wrapT = THREE.ClampToEdgeWrapping;
    bakedTexture.minFilter = THREE.LinearFilter;
    bakedTexture.magFilter = THREE.LinearFilter;
    bakedTexture.generateMipmaps = false;
    bakedTexture.anisotropy = 8;
    bakedTexture.needsUpdate = true;
  }
  if (displayMode === 'normal') return markGeneratedMaterial(new THREE.MeshNormalMaterial());
  if (displayMode === 'wire') {
    return markGeneratedMaterial(
      new THREE.MeshStandardMaterial({
        color: DEFAULT_WIRE_COLOR,
        roughness: 0.94,
        metalness: 0,
      }),
    );
  }
  if (displayMode === 'flat') {
    if (bakedTexture) {
      return markGeneratedMaterial(
        new THREE.MeshStandardMaterial({
          color: '#ffffff',
          map: bakedTexture,
          roughness: 0.92,
          metalness: 0,
          emissive: '#ffffff',
          emissiveMap: bakedTexture,
          emissiveIntensity: 0.18,
        }),
      );
    }
    const material = markGeneratedMaterial(
      new THREE.MeshStandardMaterial({
        color: DEFAULT_FLAT_COLOR,
        roughness: 0.96,
        metalness: 0,
        emissive: '#ffffff',
        emissiveIntensity: 0.04,
      }),
    );
    return material;
  }

  const material = markGeneratedMaterial(
    new THREE.MeshStandardMaterial({
      color: bakedTexture ? '#ffffff' : DEFAULT_PREVIEW_COLOR,
      roughness: 0.58,
      metalness: 0,
      emissive: !bakedTexture && selected ? '#3b0764' : '#000000',
      emissiveIntensity: !bakedTexture && selected ? 0.2 : 0,
    }),
  );
  if (bakedTexture) material.map = bakedTexture;
  return material;
}

const uvOverlayFragmentShader = `
  uniform sampler2D baseMap;
  uniform sampler2D baseRenderedColorMaskMap;
  uniform sampler2D uvOverlayMap;
  uniform sampler2D liveUvOverlayMap;
  uniform sampler2D surfaceMaskMap;
  uniform float useBaseMap;
  uniform float useBaseRenderedColorMaskMap;
  uniform float useUvOverlayMap;
  uniform float useLiveUvOverlayMap;
  uniform float liveUvOverlayOpacity;
  uniform float liveUvOverlayRenderedColor;
  uniform float uvOverlayHueShift;
  uniform float uvOverlaySaturationShift;
  uniform float uvOverlayLightnessShift;
  uniform float liveUvOverlayHueShift;
  uniform float liveUvOverlaySaturationShift;
  uniform float liveUvOverlayLightnessShift;
  uniform float useSurfaceMaskMap;
  uniform float showEmptyUvChecker;
  uniform vec3 baseColor;
  uniform float previewLightingEnabled;
  uniform float previewExposure;
  uniform float ambientLightIntensity;
  uniform float keyLightIntensity;
  uniform vec3 keyLightDirection;
  varying vec3 vWorldNormal;
  varying vec2 vUv;

  vec3 linearToSrgb(vec3 color) {
    vec3 low = color * 12.92;
    vec3 high = 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(low, high, step(vec3(0.0031308), color));
  }

  vec3 srgbToLinear(vec3 color) {
    vec3 low = color / 12.92;
    vec3 high = pow(max((color + 0.055) / 1.055, vec3(0.0)), vec3(2.4));
    return mix(low, high, step(vec3(0.04045), color));
  }

  vec3 rgbToHsv(vec3 color) {
    vec4 k = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(color.bg, k.wz), vec4(color.gb, k.xy), step(color.b, color.g));
    vec4 q = mix(vec4(p.xyw, color.r), vec4(color.r, p.yzx), step(p.x, color.r));
    float delta = q.x - min(q.w, q.y);
    float epsilon = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * delta + epsilon)), delta / (q.x + epsilon), q.x);
  }

  vec3 hsvToRgb(vec3 hsv) {
    vec3 channels = abs(fract(hsv.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return hsv.z * mix(vec3(1.0), clamp(channels - 1.0, 0.0, 1.0), hsv.y);
  }

  vec3 applyHsvAdjustments(vec3 color, float hue, float saturation, float lightness) {
    if (abs(hue) < 0.0001 && abs(saturation) < 0.0001 && abs(lightness) < 0.0001) return color;
    vec3 hsv = rgbToHsv(linearToSrgb(clamp(color, 0.0, 1.0)));
    hsv.x = mod(hsv.x + hue + 1.0, 1.0);
    hsv.y = clamp(hsv.y + saturation, 0.0, 1.0);
    hsv.z = clamp(hsv.z + lightness, 0.0, 1.0);
    return srgbToLinear(hsvToRgb(hsv));
  }

  float computePreviewLight(vec3 normal) {
    vec3 lightDir = normalize(keyLightDirection);
    float diffuse = max(dot(normal, lightDir), 0.0);
    float lit = clamp(ambientLightIntensity + diffuse * keyLightIntensity * 0.55, 0.0, 2.0);
    return mix(1.0, lit, previewLightingEnabled);
  }

  vec3 computeUvEmptyPreviewColor() {
    float stripe = step(0.5, fract((gl_FragCoord.x - gl_FragCoord.y) * 0.095));
    return mix(vec3(0.012), vec3(0.09), stripe * 0.62);
  }

  void main() {
    vec3 normal = normalize(vWorldNormal);
    float lambert = computePreviewLight(normal);
    vec4 baseTexel = texture2D(baseMap, vUv);
    float baseRenderedColor = texture2D(baseRenderedColorMaskMap, vUv).r * useBaseRenderedColorMaskMap;
    vec4 overlayTexel = texture2D(uvOverlayMap, vUv);
    vec4 liveOverlayTexel = texture2D(liveUvOverlayMap, vUv);
    overlayTexel.rgb = applyHsvAdjustments(
      overlayTexel.rgb,
      uvOverlayHueShift,
      uvOverlaySaturationShift,
      uvOverlayLightnessShift
    );
    liveOverlayTexel.rgb = applyHsvAdjustments(
      liveOverlayTexel.rgb,
      liveUvOverlayHueShift,
      liveUvOverlaySaturationShift,
      liveUvOverlayLightnessShift
    );
    vec4 surfaceMaskTexel = texture2D(surfaceMaskMap, vec2(vUv.x, 1.0 - vUv.y));
    vec3 baseSurface = mix(baseColor, baseTexel.rgb, useBaseMap * baseTexel.a);
    float surfaceMask = mix(1.0, max(surfaceMaskTexel.r, max(surfaceMaskTexel.g, surfaceMaskTexel.b)), useSurfaceMaskMap);
    baseSurface = mix(baseColor, baseSurface, surfaceMask);
    vec3 uvPreviewBase = computeUvEmptyPreviewColor();
    float overlayAlpha = overlayTexel.a * useUvOverlayMap;
    float liveOverlayAlpha = liveOverlayTexel.a * useLiveUvOverlayMap * liveUvOverlayOpacity;
    float hasUvOverlay = max(useUvOverlayMap, useLiveUvOverlayMap);
    vec3 surfaceColor = mix(baseSurface, uvPreviewBase, hasUvOverlay * showEmptyUvChecker);
    surfaceColor = mix(surfaceColor, overlayTexel.rgb, overlayAlpha);
    float remainingTransparency = (1.0 - overlayAlpha) * (1.0 - liveOverlayAlpha);
    float lighting = mix(lambert, 1.0, hasUvOverlay * showEmptyUvChecker * remainingTransparency * 0.45);
    vec3 liveOverlayDisplayColor = liveOverlayTexel.rgb * mix(
      lighting,
      1.0 / max(previewExposure, 0.0001),
      liveUvOverlayRenderedColor
    );
    float renderedColorExposureCompensation = 1.0 / max(previewExposure, 0.0001);
    vec3 litBaseSurface = mix(
      baseColor * lighting,
      baseTexel.rgb * mix(lighting, renderedColorExposureCompensation, baseRenderedColor),
      useBaseMap * baseTexel.a
    );
    litBaseSurface = mix(baseColor * lighting, litBaseSurface, surfaceMask);
    surfaceColor = mix(litBaseSurface, surfaceColor * lighting, max(overlayAlpha, showEmptyUvChecker * hasUvOverlay));
    vec3 displayColor = mix(surfaceColor, liveOverlayDisplayColor, liveOverlayAlpha);
    gl_FragColor = vec4(clamp(displayColor, 0.0, 1.0), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export type UvOverlayPreviewMaterialInput = {
  displayMode: string;
  selected: boolean;
  uvOverlayTexture?: THREE.Texture;
  uvOverlayHue?: number;
  uvOverlaySaturation?: number;
  uvOverlayLightness?: number;
  liveUvOverlayTexture?: THREE.Texture;
  liveUvOverlayOpacity?: number;
  liveUvOverlayRenderedColor?: boolean;
  liveUvOverlayHue?: number;
  liveUvOverlaySaturation?: number;
  liveUvOverlayLightness?: number;
  surfaceMaskTexture?: THREE.Texture;
  baseTexture?: THREE.Texture;
  baseRenderedColorMaskTexture?: THREE.Texture;
  baseColor?: THREE.ColorRepresentation;
  previewLighting?: ProjectionPreviewLighting;
  showEmptyUvChecker?: boolean;
};

export function createUvOverlayPreviewMaterial(input: UvOverlayPreviewMaterialInput) {
  if (input.displayMode === 'normal') return markGeneratedMaterial(new THREE.MeshNormalMaterial());
  if (input.displayMode === 'wire') {
    return markGeneratedMaterial(
      new THREE.MeshStandardMaterial({
        color: DEFAULT_WIRE_COLOR,
        roughness: 0.94,
        metalness: 0,
      }),
    );
  }

  const whitePixel = new Uint8Array([255, 255, 255, 255]);
  const neutralTexture = new THREE.DataTexture(whitePixel, 1, 1, THREE.RGBAFormat);
  neutralTexture.needsUpdate = true;
  neutralTexture.flipY = false;

  if (input.uvOverlayTexture) prepareUvTexture(input.uvOverlayTexture);
  if (input.liveUvOverlayTexture) prepareUvTexture(input.liveUvOverlayTexture);
  if (input.baseTexture) prepareExistingBaseTexture(input.baseTexture);
  const previewLighting = getPreviewLighting(input.previewLighting);

  const material = new THREE.ShaderMaterial({
    name: 'LiclickUvOverlayPreview',
    vertexShader,
    fragmentShader: uvOverlayFragmentShader,
    uniforms: {
      baseMap: { value: input.baseTexture ?? neutralTexture },
      baseRenderedColorMaskMap: { value: input.baseRenderedColorMaskTexture ?? neutralTexture },
      uvOverlayMap: { value: input.uvOverlayTexture ?? neutralTexture },
      liveUvOverlayMap: { value: input.liveUvOverlayTexture ?? neutralTexture },
      surfaceMaskMap: { value: input.surfaceMaskTexture ?? neutralTexture },
      useBaseMap: { value: input.baseTexture ? 1 : 0 },
      useBaseRenderedColorMaskMap: { value: input.baseRenderedColorMaskTexture ? 1 : 0 },
      useUvOverlayMap: { value: input.uvOverlayTexture ? 1 : 0 },
      useLiveUvOverlayMap: { value: input.liveUvOverlayTexture ? 1 : 0 },
      liveUvOverlayOpacity: { value: THREE.MathUtils.clamp(input.liveUvOverlayOpacity ?? 1, 0, 1) },
      liveUvOverlayRenderedColor: { value: input.liveUvOverlayRenderedColor ? 1 : 0 },
      uvOverlayHueShift: { value: input.uvOverlayHue ?? 0 },
      uvOverlaySaturationShift: { value: input.uvOverlaySaturation ?? 0 },
      uvOverlayLightnessShift: { value: input.uvOverlayLightness ?? 0 },
      liveUvOverlayHueShift: { value: input.liveUvOverlayHue ?? 0 },
      liveUvOverlaySaturationShift: { value: input.liveUvOverlaySaturation ?? 0 },
      liveUvOverlayLightnessShift: { value: input.liveUvOverlayLightness ?? 0 },
      useSurfaceMaskMap: { value: input.surfaceMaskTexture ? 1 : 0 },
      showEmptyUvChecker: { value: input.showEmptyUvChecker === true ? 1 : 0 },
      baseColor: { value: new THREE.Color(input.baseColor ?? DEFAULT_PREVIEW_COLOR) },
      previewLightingEnabled: { value: previewLighting.enabled },
      previewExposure: { value: previewLighting.exposure },
      ambientLightIntensity: { value: previewLighting.ambientIntensity },
      keyLightIntensity: { value: previewLighting.keyLightIntensity },
      keyLightDirection: { value: previewLighting.keyLightDirection },
    },
    toneMapped: true,
  });
  material.userData[GENERATED_MATERIAL_FLAG] = true;
  material.userData[UV_OVERLAY_PREVIEW_MATERIAL_FLAG] = true;
  material.userData[DISPOSABLE_TEXTURES_KEY] = [neutralTexture];
  return material;
}

export function updateUvOverlayPreviewMaterial(
  material: THREE.Material | THREE.Material[] | undefined,
  input: UvOverlayPreviewMaterialInput,
) {
  if (!(material instanceof THREE.ShaderMaterial)) return false;
  if (!material.userData[UV_OVERLAY_PREVIEW_MATERIAL_FLAG]) return false;
  if (input.displayMode === 'normal' || input.displayMode === 'wire') return false;
  const neutralTexture = (
    material.userData[DISPOSABLE_TEXTURES_KEY] as THREE.Texture[] | undefined
  )?.[0];
  if (!neutralTexture) return false;
  if (input.uvOverlayTexture) prepareUvTexture(input.uvOverlayTexture);
  if (input.liveUvOverlayTexture) prepareUvTexture(input.liveUvOverlayTexture);
  if (input.baseTexture) prepareExistingBaseTexture(input.baseTexture);
  const previewLighting = getPreviewLighting(input.previewLighting);
  const uniforms = material.uniforms;
  uniforms.baseMap.value = input.baseTexture ?? neutralTexture;
  uniforms.baseRenderedColorMaskMap.value = input.baseRenderedColorMaskTexture ?? neutralTexture;
  uniforms.uvOverlayMap.value = input.uvOverlayTexture ?? neutralTexture;
  uniforms.liveUvOverlayMap.value = input.liveUvOverlayTexture ?? neutralTexture;
  uniforms.surfaceMaskMap.value = input.surfaceMaskTexture ?? neutralTexture;
  uniforms.useBaseMap.value = input.baseTexture ? 1 : 0;
  uniforms.useBaseRenderedColorMaskMap.value = input.baseRenderedColorMaskTexture ? 1 : 0;
  uniforms.useUvOverlayMap.value = input.uvOverlayTexture ? 1 : 0;
  uniforms.useLiveUvOverlayMap.value = input.liveUvOverlayTexture ? 1 : 0;
  uniforms.liveUvOverlayOpacity.value = THREE.MathUtils.clamp(
    input.liveUvOverlayOpacity ?? 1,
    0,
    1,
  );
  uniforms.liveUvOverlayRenderedColor.value = input.liveUvOverlayRenderedColor ? 1 : 0;
  uniforms.uvOverlayHueShift.value = input.uvOverlayHue ?? 0;
  uniforms.uvOverlaySaturationShift.value = input.uvOverlaySaturation ?? 0;
  uniforms.uvOverlayLightnessShift.value = input.uvOverlayLightness ?? 0;
  uniforms.liveUvOverlayHueShift.value = input.liveUvOverlayHue ?? 0;
  uniforms.liveUvOverlaySaturationShift.value = input.liveUvOverlaySaturation ?? 0;
  uniforms.liveUvOverlayLightnessShift.value = input.liveUvOverlayLightness ?? 0;
  uniforms.useSurfaceMaskMap.value = input.surfaceMaskTexture ? 1 : 0;
  uniforms.showEmptyUvChecker.value = input.showEmptyUvChecker === true ? 1 : 0;
  uniforms.baseColor.value.set(input.baseColor ?? DEFAULT_PREVIEW_COLOR);
  uniforms.previewLightingEnabled.value = previewLighting.enabled;
  uniforms.previewExposure.value = previewLighting.exposure;
  uniforms.ambientLightIntensity.value = previewLighting.ambientIntensity;
  uniforms.keyLightIntensity.value = previewLighting.keyLightIntensity;
  uniforms.keyLightDirection.value.copy(previewLighting.keyLightDirection);
  return true;
}

function prepareSinglePreviewMaterial(material: THREE.Material, bakedTexture?: THREE.Texture) {
  if (bakedTexture) {
    return markGeneratedMaterial(
      new THREE.MeshStandardMaterial({
        color: '#ffffff',
        map: bakedTexture,
        roughness:
          material instanceof THREE.MeshStandardMaterial
            ? Math.max(0.42, material.roughness)
            : 0.58,
        metalness:
          material instanceof THREE.MeshStandardMaterial ? Math.min(0.18, material.metalness) : 0,
        emissive: '#000000',
        emissiveIntensity: 0,
      }),
    );
  }
  if (
    material instanceof THREE.MeshStandardMaterial ||
    material instanceof THREE.MeshPhysicalMaterial
  ) {
    const previewMaterial = material.clone();
    if (previewMaterial.map) {
      previewMaterial.map.colorSpace = THREE.SRGBColorSpace;
      previewMaterial.map.needsUpdate = true;
    }
    if (!previewMaterial.map) {
      previewMaterial.color.set(DEFAULT_PREVIEW_COLOR);
    }
    previewMaterial.roughness = Number.isFinite(previewMaterial.roughness)
      ? Math.max(0.46, previewMaterial.roughness)
      : 0.58;
    previewMaterial.metalness = Number.isFinite(previewMaterial.metalness)
      ? Math.min(0.25, previewMaterial.metalness)
      : 0;
    previewMaterial.needsUpdate = true;
    return markGeneratedMaterial(previewMaterial);
  }
  const sourceMap =
    'map' in material && material.map instanceof THREE.Texture ? material.map : undefined;
  const sourceColor =
    'color' in material && material.color instanceof THREE.Color
      ? material.color
      : new THREE.Color('#ffffff');
  if (sourceMap) {
    sourceMap.colorSpace = THREE.SRGBColorSpace;
    sourceMap.needsUpdate = true;
    return markGeneratedMaterial(
      new THREE.MeshStandardMaterial({
        color: sourceColor,
        map: sourceMap,
        roughness: 0.68,
        metalness: 0,
        transparent: material.transparent,
        opacity: material.opacity,
        alphaTest: material.alphaTest,
        side: material.side,
      }),
    );
  }
  return markGeneratedMaterial(
    new THREE.MeshStandardMaterial({
      color: DEFAULT_PREVIEW_COLOR,
      roughness: 0.58,
      metalness: 0,
    }),
  );
}

function prepareSingleFlatMaterial(material: THREE.Material, bakedTexture?: THREE.Texture) {
  const map =
    bakedTexture ??
    ('map' in material && material.map instanceof THREE.Texture ? material.map : undefined);
  if (!map) return createDisplayModeMaterial('flat', false);
  map.colorSpace = THREE.SRGBColorSpace;
  map.needsUpdate = true;
  const color = bakedTexture
    ? new THREE.Color('#ffffff')
    : 'color' in material && material.color instanceof THREE.Color
      ? material.color
      : new THREE.Color('#ffffff');
  return markGeneratedMaterial(
    new THREE.MeshBasicMaterial({
      color,
      map,
      transparent: material.transparent,
      opacity: material.opacity,
      alphaTest: material.alphaTest,
      side: material.side,
      toneMapped: true,
    }),
  );
}

export function createFlatPreviewMaterial(
  originalMaterial: THREE.Material | THREE.Material[] | undefined,
  selected: boolean,
  bakedTexture?: THREE.Texture,
) {
  if (!originalMaterial) return createDisplayModeMaterial('flat', selected, bakedTexture);
  return Array.isArray(originalMaterial)
    ? originalMaterial.map((material) => prepareSingleFlatMaterial(material, bakedTexture))
    : prepareSingleFlatMaterial(originalMaterial, bakedTexture);
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
