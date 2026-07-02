import * as THREE from 'three';
import type { ProjectionLayerInput, ProjectionLayerStackInput, ProjectionPreviewLighting } from './projectionTypes';
import { buildProjectionMatrixBundle } from './projectionMath';

const DEFAULT_PREVIEW_COLOR = '#f0f1ee';
const DEFAULT_FLAT_COLOR = '#f4f5f2';
const DEFAULT_WIRE_COLOR = '#e9ebe8';
const GENERATED_MATERIAL_FLAG = 'liclickGeneratedMaterial';
const DISPOSABLE_TEXTURES_KEY = 'liclickDisposableTextures';
const DISPOSED_MATERIAL_FLAG = 'liclickDisposedMaterial';
export const PROJECTED_LAYER_MATERIAL_USER_DATA_KEY = 'liclickProjectedLayerProjectionData';
export type ProjectedLayerProjectionData = {
  layers: Array<{
    objectMatrixWorld?: number[];
    objectMatrixDeltaUniform: string;
    objectNormalDeltaUniform: string;
  }>;
};
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
  ambientIntensity: 0.5,
  keyLightIntensity: 1.22,
  keyLightDirection: [0.35, 0.7, 0.45],
};

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
  uniform sampler2D maskMap;
  uniform sampler2D depthMap;
  uniform mat4 projectorMatrix;
  uniform mat4 objectMatrixDelta;
  uniform mat3 objectNormalDelta;
  uniform vec3 projectorPosition;
  uniform float layerOpacity;
  uniform float layerStrength;
  uniform float useMask;
  uniform float useDepthCheck;
  uniform float enableBackfaceCulling;
  uniform float edgeFeather;
  uniform float depthBias;
  uniform float hueShift;
  uniform float saturationShift;
  uniform float lightnessShift;
  uniform float useBaseMap;
  uniform float useUvOverlayMap;
  uniform float previewLightingEnabled;
  uniform float ambientLightIntensity;
  uniform float keyLightIntensity;
  uniform vec3 keyLightDirection;
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

  vec3 linearToSrgb(vec3 color) {
    vec3 cutoff = step(color, vec3(0.0031308));
    vec3 lower = color * 12.92;
    vec3 higher = 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(higher, lower, cutoff);
  }

  float computePreviewLight(vec3 normal) {
    vec3 lightDir = normalize(keyLightDirection);
    float diffuse = max(dot(normal, lightDir), 0.0);
    float lit = clamp(ambientLightIntensity + diffuse * keyLightIntensity * 0.55, 0.0, 2.0);
    return mix(1.0, lit, previewLightingEnabled);
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

    vec4 maskTexel = texture2D(maskMap, uv);
    float maskValue = dot(maskTexel.rgb, vec3(0.299, 0.587, 0.114));
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
    texel.rgb = applyHslAdjustments(texel.rgb);
    float sourceAlpha = texel.a * maskAlpha;
    float alphaCoverage = step(0.01, sourceAlpha);
    float angleCoverage = smoothstep(${NDV_COVERAGE_START.toFixed(2)}, ${NDV_COVERAGE_END.toFixed(2)}, ndv);
    float coverageEdge = computeImageEdgeFade(uv, ${IMAGE_COVERAGE_EDGE_FADE.toFixed(3)});
    float coverage = clamp(layerOpacity * sourceAlpha * angleCoverage * mix(0.35, 1.0, coverageEdge), 0.0, 1.0);
    float angleWeight = computeAngleWeight(ndv, layerStrength);
    float qualityEdge = computeImageEdgeFade(uv, ${IMAGE_QUALITY_EDGE_FADE.toFixed(3)});
    float quality = coverage * depthWeight * angleWeight * mix(0.3, 1.0, qualityEdge);
    float projectionAlpha = inside * backfaceAlpha * alphaCoverage * coverage * step(${COVERAGE_THRESHOLD.toFixed(2)}, coverage);
    vec4 baseTexel = texture2D(baseMap, vUv);
    vec4 uvOverlayTexel = texture2D(uvOverlayMap, vUv);
    vec3 baseSurfaceColor = mix(baseColor, baseTexel.rgb, useBaseMap);
    vec3 mixedColor = mix(baseSurfaceColor, texel.rgb, projectionAlpha);
    mixedColor = mix(mixedColor, uvOverlayTexel.rgb, uvOverlayTexel.a * useUvOverlayMap);
    mixedColor *= lambert;

    gl_FragColor = vec4(linearToSrgb(clamp(mixedColor, 0.0, 1.0)), 1.0);
  }
