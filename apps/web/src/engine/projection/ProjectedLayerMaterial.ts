import * as THREE from 'three';
import type { ProjectionLayerInput, ProjectionLayerStackInput, ProjectionPreviewLighting } from './projectionTypes';
import { buildProjectionMatrixBundle } from './projectionMath';
import { getLiveProjectedCanvasTexture, isLiveProjectedCanvasUrl } from './liveProjectedCanvasTextureRegistry';

const DEFAULT_PREVIEW_COLOR = '#f0f1ee';
const DEFAULT_FLAT_COLOR = '#f4f5f2';
const DEFAULT_WIRE_COLOR = '#e9ebe8';
const GENERATED_MATERIAL_FLAG = 'liclickGeneratedMaterial';
const DISPOSABLE_TEXTURES_KEY = 'liclickDisposableTextures';
const DISPOSED_MATERIAL_FLAG = 'liclickDisposedMaterial';
const PROJECTED_LAYER_STACK_STATE_KEY = 'liclickProjectedLayerStackState';
const UV_OVERLAY_PREVIEW_MATERIAL_FLAG = 'liclickUvOverlayPreviewMaterial';
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
      const projectionData = material.userData[
        PROJECTED_LAYER_MATERIAL_USER_DATA_KEY
      ] as ProjectedLayerProjectionData | undefined;
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
  blendModeUniform?: string;
  hueUniform: string;
  saturationUniform: string;
  lightnessUniform: string;
};