`;

function buildStackFragmentShader(layers: Array<{ useMask?: boolean; useDepthCheck?: boolean; maskUrl?: string; depthUrl?: string }>) {
  const layerCount = layers.length;
  const layerUsesMask = (index: number) => Boolean(layers[index].useMask && layers[index].maskUrl);
  const layerUsesDepth = (index: number) => Boolean(layers[index].useDepthCheck && layers[index].depthUrl);
  const uniformDeclarations = Array.from({ length: layerCount }, (_, index) => `
  uniform sampler2D projectedMap${index};
  ${layerUsesMask(index) ? `uniform sampler2D maskMap${index};` : ''}
  ${layerUsesDepth(index) ? `uniform sampler2D depthMap${index};` : ''}
  uniform mat4 projectorMatrix${index};
  uniform mat4 objectMatrixDelta${index};
  uniform mat3 objectNormalDelta${index};
  uniform vec3 projectorPosition${index};
  uniform float layerOpacity${index};
  uniform float layerStrength${index};
  uniform float layerBlendMode${index};
  uniform float hueShift${index};
  uniform float saturationShift${index};
  uniform float lightnessShift${index};
`).join('');

  const blendEvaluations = Array.from({ length: layerCount }, (_, index) => `
    {
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

      float maskAlpha = ${layerUsesMask(index) ? `dot(texture2D(maskMap${index}, uv).rgb, vec3(0.299, 0.587, 0.114))` : '1.0'};

      float projectedDepth = ndc.z * 0.5 + 0.5;
      float depthWeight = ${layerUsesDepth(index)
        ? `0.2 + 0.8 * exp(-pow(abs(projectedDepth - unpackDepth(texture2D(depthMap${index}, uv))) / max(${DEPTH_EPSILON.toFixed(2)}, 0.000001), 2.0))`
        : '1.0'};

      vec4 texel = texture2D(projectedMap${index}, uv);
      texel.rgb = applyHslAdjustments(texel.rgb, hueShift${index}, saturationShift${index}, lightnessShift${index});
      float sourceAlpha = texel.a * maskAlpha;
      float alphaCoverage = step(0.01, sourceAlpha);
      float angleCoverage = smoothstep(${NDV_COVERAGE_START.toFixed(2)}, ${NDV_COVERAGE_END.toFixed(2)}, ndv);
      float coverageEdge = computeImageEdgeFade(uv, ${IMAGE_COVERAGE_EDGE_FADE.toFixed(3)});
      float coverage = clamp(layerOpacity${index} * sourceAlpha * angleCoverage * mix(0.35, 1.0, coverageEdge), 0.0, 1.0);
      float angleWeight = computeAngleWeight(ndv, layerStrength${index});
      float qualityEdge = computeImageEdgeFade(uv, ${IMAGE_QUALITY_EDGE_FADE.toFixed(3)});
      float quality = coverage * depthWeight * angleWeight * mix(0.3, 1.0, qualityEdge);
      if (layerBlendMode${index} < 0.5 && inside * backfaceAlpha * alphaCoverage > 0.5 && coverage > ${COVERAGE_THRESHOLD.toFixed(2)}) {
        insertBlendCandidate(texel.rgb, coverage, quality);
      }
    }
`).join('');

  const overlayEvaluations = Array.from({ length: layerCount }, (_, index) => `
    {
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

      float maskAlpha = ${layerUsesMask(index) ? `dot(texture2D(maskMap${index}, uv).rgb, vec3(0.299, 0.587, 0.114))` : '1.0'};

      float projectedDepth = ndc.z * 0.5 + 0.5;
      float depthWeight = ${layerUsesDepth(index)
        ? `0.2 + 0.8 * exp(-pow(abs(projectedDepth - unpackDepth(texture2D(depthMap${index}, uv))) / max(${DEPTH_EPSILON.toFixed(2)}, 0.000001), 2.0))`
        : '1.0'};

      vec4 texel = texture2D(projectedMap${index}, uv);
      texel.rgb = applyHslAdjustments(texel.rgb, hueShift${index}, saturationShift${index}, lightnessShift${index});
      float sourceAlpha = texel.a * maskAlpha;
      float alphaCoverage = step(0.01, sourceAlpha);
      float angleCoverage = smoothstep(${NDV_COVERAGE_START.toFixed(2)}, ${NDV_COVERAGE_END.toFixed(2)}, ndv);
      float coverageEdge = computeImageEdgeFade(uv, ${IMAGE_COVERAGE_EDGE_FADE.toFixed(3)});
      float coverage = clamp(layerOpacity${index} * sourceAlpha * angleCoverage * mix(0.35, 1.0, coverageEdge), 0.0, 1.0);
      float angleWeight = computeAngleWeight(ndv, layerStrength${index});
      float qualityEdge = computeImageEdgeFade(uv, ${IMAGE_QUALITY_EDGE_FADE.toFixed(3)});
      float quality = coverage * depthWeight * angleWeight * mix(0.3, 1.0, qualityEdge);
      if (layerBlendMode${index} > 0.5 && inside * backfaceAlpha * alphaCoverage > 0.5 && coverage > ${COVERAGE_THRESHOLD.toFixed(2)}) {
        float qualityFade = smoothstep(0.0, 0.15, max(quality, coverage * 0.25));
        float overlayAlpha = clamp(coverage * mix(0.75, 1.0, qualityFade), 0.0, 1.0);
        mixedColor = mix(mixedColor, texel.rgb, overlayAlpha);
      }
    }
`).join('');

  return `
  ${uniformDeclarations}
  uniform float enableBackfaceCulling;
  uniform float edgeFeather;
  uniform float depthBias;
  uniform sampler2D baseMap;
  uniform sampler2D uvOverlayMap;
  uniform float useBaseMap;
  uniform float useUvOverlayMap;
  uniform float previewLightingEnabled;
  uniform float ambientLightIntensity;
  uniform float keyLightIntensity;
  uniform vec3 keyLightDirection;
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

  vec3 linearToSrgb(vec3 color) {
    vec3 cutoff = step(color, vec3(0.0031308));
    vec3 lower = color * 12.92;
    vec3 higher = 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(higher, lower, cutoff);
  }

  float computePreviewLight(vec3 normal) {
    vec3 lightDir = normalize(keyLightDirection);
    float diffuse = max(dot(normal, lightDir), 0.0);
    float lit = clamp(ambientLightIntensity + diffuse * keyLightIntensity * 0.55, 0.0, 2.0);
    return mix(1.0, lit, previewLightingEnabled);
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
    vec4 baseTexel = texture2D(baseMap, vUv);
    vec4 uvOverlayTexel = texture2D(uvOverlayMap, vUv);
    vec3 baseSurfaceColor = mix(baseColor, baseTexel.rgb, useBaseMap);
    vec3 shadedBase = baseSurfaceColor;
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

    vec3 mixedColor = composeBlendBase(shadedBase);
    ${overlayEvaluations}
    mixedColor = mix(mixedColor, uvOverlayTexel.rgb, uvOverlayTexel.a * useUvOverlayMap);
    mixedColor *= lambert;
    gl_FragColor = vec4(linearToSrgb(clamp(mixedColor, 0.0, 1.0)), 1.0);
  }