type ProjectedLayerMaterialState = {
  signature: string;
  bindings: ProjectedLayerUniformBinding[];
};

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
  uniform sampler2D maskMap;
  uniform sampler2D depthMap;
  uniform mat4 projectorMatrix;
  uniform mat4 objectMatrixDelta;
  uniform mat3 objectNormalDelta;
  uniform vec3 projectorPosition;
  uniform float layerOpacity;
  uniform float layerStrength;
  uniform float projectedIsRenderedColor;
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
  uniform float useUvOverlayMap;
  uniform float previewLightingEnabled;
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
    // Projection coverage is an overlay. Pixels that receive no useful
    // projection must reveal the underlying white/base surface instead of a
    // black diagnostic hatch.
    return baseSurfaceColor;
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
    vec4 baseTexel = texture2D(baseMap, vUv);
    vec4 uvOverlayTexel = texture2D(uvOverlayMap, vUv);
    uvOverlayTexel.rgb = applyHsvAdjustments(
      uvOverlayTexel.rgb,
      uvOverlayHueShift,
      uvOverlaySaturationShift,
      uvOverlayLightnessShift
    );
    vec3 baseSurfaceColor = mix(baseColor, baseTexel.rgb, useBaseMap);
    vec3 emptyPreviewColor = computeProjectionEmptyPreviewColor(baseSurfaceColor);
    // Local repaint images are captured display colors: they already contain the
    // viewport exposure. LinearToneMapping applies toneMappingExposure once more
    // at the end of this shader, so cancel that second exposure for rendered
    // colors while ordinary texture layers still receive preview lighting.
    float renderedColorExposureCompensation = 1.0 / max(toneMappingExposure, 0.0001);
    vec3 projectedDisplayColor = texel.rgb * mix(
      lambert,
      renderedColorExposureCompensation,
      projectedIsRenderedColor
    );
    vec3 mixedColor = mix(emptyPreviewColor * lambert, projectedDisplayColor, projectionAlpha);
    mixedColor = mix(
      mixedColor,
      uvOverlayTexel.rgb * lambert,
      uvOverlayTexel.a * useUvOverlayMap
    );

    gl_FragColor = vec4(clamp(mixedColor, 0.0, 1.0), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function buildStackFragmentShader(layers: Array<{ useMask?: boolean; useDepthCheck?: boolean; maskUrl?: string; maskSpace?: 'projection' | 'uv'; depthUrl?: string; renderedColor?: boolean }>) {
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

      float maskAlpha = ${layerUsesMask(index) ? `dot(texture2D(maskMap${index}, ${layers[index].maskSpace === 'uv' ? 'vec2(vUv.x, 1.0 - vUv.y)' : 'uv'}).rgb, vec3(0.299, 0.587, 0.114))` : '1.0'};

      float projectedDepth = ndc.z * 0.5 + 0.5;
      float depthWeight = ${layerUsesDepth(index)
        ? `0.2 + 0.8 * exp(-pow(abs(projectedDepth - unpackDepth(texture2D(depthMap${index}, uv))) / max(${DEPTH_EPSILON.toFixed(2)}, 0.000001), 2.0))`
        : '1.0'};

      vec4 texel = texture2D(projectedMap${index}, uv);
      texel.rgb = applyHsvAdjustments(texel.rgb, hueShift${index}, saturationShift${index}, lightnessShift${index});
      texel.rgb *= mix(
        lambert,
        1.0 / max(toneMappingExposure, 0.0001),
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

      float maskAlpha = ${layerUsesMask(index) ? `dot(texture2D(maskMap${index}, ${layers[index].maskSpace === 'uv' ? 'vec2(vUv.x, 1.0 - vUv.y)' : 'uv'}).rgb, vec3(0.299, 0.587, 0.114))` : '1.0'};

      float projectedDepth = ndc.z * 0.5 + 0.5;
      float depthWeight = ${layerUsesDepth(index)
        ? `0.2 + 0.8 * exp(-pow(abs(projectedDepth - unpackDepth(texture2D(depthMap${index}, uv))) / max(${DEPTH_EPSILON.toFixed(2)}, 0.000001), 2.0))`
        : '1.0'};

      vec4 texel = texture2D(projectedMap${index}, uv);
      texel.rgb = applyHsvAdjustments(texel.rgb, hueShift${index}, saturationShift${index}, lightnessShift${index});
      texel.rgb *= mix(
        lambert,
        1.0 / max(toneMappingExposure, 0.0001),
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
  uniform float uvOverlayHueShift;
  uniform float uvOverlaySaturationShift;
  uniform float uvOverlayLightnessShift;
  uniform float previewLightingEnabled;
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
    // Keep uncovered areas in the material's base-surface state. A visible
    // layer with no coverage is equivalent to having no useful texture there.
    return baseSurfaceColor;
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
    uvOverlayTexel.rgb = applyHsvAdjustments(
      uvOverlayTexel.rgb,
      uvOverlayHueShift,
      uvOverlaySaturationShift,
      uvOverlayLightnessShift
    );
    vec3 baseSurfaceColor = mix(baseColor, baseTexel.rgb, useBaseMap);
    vec3 shadedBase = computeProjectionEmptyPreviewColor(baseSurfaceColor) * lambert;
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
    mixedColor = mix(
      mixedColor,
      uvOverlayTexel.rgb * lambert,
      uvOverlayTexel.a * useUvOverlayMap
    );
    gl_FragColor = vec4(clamp(mixedColor, 0.0, 1.0), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
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
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
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

function getProjectionLayerStructureSignature(layers: ProjectionLayerStackInput['layers']) {
  return layers
    .map((layer) =>
      [
        layer.layerId,
        layer.maskUrl ?? '',
        layer.depthUrl ?? '',
        layer.useMask ? 1 : 0,
        layer.maskSpace ?? 'projection',
        layer.useDepthCheck ? 1 : 0,
        layer.renderedColor ? 1 : 0,
        layer.objectMatrixWorld?.join(',') ?? '',
        getLayerCameraSignature(layer.camera),
      ].join('~'),
    )
    .join('|');
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
        console.warn('[Liclick 3D Texture] Could not update projected layer image; keeping previous texture.', error);
      });
  }
  const opacityUniform = material.uniforms[binding.opacityUniform];
  if (opacityUniform) opacityUniform.value = layer.visible ? layer.opacity : 0;
  const strengthUniform = material.uniforms[binding.strengthUniform];
  if (strengthUniform) strengthUniform.value = layer.strength ?? 1;
  const blendModeUniform = binding.blendModeUniform ? material.uniforms[binding.blendModeUniform] : undefined;
  if (blendModeUniform) blendModeUniform.value = layer.blendMode === 'overlay' ? 1 : 0;
  const hueUniform = material.uniforms[binding.hueUniform];
  if (hueUniform) hueUniform.value = layer.hue ?? 0;
  const saturationUniform = material.uniforms[binding.saturationUniform];
  if (saturationUniform) saturationUniform.value = layer.saturation ?? 0;
  const lightnessUniform = material.uniforms[binding.lightnessUniform];
  if (lightnessUniform) lightnessUniform.value = layer.lightness ?? 0;
}

function updateSharedPreviewUniforms(material: THREE.ShaderMaterial, input: ProjectionLayerStackInput) {
  const previewLighting = getPreviewLighting(input.previewLighting);
  if (material.uniforms.baseMap && input.baseTexture) material.uniforms.baseMap.value = input.baseTexture;
  if (material.uniforms.uvOverlayMap && input.uvOverlayTexture) material.uniforms.uvOverlayMap.value = input.uvOverlayTexture;
  if (material.uniforms.useBaseMap) material.uniforms.useBaseMap.value = input.baseTexture ? 1 : 0;
  if (material.uniforms.useUvOverlayMap) material.uniforms.useUvOverlayMap.value = input.uvOverlayTexture ? 1 : 0;
  if (material.uniforms.uvOverlayHueShift) material.uniforms.uvOverlayHueShift.value = input.uvOverlayHue ?? 0;
  if (material.uniforms.uvOverlaySaturationShift) material.uniforms.uvOverlaySaturationShift.value = input.uvOverlaySaturation ?? 0;
  if (material.uniforms.uvOverlayLightnessShift) material.uniforms.uvOverlayLightnessShift.value = input.uvOverlayLightness ?? 0;
  if (material.uniforms.baseColor) material.uniforms.baseColor.value.set(input.baseColor ?? DEFAULT_PREVIEW_COLOR);
  if (material.uniforms.previewLightingEnabled) material.uniforms.previewLightingEnabled.value = previewLighting.enabled;
  if (material.uniforms.ambientLightIntensity) material.uniforms.ambientLightIntensity.value = previewLighting.ambientIntensity;
  if (material.uniforms.keyLightIntensity) material.uniforms.keyLightIntensity.value = previewLighting.keyLightIntensity;
  if (material.uniforms.keyLightDirection) material.uniforms.keyLightDirection.value = previewLighting.keyLightDirection;
  if (input.baseTexture) prepareExistingBaseTexture(input.baseTexture);
  if (input.uvOverlayTexture) prepareUvTexture(input.uvOverlayTexture);
}

export function updateProjectedLayerStackMaterial(
  material: THREE.Material | THREE.Material[] | undefined,
  input: ProjectionLayerStackInput,
) {
  if (!(material instanceof THREE.ShaderMaterial)) return false;
  const state = material.userData[PROJECTED_LAYER_STACK_STATE_KEY] as ProjectedLayerMaterialState | undefined;
  if (!state) return false;
  const layers = input.layers.filter((layer) => layer.imageUrl && layer.camera);
  if (layers.length === 0) return false;
  if (state.signature !== getProjectionLayerStructureSignature(layers)) return false;
  updateSharedPreviewUniforms(material, input);
  for (let index = 0; index < layers.length; index += 1) {
    const binding = state.bindings[index];
    const layer = layers[index];
    if (!binding || binding.layerId !== layer.layerId) return false;
    updateLayerUniforms(material, binding, layer);
  }
  return true;
}

type ProjectedTextureProfile = 'image' | 'mask' | 'depth';

const projectedTextureCache = new Map<string, Promise<THREE.Texture>>();

function getProjectedTextureCacheKey(imageUrl: string, colorSpace: THREE.ColorSpace, profile: ProjectedTextureProfile) {
  return `${profile}:${colorSpace}:${imageUrl}`;
}

async function loadProjectedTexture(
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

  const texturePromise = new THREE.TextureLoader().loadAsync(imageUrl)
    .then((texture) => {
      texture.colorSpace = colorSpace;
      texture.flipY = false;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = profile === 'depth' ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
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
  const maskTexture = input.maskUrl
    ? await loadProjectedTexture(input.maskUrl, THREE.NoColorSpace, 'mask').catch((error) => {
        console.warn('[Liclick 3D Texture] Could not load projected layer mask; continuing without mask.', error);
        return neutralTexture;
      })
    : neutralTexture;
  const depthTexture = input.depthUrl
    ? await loadProjectedTexture(input.depthUrl, THREE.NoColorSpace, 'depth').catch((error) => {
        console.warn('[Liclick 3D Texture] Could not load projected layer depth; continuing without depth check.', error);
        return neutralTexture;
      })
    : neutralTexture;
  const baseTexture = input.baseTexture ?? neutralTexture;
  const uvOverlayTexture = input.uvOverlayTexture ?? neutralTexture;
  if (input.baseTexture) prepareExistingBaseTexture(input.baseTexture);
  if (input.uvOverlayTexture) prepareUvTexture(input.uvOverlayTexture);
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
      uvOverlayMap: { value: uvOverlayTexture },
      maskMap: { value: maskTexture },
      depthMap: { value: depthTexture },
      projectorMatrix: { value: buildProjectionMatrixBundle(input.camera).projectorMatrix },
      objectMatrixDelta: { value: objectMatrixDelta },
      objectNormalDelta: { value: objectNormalDelta },
      projectorPosition: { value: new THREE.Vector3().fromArray(input.camera.position) },
      layerOpacity: { value: input.visible ? input.opacity : 0 },
      layerStrength: { value: input.strength ?? 1 },
      projectedIsRenderedColor: { value: input.renderedColor ? 1 : 0 },
      useMask: { value: input.useMask && input.maskUrl && maskTexture !== neutralTexture ? 1 : 0 },
      maskUsesUv: { value: input.maskSpace === 'uv' ? 1 : 0 },
      useDepthCheck: { value: input.useDepthCheck && input.depthUrl && depthTexture !== neutralTexture ? 1 : 0 },
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
      useUvOverlayMap: { value: input.uvOverlayTexture ? 1 : 0 },
      previewLightingEnabled: { value: previewLighting.enabled },
      ambientLightIntensity: { value: previewLighting.ambientIntensity },
      keyLightIntensity: { value: previewLighting.keyLightIntensity },
      keyLightDirection: { value: previewLighting.keyLightDirection },
    },
    toneMapped: true,
  });
  material.userData[GENERATED_MATERIAL_FLAG] = true;
  material.userData[DISPOSABLE_TEXTURES_KEY] = [neutralTexture];
  material.userData[PROJECTED_LAYER_STACK_STATE_KEY] = {
    signature: getProjectionLayerStructureSignature([materialLayer]),
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

export async function createProjectedLayerStackMaterial(input: ProjectionLayerStackInput) {
  const layers = input.layers.filter((layer) => layer.imageUrl && layer.camera);
  if (layers.length === 0) return undefined;
  if (layers.length === 1) {
    const [layer] = layers;
    return createProjectedLayerMaterial({
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
    uvOverlayHueShift: { value: input.uvOverlayHue ?? 0 },
    uvOverlaySaturationShift: { value: input.uvOverlaySaturation ?? 0 },
    uvOverlayLightnessShift: { value: input.uvOverlayLightness ?? 0 },
  };
  const previewLighting = getPreviewLighting(input.previewLighting);
  uniforms.previewLightingEnabled = { value: previewLighting.enabled };
  uniforms.ambientLightIntensity = { value: previewLighting.ambientIntensity };
  uniforms.keyLightIntensity = { value: previewLighting.keyLightIntensity };
  uniforms.keyLightDirection = { value: previewLighting.keyLightDirection };
  if (input.baseTexture) prepareExistingBaseTexture(input.baseTexture);
  if (input.uvOverlayTexture) prepareUvTexture(input.uvOverlayTexture);
  const disposableTextures: THREE.Texture[] = [neutralTexture];
  const captureObjectMatrices: Array<number[] | undefined> = [];

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
      ? await loadProjectedTexture(layer.maskUrl!, THREE.NoColorSpace, 'mask').catch((error) => {
          console.warn('[Liclick 3D Texture] Could not load projected layer mask; continuing without mask.', error);
          return neutralTexture;
        })
      : neutralTexture;
    const depthTexture = requestedDepth
      ? await loadProjectedTexture(layer.depthUrl!, THREE.NoColorSpace, 'depth').catch((error) => {
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

    const captureObjectMatrixWorld = layer.objectMatrixWorld ?? input.currentObjectMatrixWorld;
    const objectMatrixDelta = new THREE.Matrix4();
    if (captureObjectMatrixWorld && input.currentObjectMatrixWorld) {
      objectMatrixDelta
        .fromArray(captureObjectMatrixWorld)
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
    uniforms[`layerOpacity${index}`] = { value: layer.visible ? layer.opacity : 0 };
    uniforms[`layerStrength${index}`] = { value: layer.strength ?? 1 };
    uniforms[`layerBlendMode${index}`] = { value: layer.blendMode === 'overlay' ? 1 : 0 };
    uniforms[`hueShift${index}`] = { value: layer.hue ?? 0 };
    uniforms[`saturationShift${index}`] = { value: layer.saturation ?? 0 };
    uniforms[`lightnessShift${index}`] = { value: layer.lightness ?? 0 };
    captureObjectMatrices.push(captureObjectMatrixWorld);
    loadedLayers.push({ ...layer, useMask: shouldUseMask, useDepthCheck: shouldUseDepth });
  }
  if (loadedLayers.length === 0) return undefined;

  const material = new THREE.ShaderMaterial({
    name: `LiclickProjectedLayerStack:${loadedLayers.map((layer) => layer.layerId).join(',')}`,
    vertexShader,
    fragmentShader: buildStackFragmentShader(loadedLayers),
    uniforms,
    toneMapped: true,
  });
  material.userData[GENERATED_MATERIAL_FLAG] = true;
  material.userData[DISPOSABLE_TEXTURES_KEY] = [...new Set(disposableTextures)];
  material.userData[PROJECTED_LAYER_STACK_STATE_KEY] = {
    signature: getProjectionLayerStructureSignature(loadedLayers),
    bindings: loadedLayers.map((layer, index) => ({
      layerId: layer.layerId,
      imageUrl: layer.imageUrl,
      projectedMapUniform: `projectedMap${index}`,
      opacityUniform: `layerOpacity${index}`,
      strengthUniform: `layerStrength${index}`,
      blendModeUniform: `layerBlendMode${index}`,
      hueUniform: `hueShift${index}`,
      saturationUniform: `saturationShift${index}`,
      lightnessUniform: `lightnessShift${index}`,
    })),
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
    return markGeneratedMaterial(new THREE.MeshStandardMaterial({
      color: DEFAULT_WIRE_COLOR,
      roughness: 0.94,
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
  uniform sampler2D liveUvOverlayMap;
  uniform sampler2D surfaceMaskMap;
  uniform float useBaseMap;
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
    vec3 baseSurface = mix(baseColor, baseTexel.rgb, useBaseMap);
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
      1.0 / max(toneMappingExposure, 0.0001),
      liveUvOverlayRenderedColor
    );
    vec3 displayColor = mix(surfaceColor * lighting, liveOverlayDisplayColor, liveOverlayAlpha);
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
  baseColor?: THREE.ColorRepresentation;
  previewLighting?: ProjectionPreviewLighting;
  showEmptyUvChecker?: boolean;
};

export function createUvOverlayPreviewMaterial(input: UvOverlayPreviewMaterialInput) {
  if (input.displayMode === 'normal') return markGeneratedMaterial(new THREE.MeshNormalMaterial());
  if (input.displayMode === 'wire') {
    return markGeneratedMaterial(new THREE.MeshStandardMaterial({
      color: DEFAULT_WIRE_COLOR,
      roughness: 0.94,
      metalness: 0,
    }));
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
      uvOverlayMap: { value: input.uvOverlayTexture ?? neutralTexture },
      liveUvOverlayMap: { value: input.liveUvOverlayTexture ?? neutralTexture },
      surfaceMaskMap: { value: input.surfaceMaskTexture ?? neutralTexture },
      useBaseMap: { value: input.baseTexture ? 1 : 0 },
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
  const neutralTexture = (material.userData[DISPOSABLE_TEXTURES_KEY] as THREE.Texture[] | undefined)?.[0];
  if (!neutralTexture) return false;
  if (input.uvOverlayTexture) prepareUvTexture(input.uvOverlayTexture);
  if (input.liveUvOverlayTexture) prepareUvTexture(input.liveUvOverlayTexture);
  if (input.baseTexture) prepareExistingBaseTexture(input.baseTexture);
  const previewLighting = getPreviewLighting(input.previewLighting);
  const uniforms = material.uniforms;
  uniforms.baseMap.value = input.baseTexture ?? neutralTexture;
  uniforms.uvOverlayMap.value = input.uvOverlayTexture ?? neutralTexture;
  uniforms.liveUvOverlayMap.value = input.liveUvOverlayTexture ?? neutralTexture;
  uniforms.surfaceMaskMap.value = input.surfaceMaskTexture ?? neutralTexture;
  uniforms.useBaseMap.value = input.baseTexture ? 1 : 0;
  uniforms.useUvOverlayMap.value = input.uvOverlayTexture ? 1 : 0;
  uniforms.useLiveUvOverlayMap.value = input.liveUvOverlayTexture ? 1 : 0;
  uniforms.liveUvOverlayOpacity.value = THREE.MathUtils.clamp(input.liveUvOverlayOpacity ?? 1, 0, 1);
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
  uniforms.ambientLightIntensity.value = previewLighting.ambientIntensity;
  uniforms.keyLightIntensity.value = previewLighting.keyLightIntensity;
  uniforms.keyLightDirection.value.copy(previewLighting.keyLightDirection);
  return true;
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
  const sourceMap = 'map' in material && material.map instanceof THREE.Texture ? material.map : undefined;
  const sourceColor = 'color' in material && material.color instanceof THREE.Color
    ? material.color
    : new THREE.Color('#ffffff');
  if (sourceMap) {
    sourceMap.colorSpace = THREE.SRGBColorSpace;
    sourceMap.needsUpdate = true;
    return markGeneratedMaterial(new THREE.MeshStandardMaterial({
      color: sourceColor,
      map: sourceMap,
      roughness: 0.68,
      metalness: 0,
      transparent: material.transparent,
      opacity: material.opacity,
      alphaTest: material.alphaTest,
      side: material.side,
    }));
  }
  return markGeneratedMaterial(new THREE.MeshStandardMaterial({
    color: DEFAULT_PREVIEW_COLOR,
    roughness: 0.58,
    metalness: 0,
  }));
}

function prepareSingleFlatMaterial(material: THREE.Material, bakedTexture?: THREE.Texture) {
  const map = bakedTexture ?? (
    'map' in material && material.map instanceof THREE.Texture ? material.map : undefined
  );
  if (!map) return createDisplayModeMaterial('flat', false);
  map.colorSpace = THREE.SRGBColorSpace;
  map.needsUpdate = true;
  const color = bakedTexture
    ? new THREE.Color('#ffffff')
    : 'color' in material && material.color instanceof THREE.Color
      ? material.color
      : new THREE.Color('#ffffff');
  return markGeneratedMaterial(new THREE.MeshBasicMaterial({
    color,
    map,
    transparent: material.transparent,
    opacity: material.opacity,
    alphaTest: material.alphaTest,
    side: material.side,
    toneMapped: true,
  }));
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