`;
}

function getPreviewLighting(input?: ProjectionPreviewLighting) {
  const lighting = input ?? DEFAULT_PREVIEW_LIGHTING;
  const direction = new THREE.Vector3(...lighting.keyLightDirection);
  if (direction.lengthSq() <= 0.000001) direction.set(...DEFAULT_PREVIEW_LIGHTING.keyLightDirection);
  direction.normalize();
  return {
    enabled: lighting.enabled ? 1 : 0,
    ambientIntensity: Math.max(0, lighting.ambientIntensity),
    keyLightIntensity: Math.max(0, lighting.keyLightIntensity),
    keyLightDirection: direction,
  };
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
  const maskTexture = input.maskUrl
    ? await new THREE.TextureLoader().loadAsync(input.maskUrl).catch((error) => {
        console.warn('[Liclick 3D Texture] Could not load projected layer mask; continuing without mask.', error);
        return neutralTexture;
      })
    : neutralTexture;
  const depthTexture = input.depthUrl
    ? await new THREE.TextureLoader().loadAsync(input.depthUrl).catch((error) => {
        console.warn('[Liclick 3D Texture] Could not load projected layer depth; continuing without depth check.', error);
        return neutralTexture;
      })
    : neutralTexture;
  const baseTexture = input.baseTexture ?? neutralTexture;
  const uvOverlayTexture = input.uvOverlayTexture ?? neutralTexture;
  if (input.baseTexture) {
    input.baseTexture.colorSpace = THREE.SRGBColorSpace;
    input.baseTexture.flipY = false;
    input.baseTexture.wrapS = THREE.ClampToEdgeWrapping;
    input.baseTexture.wrapT = THREE.ClampToEdgeWrapping;
    input.baseTexture.minFilter = THREE.LinearMipmapLinearFilter;
    input.baseTexture.magFilter = THREE.LinearFilter;
    input.baseTexture.generateMipmaps = true;
  }
  if (input.uvOverlayTexture) {
    input.uvOverlayTexture.colorSpace = THREE.SRGBColorSpace;
    input.uvOverlayTexture.flipY = false;
    input.uvOverlayTexture.wrapS = THREE.ClampToEdgeWrapping;
    input.uvOverlayTexture.wrapT = THREE.ClampToEdgeWrapping;
    input.uvOverlayTexture.minFilter = THREE.LinearMipmapLinearFilter;
    input.uvOverlayTexture.magFilter = THREE.LinearFilter;
    input.uvOverlayTexture.generateMipmaps = true;
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
  const previewLighting = getPreviewLighting(input.previewLighting);
  const material = new THREE.ShaderMaterial({
    name: `LiclickProjectedLayer:${input.layerId}`,
    vertexShader,
    fragmentShader,
    uniforms: {
      projectedMap: { value: texture },
      baseMap: { value: baseTexture },
      uvOverlayMap: { value: uvOverlayTexture },
      maskMap: { value: maskTexture },
      depthMap: { value: depthTexture },
      projectorMatrix: { value: buildProjectionMatrixBundle(input.camera).projectorMatrix },
      objectMatrixDelta: { value: objectMatrixDelta },
      objectNormalDelta: { value: objectNormalDelta },
      projectorPosition: { value: new THREE.Vector3().fromArray(input.camera.position) },
      layerOpacity: { value: input.opacity },
      layerStrength: { value: input.strength ?? 1 },
      useMask: { value: input.useMask && input.maskUrl && maskTexture !== neutralTexture ? 1 : 0 },
      useDepthCheck: { value: input.useDepthCheck && input.depthUrl && depthTexture !== neutralTexture ? 1 : 0 },
      enableBackfaceCulling: { value: input.enableBackfaceCulling === false ? 0 : 1 },
      edgeFeather: { value: input.edgeFeather ?? 0.035 },
      depthBias: { value: input.depthBias ?? 0.025 },
      hueShift: { value: input.hue ?? 0 },
      saturationShift: { value: input.saturation ?? 0 },
      lightnessShift: { value: input.lightness ?? 0 },
      baseColor: { value: new THREE.Color(input.baseColor ?? DEFAULT_PREVIEW_COLOR) },
      useBaseMap: { value: input.baseTexture ? 1 : 0 },
      useUvOverlayMap: { value: input.uvOverlayTexture ? 1 : 0 },
      previewLightingEnabled: { value: previewLighting.enabled },
      ambientLightIntensity: { value: previewLighting.ambientIntensity },
      keyLightIntensity: { value: previewLighting.keyLightIntensity },
      keyLightDirection: { value: previewLighting.keyLightDirection },
    },
    toneMapped: false,
  });
  material.userData[GENERATED_MATERIAL_FLAG] = true;
  material.userData[DISPOSABLE_TEXTURES_KEY] = [...new Set([texture, maskTexture, depthTexture])];
  material.userData[PROJECTED_LAYER_MATERIAL_USER_DATA_KEY] = {
    layers: [
      {
        objectMatrixWorld: input.objectMatrixWorld,
        objectMatrixDeltaUniform: 'objectMatrixDelta',
        objectNormalDeltaUniform: 'objectNormalDelta',
      },
    ],
  } satisfies ProjectedLayerProjectionData;
  return material;
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
      strength: layer.strength,
      blendMode: layer.blendMode,
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
    baseColor: { value: new THREE.Color(input.baseColor ?? DEFAULT_PREVIEW_COLOR) },
    baseMap: { value: input.baseTexture ?? neutralTexture },
    uvOverlayMap: { value: input.uvOverlayTexture ?? neutralTexture },
    useBaseMap: { value: input.baseTexture ? 1 : 0 },
    useUvOverlayMap: { value: input.uvOverlayTexture ? 1 : 0 },
  };
  const previewLighting = getPreviewLighting(input.previewLighting);
  uniforms.previewLightingEnabled = { value: previewLighting.enabled };
  uniforms.ambientLightIntensity = { value: previewLighting.ambientIntensity };
  uniforms.keyLightIntensity = { value: previewLighting.keyLightIntensity };
  uniforms.keyLightDirection = { value: previewLighting.keyLightDirection };
  if (input.baseTexture) {
    input.baseTexture.colorSpace = THREE.SRGBColorSpace;
    input.baseTexture.flipY = false;
    input.baseTexture.wrapS = THREE.ClampToEdgeWrapping;
    input.baseTexture.wrapT = THREE.ClampToEdgeWrapping;
    input.baseTexture.minFilter = THREE.LinearMipmapLinearFilter;
    input.baseTexture.magFilter = THREE.LinearFilter;
    input.baseTexture.generateMipmaps = true;
  }
  if (input.uvOverlayTexture) {
    input.uvOverlayTexture.colorSpace = THREE.SRGBColorSpace;
    input.uvOverlayTexture.flipY = false;
    input.uvOverlayTexture.wrapS = THREE.ClampToEdgeWrapping;
    input.uvOverlayTexture.wrapT = THREE.ClampToEdgeWrapping;
    input.uvOverlayTexture.minFilter = THREE.LinearMipmapLinearFilter;
    input.uvOverlayTexture.magFilter = THREE.LinearFilter;
    input.uvOverlayTexture.generateMipmaps = true;
  }
  const disposableTextures: THREE.Texture[] = [neutralTexture];

  const loadedLayers: typeof layers = [];
  for (const layer of layers) {
    const index = loadedLayers.length;
    let texture: THREE.Texture;
    try {
      texture = await loadProjectedTexture(layer.imageUrl);
    } catch (error) {
      console.warn('[Liclick 3D Texture] Could not load projected layer image; skipping layer in live preview.', error);
      continue;
    }
    const requestedMask = Boolean(layer.useMask && layer.maskUrl);
    const requestedDepth = Boolean(layer.useDepthCheck && layer.depthUrl);
    const maskTexture = requestedMask
      ? await loadProjectedTexture(layer.maskUrl!, THREE.NoColorSpace).catch((error) => {
          console.warn('[Liclick 3D Texture] Could not load projected layer mask; continuing without mask.', error);
          return neutralTexture;
        })
      : neutralTexture;
    const depthTexture = requestedDepth
      ? await loadProjectedTexture(layer.depthUrl!, THREE.NoColorSpace).catch((error) => {
          console.warn('[Liclick 3D Texture] Could not load projected layer depth; continuing without depth check.', error);
          return neutralTexture;
        })
      : neutralTexture;
    const shouldUseMask = requestedMask && maskTexture !== neutralTexture;
    const shouldUseDepth = requestedDepth && depthTexture !== neutralTexture;
    if (shouldUseMask) {
      maskTexture.minFilter = THREE.LinearFilter;
      maskTexture.magFilter = THREE.LinearFilter;
    }
    if (shouldUseDepth) {
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
    if (shouldUseMask) uniforms[`maskMap${index}`] = { value: maskTexture };
    if (shouldUseDepth) uniforms[`depthMap${index}`] = { value: depthTexture };
    uniforms[`projectorMatrix${index}`] = { value: buildProjectionMatrixBundle(layer.camera).projectorMatrix };
    uniforms[`objectMatrixDelta${index}`] = { value: objectMatrixDelta };
    uniforms[`objectNormalDelta${index}`] = { value: objectNormalDelta };
    uniforms[`projectorPosition${index}`] = { value: new THREE.Vector3().fromArray(layer.camera.position) };
    uniforms[`layerOpacity${index}`] = { value: layer.opacity };
    uniforms[`layerStrength${index}`] = { value: layer.strength ?? 1 };
    uniforms[`layerBlendMode${index}`] = { value: layer.blendMode === 'overlay' ? 1 : 0 };
    uniforms[`hueShift${index}`] = { value: layer.hue ?? 0 };
    uniforms[`saturationShift${index}`] = { value: layer.saturation ?? 0 };
    uniforms[`lightnessShift${index}`] = { value: layer.lightness ?? 0 };
    disposableTextures.push(texture, maskTexture, depthTexture);
    loadedLayers.push({ ...layer, useMask: shouldUseMask, useDepthCheck: shouldUseDepth });
  }
  if (loadedLayers.length === 0) return undefined;

  const material = new THREE.ShaderMaterial({
    name: `LiclickProjectedLayerStack:${loadedLayers.map((layer) => layer.layerId).join(',')}`,
    vertexShader,
    fragmentShader: buildStackFragmentShader(loadedLayers),
    uniforms,
    toneMapped: false,
  });
  material.userData[GENERATED_MATERIAL_FLAG] = true;
  material.userData[DISPOSABLE_TEXTURES_KEY] = [...new Set(disposableTextures)];
  material.userData[PROJECTED_LAYER_MATERIAL_USER_DATA_KEY] = {
    layers: loadedLayers.map((layer, index) => ({
      objectMatrixWorld: layer.objectMatrixWorld,
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

const uvOverlayFragmentShader = `
  uniform sampler2D baseMap;
  uniform sampler2D uvOverlayMap;
  uniform float useBaseMap;
  uniform float useUvOverlayMap;
  uniform vec3 baseColor;
  uniform float previewLightingEnabled;
  uniform float ambientLightIntensity;
  uniform float keyLightIntensity;
  uniform vec3 keyLightDirection;
  varying vec3 vWorldNormal;
  varying vec2 vUv;

  vec3 linearToSrgb(vec3 color) {
    vec3 cutoff = step(color, vec3(0.0031308));
    vec3 lower = color * 12.92;
    vec3 higher = 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(higher, lower, cutoff);
  }

  float computePreviewLight(vec3 normal) {
    vec3 lightDir = normalize(keyLightDirection);
    float diffuse = max(dot(normal, lightDir), 0.0);
    float lit = clamp(ambientLightIntensity + diffuse * keyLightIntensity * 0.55, 0.0, 2.0);
    return mix(1.0, lit, previewLightingEnabled);
  }

  void main() {
    vec3 normal = normalize(vWorldNormal);
    float lambert = computePreviewLight(normal);
    vec4 baseTexel = texture2D(baseMap, vUv);
    vec4 overlayTexel = texture2D(uvOverlayMap, vUv);
    vec3 surfaceColor = mix(baseColor, baseTexel.rgb, useBaseMap);
    surfaceColor = mix(surfaceColor, overlayTexel.rgb, overlayTexel.a * useUvOverlayMap);
    gl_FragColor = vec4(linearToSrgb(clamp(surfaceColor * lambert, 0.0, 1.0)), 1.0);
  }
`;

export function createUvOverlayPreviewMaterial(input: {
  displayMode: string;
  selected: boolean;
  uvOverlayTexture?: THREE.Texture;
  baseTexture?: THREE.Texture;
  baseColor?: THREE.ColorRepresentation;
  previewLighting?: ProjectionPreviewLighting;
}) {
  if (input.displayMode === 'normal') return markGeneratedMaterial(new THREE.MeshNormalMaterial());
  if (input.displayMode === 'wire') {
    return markGeneratedMaterial(new THREE.MeshStandardMaterial({
      color: DEFAULT_WIRE_COLOR,
      wireframe: true,
      roughness: 0.9,
      metalness: 0,
    }));
  }

  const whitePixel = new Uint8Array([255, 255, 255, 255]);
  const neutralTexture = new THREE.DataTexture(whitePixel, 1, 1, THREE.RGBAFormat);
  neutralTexture.needsUpdate = true;
  neutralTexture.flipY = false;

  const prepareExternalTexture = (texture: THREE.Texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
  };
  if (input.uvOverlayTexture) prepareExternalTexture(input.uvOverlayTexture);
  if (input.baseTexture) prepareExternalTexture(input.baseTexture);
  const previewLighting = getPreviewLighting(input.previewLighting);

  const material = new THREE.ShaderMaterial({
    name: 'LiclickUvOverlayPreview',
    vertexShader,
    fragmentShader: uvOverlayFragmentShader,
    uniforms: {
      baseMap: { value: input.baseTexture ?? neutralTexture },
      uvOverlayMap: { value: input.uvOverlayTexture ?? neutralTexture },
      useBaseMap: { value: input.baseTexture ? 1 : 0 },
      useUvOverlayMap: { value: input.uvOverlayTexture ? 1 : 0 },
      baseColor: { value: new THREE.Color(input.baseColor ?? DEFAULT_PREVIEW_COLOR) },
      previewLightingEnabled: { value: previewLighting.enabled },
      ambientLightIntensity: { value: previewLighting.ambientIntensity },
      keyLightIntensity: { value: previewLighting.keyLightIntensity },
      keyLightDirection: { value: previewLighting.keyLightDirection },
    },
    toneMapped: false,
  });
  material.userData[GENERATED_MATERIAL_FLAG] = true;
  material.userData[DISPOSABLE_TEXTURES_KEY] = [neutralTexture];
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
