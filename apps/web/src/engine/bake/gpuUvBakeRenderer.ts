import * as THREE from 'three';
import { loadImageData, resolveImageAssetUrl } from './imageSampler';
import { collectUvSeamPairs, type UvSeamEdgeRecord } from './uvSeamReconciliation';
import type { BakeProgress, GpuUvCompositeMode, UvBakeResolution } from './uvBakeTypes';
import { buildProjectionMatrixBundle } from '@/engine/projection/projectionMath';
import type { Layer } from '@/types/layer';
import { isViewportInteractionBusy } from '@/engine/viewport/viewportInteractionState';
import {
  loadPreviewTexture,
  residentPreviewTextureCache,
  uploadPreviewTextureInStripes,
} from '@/engine/viewport/previewTextureCache';
import {
  acquireGpuReadbackPixels,
  convertFinalGpuReadbackInWorker,
  convertLayerGpuReadbackInWorker,
  convertQualityGpuReadbackInWorker,
} from './gpuReadbackConversionWorker';

const NDV_HARD_REJECT = -0.35;
const NDV_COVERAGE_START = -0.62;
const NDV_COVERAGE_END = -0.18;
const DEPTH_BACKED_ANGLE_COVERAGE_START = 0.02;
const DEPTH_BACKED_ANGLE_COVERAGE_END = 0.38;
const BASE_ANGLE_GAMMA = 4;
const MAX_STRENGTH_FOR_ANGLE = 3;
const SHARPEN_AMOUNT = 0.24;
const SHARPEN_DETAIL_THRESHOLD = 5 / 255;
const MAX_GPU_SHARPEN_RESOLUTION = 4096;
const QUALITY_FLOOR_FROM_COVERAGE = 0.08;
const DEPTH_EPSILON = 0.0025;
const MIN_CAPTURE_FACE_ON = 0.01;
const FULL_CAPTURE_FACE_ON = 0.2;
const MAX_GRAZING_DEPTH_SCALE = 5;
const MIN_VISIBILITY_SUPPORT = 1.25;
const MAX_GRAZING_VISIBILITY_SUPPORT = 3.75;
const VISIBILITY_SUPPORT_FEATHER = 1.25;
const FACE_ON_VISIBILITY_FULL = 0.06;
const MIN_CAPTURE_NORMAL_AGREEMENT = 0.72;
const FULL_CAPTURE_NORMAL_AGREEMENT = 0.92;
const PROJECTION_FACING_FEATHER = 0.08;
const gpuUvSeamPairCache = new WeakMap<THREE.Object3D, ReturnType<typeof collectUvSeamPairs>>();

type GpuLayerStackBakeInput = {
  renderer: THREE.WebGLRenderer;
  group: THREE.Group;
  layers: Layer[];
  resolution: UvBakeResolution;
  enableBackfaceCulling: boolean;
  enableDilation: boolean;
  dilationPixels: number;
  outputAlpha?: 'opaque-viewport' | 'transparent';
  inputTextureFlipY?: boolean;
  projectedImageUvFlipY?: boolean;
  compositeMode?: GpuUvCompositeMode;
  strictDepthCheck?: boolean;
  maximumDepthError?: number;
  minimumOutputCoverage?: number;
  constrainDilationToInteriorHoles?: boolean;
  repairMissingUvSeams?: boolean;
  uvSeamRepairPixels?: number;
  onProgress?: (progress: BakeProgress) => void;
  onRaster?: (raster: GpuLayerRaster) => void | Promise<void>;
};

export type GpuLayerStackBakeOutput = {
  canvas: HTMLCanvasElement;
  coverage: Uint8Array;
  sourceSizes: GpuLayerSourceSize[];
  postProcessedOnGpu: boolean;
  opaqueBaseColorReady: boolean;
  totalTriangles: number;
  processedTriangles: number;
  coveredPixels: number;
  skippedPixels: number;
  inFrustumPixels: number;
  maskRejectedPixels: number;
  depthRejectedPixels: number;
  backfaceRejectedPixels: number;
  warnings: string[];
};

export type GpuLayerRaster = {
  layer: Layer;
  imageData: ImageData;
  quality: Uint8Array;
  coveredPixels: number;
};

export type GpuLayerRastersBakeOutput = {
  rasters: GpuLayerRaster[];
  sourceSizes: GpuLayerSourceSize[];
  totalTriangles: number;
  processedTriangles: number;
  coveredPixels: number;
  skippedPixels: number;
  warnings: string[];
};

export type GpuLayerSourceSize = {
  layerId: string;
  layerName: string;
  projectedImage: string;
  maskImage?: string;
  depthImage?: string;
  normalImage?: string;
};

type PreparedMesh = {
  source: THREE.Mesh;
  triangleCount: number;
};

type LoadedLayerTextures = {
  projectedTexture: THREE.Texture;
  maskTexture: THREE.Texture;
  depthTexture: THREE.Texture;
  normalTexture: THREE.Texture;
  useMask: boolean;
  useDepthCheck: boolean;
  useNormalCheck: boolean;
  disposableTextures: THREE.Texture[];
  sourceSizes: GpuLayerSourceSize;
};

function shouldDebugUvBake() {
  try {
    return window.localStorage.getItem('liclick-debug-uv-bake') === '1';
  } catch {
    return false;
  }
}

const vertexShader = `
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vTextureUv;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    mat3 viewToWorldNormal = mat3(
      viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0],
      viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1],
      viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]
    );
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(viewToWorldNormal * normalMatrix * normal);
    vTextureUv = uv;
    gl_Position = vec4(uv.x * 2.0 - 1.0, uv.y * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const fragmentShader = `
  uniform sampler2D projectedMap;
  uniform sampler2D maskMap;
  uniform sampler2D depthMap;
  uniform sampler2D normalMap;
  uniform mat4 projectorMatrix;
  uniform mat4 projectorViewMatrix;
  uniform mat4 objectMatrixDelta;
  uniform mat3 objectNormalDelta;
  uniform vec3 projectorPosition;
  uniform float layerOpacity;
  uniform float layerStrength;
  uniform float useMask;
  uniform float maskUsesUv;
  uniform float useDepthCheck;
  uniform float useNormalCheck;
  uniform float depthIsLinearView;
  uniform float projectorNear;
  uniform float projectorFar;
  uniform float strictDepthCheck;
  uniform float maximumDepthError;
  uniform float minimumOutputCoverage;
  uniform float minimumProjectionFacing;
  uniform float surfaceLockedVisibility;
  uniform float enableBackfaceCulling;
  uniform float useCoverageAlpha;
  uniform float useQualityDepth;
  uniform float projectedImageUvFlipY;
  uniform float depthEpsilon;
  uniform vec2 visibilityTexelSize;
  uniform vec2 projectedMapSize;
  uniform float hueShift;
  uniform float saturationShift;
  uniform float lightnessShift;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vTextureUv;

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

  vec3 applyHsvAdjustments(vec3 color) {
    if (abs(hueShift) < 0.0001 && abs(saturationShift) < 0.0001 && abs(lightnessShift) < 0.0001) {
      return color;
    }
    vec3 hsv = rgbToHsv(color);
    hsv.x = mod(hsv.x + hueShift + 1.0, 1.0);
    hsv.y = clamp(hsv.y + saturationShift, 0.0, 1.0);
    hsv.z = clamp(hsv.z + lightnessShift, 0.0, 1.0);
    return hsvToRgb(hsv);
  }

  float unpackDepth(vec4 rgbaDepth) {
    const vec4 bitShift = vec4(
      255.0 / 256.0,
      255.0 / 65536.0,
      255.0 / 16777216.0,
      1.0 / 16777216.0
    );
    return dot(rgbaDepth, bitShift);
  }

  float unpackLinearViewDepth(vec4 rgbDepth) {
    return dot(
      rgbDepth.rgb,
      vec3(
        255.0 / 256.0,
        255.0 / 65536.0,
        1.0 / 65536.0
      )
    );
  }

  float computeVisibilitySample(
    vec4 depthTexel,
    vec4 normalTexel,
    float projectedMetric,
    float depthTolerance,
    vec3 projectedFaceNormal
  ) {
    float capturedDepth = mix(
      unpackDepth(depthTexel),
      unpackLinearViewDepth(depthTexel),
      depthIsLinearView
    );
    float capturedMetric = mix(
      capturedDepth,
      mix(projectorNear, projectorFar, capturedDepth),
      depthIsLinearView
    );
    float depthError = abs(projectedMetric - capturedMetric);
    float depthVisibility = mix(
      1.0,
      1.0 - smoothstep(depthTolerance * 0.75, depthTolerance * 1.75, depthError),
      useDepthCheck
    );
    vec3 capturedFaceNormal = normalTexel.rgb * 2.0 - 1.0;
    float normalAgreement = dot(projectedFaceNormal, normalize(capturedFaceNormal));
    float normalVisibility = step(0.25, length(capturedFaceNormal)) * smoothstep(
      ${MIN_CAPTURE_NORMAL_AGREEMENT.toFixed(2)},
      ${FULL_CAPTURE_NORMAL_AGREEMENT.toFixed(2)},
      mix(abs(normalAgreement), normalAgreement, surfaceLockedVisibility)
    );
    return depthVisibility * mix(1.0, normalVisibility, useNormalCheck);
  }

  float computeAngleWeight(float ndv, float strength) {
    float strengthClamped = clamp(strength, 0.25, ${MAX_STRENGTH_FOR_ANGLE.toFixed(1)});
    float gamma = ${BASE_ANGLE_GAMMA.toFixed(1)} / strengthClamped;
    float frontFade = smoothstep(0.02, 0.25, ndv);
    return frontFade * pow(clamp(ndv, 0.0, 1.0), gamma);
  }

  float computeImageEdgeFade(vec2 uv, float edge) {
    float edgeDistance = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    return smoothstep(0.0, edge, edgeDistance);
  }

  vec4 sampleProjectedCleanBilinear(sampler2D map, vec2 uv) {
    vec2 clampedUv = clamp(uv, vec2(0.0), vec2(1.0));
    vec2 source = clampedUv * (projectedMapSize - vec2(1.0));
    vec2 p0 = floor(source);
    vec2 p1 = min(projectedMapSize - vec2(1.0), p0 + vec2(1.0));
    vec2 f = source - p0;

    vec2 uv00 = (p0 + vec2(0.5, 0.5)) / projectedMapSize;
    vec2 uv10 = (vec2(p1.x, p0.y) + vec2(0.5, 0.5)) / projectedMapSize;
    vec2 uv01 = (vec2(p0.x, p1.y) + vec2(0.5, 0.5)) / projectedMapSize;
    vec2 uv11 = (p1 + vec2(0.5, 0.5)) / projectedMapSize;

    vec4 c00 = texture2D(map, uv00);
    vec4 c10 = texture2D(map, uv10);
    vec4 c01 = texture2D(map, uv01);
    vec4 c11 = texture2D(map, uv11);

    float w00 = (1.0 - f.x) * (1.0 - f.y);
    float w10 = f.x * (1.0 - f.y);
    float w01 = (1.0 - f.x) * f.y;
    float w11 = f.x * f.y;
    float threshold = 3.0 / 255.0;
    vec3 rgb = vec3(0.0);
    float totalWeight = 0.0;
    float maxAlpha = 0.0;

    if (w00 > 0.0 && c00.a >= threshold) {
      rgb += c00.rgb * w00;
      totalWeight += w00;
      maxAlpha = max(maxAlpha, c00.a);
    }
    if (w10 > 0.0 && c10.a >= threshold) {
      rgb += c10.rgb * w10;
      totalWeight += w10;
      maxAlpha = max(maxAlpha, c10.a);
    }
    if (w01 > 0.0 && c01.a >= threshold) {
      rgb += c01.rgb * w01;
      totalWeight += w01;
      maxAlpha = max(maxAlpha, c01.a);
    }
    if (w11 > 0.0 && c11.a >= threshold) {
      rgb += c11.rgb * w11;
      totalWeight += w11;
      maxAlpha = max(maxAlpha, c11.a);
    }

    if (totalWeight <= 0.00001) return vec4(0.0);
    return vec4(rgb / totalWeight, maxAlpha);
  }

  void main() {
    vec4 captureWorldPosition = objectMatrixDelta * vec4(vWorldPosition, 1.0);
    vec3 captureWorldNormal = normalize(objectNormalDelta * vWorldNormal);
    vec4 projected = projectorMatrix * captureWorldPosition;
    if (projected.w <= 0.0001) discard;

    vec3 ndc = projected.xyz / projected.w;
    if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z < -1.0 || ndc.z > 1.0) {
      discard;
    }

    vec2 imageUv = ndc.xy * 0.5 + 0.5;
    imageUv.y = 1.0 - imageUv.y;
    vec2 projectedSampleUv = vec2(imageUv.x, mix(imageUv.y, 1.0 - imageUv.y, projectedImageUvFlipY));

    vec3 projectorViewDir = normalize(projectorPosition - captureWorldPosition.xyz);
    float ndv = dot(captureWorldNormal, projectorViewDir);
    float frontFacing = step(${NDV_HARD_REJECT.toFixed(2)}, ndv);
    if (useDepthCheck < 0.5 && enableBackfaceCulling > 0.5 && frontFacing < 0.5) discard;
    float visibilityBackedNdv = mix(ndv, abs(ndv), useDepthCheck);
    float angleCoverage = mix(
      smoothstep(${NDV_COVERAGE_START.toFixed(2)}, ${NDV_COVERAGE_END.toFixed(2)}, ndv),
      smoothstep(${DEPTH_BACKED_ANGLE_COVERAGE_START.toFixed(2)}, ${DEPTH_BACKED_ANGLE_COVERAGE_END.toFixed(2)}, visibilityBackedNdv),
      useDepthCheck
    );
    if (angleCoverage <= 0.0001) discard;

    vec2 maskSampleUv = mix(projectedSampleUv, vTextureUv, maskUsesUv);
    vec4 maskTexel = texture2D(maskMap, maskSampleUv);
    // Match the live projected material: the mask is continuous coverage, not a
    // binary acceptance test. Turning every accepted feather texel fully opaque
    // made a soft local-repaint stroke become a solid stripe after UV baking.
    float maskValue = dot(maskTexel.rgb, vec3(0.299, 0.587, 0.114)) * maskTexel.a;
    float maskCoverage = mix(1.0, maskValue, useMask);

    float projectedDepth = ndc.z * 0.5 + 0.5;
    float projectedViewDepth = -(projectorViewMatrix * captureWorldPosition).z;
    float projectedMetric = mix(projectedDepth, projectedViewDepth, depthIsLinearView);
    float depthTolerance = mix(
      depthEpsilon,
      max(0.00625, projectedViewDepth * 0.00075),
      depthIsLinearView
    );
    vec3 captureViewPosition = (projectorViewMatrix * captureWorldPosition).xyz;
    vec3 projectedFaceNormal = normalize(
      cross(dFdx(captureViewPosition), dFdy(captureViewPosition))
    );
    vec3 captureViewVertexNormal = normalize(mat3(projectorViewMatrix) * captureWorldNormal);
    projectedFaceNormal *= mix(
      1.0,
      -1.0,
      step(dot(projectedFaceNormal, captureViewVertexNormal), 0.0)
    );
    float faceOnFactor = abs(projectedFaceNormal.z);
    float projectionFacingFactor = abs(
      dot(projectedFaceNormal, normalize(-captureViewPosition))
    );
    if (projectionFacingFactor < minimumProjectionFacing) discard;
    float useProjectionFacingGuard = step(0.001, minimumProjectionFacing);
    float projectionFacingCoverage = mix(
      1.0,
      smoothstep(
        minimumProjectionFacing,
        minimumProjectionFacing + ${PROJECTION_FACING_FEATHER.toFixed(2)},
        projectionFacingFactor
      ),
      useProjectionFacingGuard
    );
    float grazingDepthScale = mix(
      ${MAX_GRAZING_DEPTH_SCALE.toFixed(1)},
      1.0,
      smoothstep(${MIN_CAPTURE_FACE_ON.toFixed(2)}, ${FULL_CAPTURE_FACE_ON.toFixed(2)}, faceOnFactor)
    );
    depthTolerance *= mix(1.0, grazingDepthScale, useNormalCheck);
    float centerVisibility = computeVisibilitySample(
      texture2D(depthMap, projectedSampleUv), texture2D(normalMap, projectedSampleUv),
      projectedMetric, depthTolerance, projectedFaceNormal
    );
    float visibilitySupport = centerVisibility;
    visibilitySupport += computeVisibilitySample(
      texture2D(depthMap, projectedSampleUv + vec2(visibilityTexelSize.x, 0.0)),
      texture2D(normalMap, projectedSampleUv + vec2(visibilityTexelSize.x, 0.0)),
      projectedMetric, depthTolerance, projectedFaceNormal
    );
    visibilitySupport += computeVisibilitySample(
      texture2D(depthMap, projectedSampleUv - vec2(visibilityTexelSize.x, 0.0)),
      texture2D(normalMap, projectedSampleUv - vec2(visibilityTexelSize.x, 0.0)),
      projectedMetric, depthTolerance, projectedFaceNormal
    );
    visibilitySupport += computeVisibilitySample(
      texture2D(depthMap, projectedSampleUv + vec2(0.0, visibilityTexelSize.y)),
      texture2D(normalMap, projectedSampleUv + vec2(0.0, visibilityTexelSize.y)),
      projectedMetric, depthTolerance, projectedFaceNormal
    );
    visibilitySupport += computeVisibilitySample(
      texture2D(depthMap, projectedSampleUv - vec2(0.0, visibilityTexelSize.y)),
      texture2D(normalMap, projectedSampleUv - vec2(0.0, visibilityTexelSize.y)),
      projectedMetric, depthTolerance, projectedFaceNormal
    );
    visibilitySupport += computeVisibilitySample(
      texture2D(depthMap, projectedSampleUv + visibilityTexelSize),
      texture2D(normalMap, projectedSampleUv + visibilityTexelSize),
      projectedMetric, depthTolerance, projectedFaceNormal
    );
    visibilitySupport += computeVisibilitySample(
      texture2D(depthMap, projectedSampleUv - visibilityTexelSize),
      texture2D(normalMap, projectedSampleUv - visibilityTexelSize),
      projectedMetric, depthTolerance, projectedFaceNormal
    );
    visibilitySupport += computeVisibilitySample(
      texture2D(depthMap, projectedSampleUv + vec2(visibilityTexelSize.x, -visibilityTexelSize.y)),
      texture2D(normalMap, projectedSampleUv + vec2(visibilityTexelSize.x, -visibilityTexelSize.y)),
      projectedMetric, depthTolerance, projectedFaceNormal
    );
    visibilitySupport += computeVisibilitySample(
      texture2D(depthMap, projectedSampleUv + vec2(-visibilityTexelSize.x, visibilityTexelSize.y)),
      texture2D(normalMap, projectedSampleUv + vec2(-visibilityTexelSize.x, visibilityTexelSize.y)),
      projectedMetric, depthTolerance, projectedFaceNormal
    );
    float grazingConfidence = smoothstep(
      ${MIN_CAPTURE_FACE_ON.toFixed(2)},
      ${FULL_CAPTURE_FACE_ON.toFixed(2)},
      faceOnFactor
    );
    float requiredVisibilitySupport = mix(
      ${MAX_GRAZING_VISIBILITY_SUPPORT.toFixed(1)},
      ${MIN_VISIBILITY_SUPPORT.toFixed(1)},
      grazingConfidence
    );
    float neighborhoodVisibility = smoothstep(
      requiredVisibilitySupport - ${VISIBILITY_SUPPORT_FEATHER.toFixed(2)},
      requiredVisibilitySupport + 0.5,
      visibilitySupport
    );
    // Preserve capture-texel-wide low-poly bevels when the center depth and
    // geometric normal agree. Without a normal buffer, only use this fallback
    // for face-on regions so grazing scan-line rejection remains intact.
    float centerBackedVisibility =
      centerVisibility *
      mix(0.35, 1.0, grazingConfidence) *
      max(useNormalCheck, smoothstep(${MIN_CAPTURE_FACE_ON.toFixed(2)}, ${FULL_CAPTURE_FACE_ON.toFixed(2)}, faceOnFactor));
    float visibilityCoverage =
      max(neighborhoodVisibility, centerBackedVisibility) *
      smoothstep(${MIN_CAPTURE_FACE_ON.toFixed(2)}, ${FACE_ON_VISIBILITY_FULL.toFixed(2)}, faceOnFactor);
    float lockedFacingCoverage = smoothstep(0.08, 0.16, projectionFacingFactor);
    visibilityCoverage = mix(
      visibilityCoverage,
      centerVisibility * max(neighborhoodVisibility, centerBackedVisibility) * lockedFacingCoverage,
      surfaceLockedVisibility
    );
    angleCoverage = mix(angleCoverage, lockedFacingCoverage, surfaceLockedVisibility);
    if (strictDepthCheck > 0.5 && useDepthCheck > 0.5 && visibilityCoverage < 0.5) discard;
    float depthWeight = mix(0.7, 1.0, visibilityCoverage);
    vec4 texel = sampleProjectedCleanBilinear(projectedMap, projectedSampleUv);
    texel.rgb = applyHsvAdjustments(texel.rgb);
    float sourceAlpha = texel.a * maskCoverage;
    if (sourceAlpha < 0.01) discard;
    float angleWeight = computeAngleWeight(visibilityBackedNdv, layerStrength);
    float coverageEdge = computeImageEdgeFade(projectedSampleUv, 0.015);
    float coverage = clamp(layerOpacity * sourceAlpha * angleCoverage * visibilityCoverage * projectionFacingCoverage * mix(0.35, 1.0, coverageEdge), 0.0, 1.0);
    if (coverage <= max(0.025, minimumOutputCoverage)) discard;
    float qualityEdge = computeImageEdgeFade(projectedSampleUv, 0.035);
    float quality = coverage * depthWeight * angleWeight * mix(0.3, 1.0, qualityEdge);
    float qualityAlpha = clamp(max(quality, coverage * ${QUALITY_FLOOR_FROM_COVERAGE.toFixed(2)}), 0.0, 1.0);
    float writeAlpha = mix(qualityAlpha, coverage, useCoverageAlpha);

    if (useQualityDepth > 0.5) {
      gl_FragDepthEXT = 1.0 - qualityAlpha;
      gl_FragColor = vec4(texel.rgb * coverage, coverage);
      return;
    }

    gl_FragColor = vec4(texel.rgb, writeAlpha);
  }
`;

const fullscreenVertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const dilationFragmentShader = `
  uniform sampler2D sourceMap;
  uniform vec2 texelSize;
  varying vec2 vUv;

  vec4 unpremultiply(vec4 color) {
    if (color.a <= 0.0001) return vec4(0.0);
    return vec4(color.rgb / color.a, color.a);
  }

  void accumulateNeighbor(
    vec4 color,
    float weight,
    inout vec3 colorSum,
    inout float alphaSum,
    inout float weightSum
  ) {
    if (color.a <= 0.0001) return;
    colorSum += unpremultiply(color).rgb * weight;
    alphaSum += color.a * weight;
    weightSum += weight;
  }

  void main() {
    vec4 center = texture2D(sourceMap, vUv);
    if (center.a > 0.0001) {
      gl_FragColor = center;
      return;
    }

    vec3 colorSum = vec3(0.0);
    float alphaSum = 0.0;
    float weightSum = 0.0;
    accumulateNeighbor(texture2D(sourceMap, vUv + vec2(-texelSize.x, 0.0)), 1.0, colorSum, alphaSum, weightSum);
    accumulateNeighbor(texture2D(sourceMap, vUv + vec2(texelSize.x, 0.0)), 1.0, colorSum, alphaSum, weightSum);
    accumulateNeighbor(texture2D(sourceMap, vUv + vec2(0.0, texelSize.y)), 1.0, colorSum, alphaSum, weightSum);
    accumulateNeighbor(texture2D(sourceMap, vUv + vec2(0.0, -texelSize.y)), 1.0, colorSum, alphaSum, weightSum);
    accumulateNeighbor(texture2D(sourceMap, vUv + vec2(-texelSize.x, -texelSize.y)), 0.7071, colorSum, alphaSum, weightSum);
    accumulateNeighbor(texture2D(sourceMap, vUv + vec2(texelSize.x, -texelSize.y)), 0.7071, colorSum, alphaSum, weightSum);
    accumulateNeighbor(texture2D(sourceMap, vUv + vec2(-texelSize.x, texelSize.y)), 0.7071, colorSum, alphaSum, weightSum);
    accumulateNeighbor(texture2D(sourceMap, vUv + vec2(texelSize.x, texelSize.y)), 0.7071, colorSum, alphaSum, weightSum);
    if (weightSum <= 0.0) {
      gl_FragColor = vec4(0.0);
      return;
    }
    float alpha = alphaSum / weightSum;
    vec3 straightColor = colorSum / weightSum;
    // Render targets contain premultiplied RGB. Preserve the neighbouring alpha
    // instead of forcing a solid ring around a feathered transparent overlay.
    gl_FragColor = vec4(straightColor * alpha, alpha);
  }
`;

const uvTopologyFragmentShader = `
  void main() {
    gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
  }
`;

const topologyDilationFragmentShader = `
  uniform sampler2D sourceMap;
  uniform vec2 texelSize;
  varying vec2 vUv;

  void main() {
    float occupied = texture2D(sourceMap, vUv).r;
    occupied = max(occupied, texture2D(sourceMap, vUv + vec2(-texelSize.x, 0.0)).r);
    occupied = max(occupied, texture2D(sourceMap, vUv + vec2(texelSize.x, 0.0)).r);
    occupied = max(occupied, texture2D(sourceMap, vUv + vec2(0.0, texelSize.y)).r);
    occupied = max(occupied, texture2D(sourceMap, vUv + vec2(0.0, -texelSize.y)).r);
    occupied = max(occupied, texture2D(sourceMap, vUv + vec2(-texelSize.x, -texelSize.y)).r);
    occupied = max(occupied, texture2D(sourceMap, vUv + vec2(texelSize.x, -texelSize.y)).r);
    occupied = max(occupied, texture2D(sourceMap, vUv + vec2(-texelSize.x, texelSize.y)).r);
    occupied = max(occupied, texture2D(sourceMap, vUv + vec2(texelSize.x, texelSize.y)).r);
    gl_FragColor = vec4(occupied, 0.0, 0.0, 1.0);
  }
`;

const interiorHoleConstraintFragmentShader = `
  uniform sampler2D sourceMap;
  uniform sampler2D originalMap;
  uniform sampler2D uvTopologyBaseMap;
  uniform sampler2D uvTopologyMap;
  varying vec2 vUv;

  void main() {
    vec4 original = texture2D(originalMap, vUv);
    if (original.a > 0.0001) {
      // Never alter the original projection edge. Fading it here created the
      // dark contour around every small UV fragment.
      gl_FragColor = original;
      return;
    }

    vec4 expanded = texture2D(sourceMap, vUv);
    float insideOriginalUv = texture2D(uvTopologyBaseMap, vUv).r;
    float insidePaddedUv = texture2D(uvTopologyMap, vUv).r;
    // Only bridge a texel that was absent from the original UV raster but is
    // recovered by its one-pixel topology padding. A normal transparent texel
    // inside an existing UV island is the brush boundary and must stay empty.
    gl_FragColor = expanded.a > 0.0001 && insideOriginalUv <= 0.0001 && insidePaddedUv > 0.0001
      ? expanded
      : vec4(0.0);
  }
`;

const copyFragmentShader = `
  uniform sampler2D sourceMap;
  varying vec2 vUv;

  void main() {
    gl_FragColor = texture2D(sourceMap, vUv);
  }
`;

const uvSeamRepairVertexShader = `
  attribute vec2 pairedUv;
  varying vec2 vDestinationUv;
  varying vec2 vPairedUv;

  void main() {
    vDestinationUv = position.xy;
    vPairedUv = pairedUv;
    gl_Position = vec4(position.xy * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const uvSeamRepairFragmentShader = `
  uniform sampler2D sourceMap;
  varying vec2 vDestinationUv;
  varying vec2 vPairedUv;

  void main() {
    vec4 destination = texture2D(sourceMap, clamp(vDestinationUv, vec2(0.0), vec2(1.0)));
    vec4 paired = texture2D(sourceMap, clamp(vPairedUv, vec2(0.0), vec2(1.0)));
    // Local repaint needs missing-coverage transfer, not colour averaging.
    // Preserve authored texels and copy only when the geometrically paired UV
    // side contains valid projected coverage.
    if (destination.a > 0.0001 || paired.a <= 0.0001) discard;
    gl_FragColor = paired;
  }
`;

const sharpenFragmentShader = `
  uniform sampler2D sourceMap;
  uniform vec2 texelSize;
  uniform float sharpenAmount;
  uniform float detailThreshold;
  varying vec2 vUv;

  vec3 straightRgb(vec4 color) {
    if (color.a <= 0.0001) return vec3(0.0);
    return color.rgb / color.a;
  }

  vec4 sampleColor(vec2 uv) {
    return texture2D(sourceMap, uv);
  }

  void main() {
    vec4 center = sampleColor(vUv);
    if (center.a <= 0.0001) {
      gl_FragColor = center;
      return;
    }

    vec3 centerRgb = straightRgb(center);
    vec3 weightedSum = vec3(0.0);
    float totalWeight = 0.0;

    for (int oy = -1; oy <= 1; oy += 1) {
      for (int ox = -1; ox <= 1; ox += 1) {
        vec2 sampleUv = clamp(vUv + vec2(float(ox), float(oy)) * texelSize, vec2(0.0), vec2(1.0));
        vec4 sampleTexel = sampleColor(sampleUv);
        if (sampleTexel.a <= 0.0001) continue;
        float weight = ox == 0 && oy == 0 ? 4.0 : (ox == 0 || oy == 0 ? 2.0 : 1.0);
        weightedSum += straightRgb(sampleTexel) * weight;
        totalWeight += weight;
      }
    }

    vec3 blurred = totalWeight > 0.0 ? weightedSum / totalWeight : centerRgb;
    vec3 detail = centerRgb - blurred;
    vec3 sharpened = mix(centerRgb, centerRgb + detail * sharpenAmount, step(detailThreshold, max(max(abs(detail.r), abs(detail.g)), abs(detail.b))));
    sharpened = clamp(sharpened, 0.0, 1.0);
    gl_FragColor = vec4(sharpened * center.a, center.a);
  }
`;

function prepareTexture(
  texture: THREE.Texture,
  minFilter: THREE.MinificationTextureFilter,
  magFilter: THREE.MagnificationTextureFilter,
  flipY = false,
) {
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = flipY;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = minFilter;
  texture.magFilter = magFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function createNeutralTexture() {
  const texture = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    THREE.RGBAFormat,
  );
  return prepareTexture(texture, THREE.NearestFilter, THREE.NearestFilter);
}

function getTextureImageSize(texture: THREE.Texture) {
  const image = texture.image as
    | { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number }
    | undefined;
  const width = image?.naturalWidth ?? image?.width ?? 'unknown';
  const height = image?.naturalHeight ?? image?.height ?? 'unknown';
  return `${width}x${height}`;
}

async function loadLayerTextureFromCpuImageData(input: {
  url: string;
  resolution: number;
  label: string;
  minFilter: THREE.MinificationTextureFilter;
  magFilter: THREE.MagnificationTextureFilter;
  flipY: boolean;
}) {
  let resident = residentPreviewTextureCache.get(input.url);
  if (!resident) {
    try {
      // GPU baking needs a decoded TexImageSource, not a CPU ImageData copy.
      // Reuse the asynchronous bitmap decoder used by the viewport so depth
      // and normal assets never pass through drawImage/getImageData on the UI
      // thread. Oversized sources still use the exact legacy resize path below.
      markGpuUvBakeStep('gpu-load-preview-bitmap');
      resident = await loadPreviewTexture(resolveImageAssetUrl(input.url));
    } catch {
      resident = undefined;
    }
  }
  const residentImage = resident?.image as
    | (TexImageSource & {
        width?: number;
        height?: number;
        naturalWidth?: number;
        naturalHeight?: number;
      })
    | undefined;
  const residentWidth = residentImage?.naturalWidth ?? residentImage?.width ?? 0;
  const residentHeight = residentImage?.naturalHeight ?? residentImage?.height ?? 0;
  if (
    resident &&
    residentImage &&
    residentWidth > 0 &&
    residentHeight > 0 &&
    Math.max(residentWidth, residentHeight) <= input.resolution
  ) {
    // Viewport prewarm already owns this exact decoded source. Clone only the
    // lightweight Three texture descriptor and preserve the resident image's
    // physical orientation; the bitmap remains owned by the resident cache.
    const workerBitmapId = resident.userData.liclickPreviewWorkerBitmapId;
    const texture = prepareTexture(
      typeof workerBitmapId === 'number'
        ? new THREE.DataTexture(
            null,
            residentWidth,
            residentHeight,
            THREE.RGBAFormat,
            THREE.UnsignedByteType,
          )
        : new THREE.Texture(residentImage),
      input.minFilter,
      input.magFilter,
      resident.flipY,
    );
    if (typeof workerBitmapId === 'number') {
      texture.userData.liclickPreviewWorkerBitmapId = workerBitmapId;
      texture.source.dataReady = false;
    }
    texture.userData.liclickSharedResidentBitmap = true;
    return texture;
  }
  markGpuUvBakeStep('gpu-load-cpu-image-data');
  const imageData = await loadImageData(input.url, input.resolution, input.label);
  markGpuUvBakeStep('gpu-create-cpu-image-texture');
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error(`Could not create texture canvas for ${input.label}.`);
  context.putImageData(imageData, 0, 0);
  const bitmap =
    typeof createImageBitmap === 'function' ? await createImageBitmap(canvas) : undefined;
  return prepareTexture(
    bitmap ? new THREE.Texture(bitmap) : new THREE.CanvasTexture(canvas),
    input.minFilter,
    input.magFilter,
    input.flipY,
  );
}

async function stageLayerTexturesForGpu(
  renderer: THREE.WebGLRenderer,
  textures: Iterable<THREE.Texture>,
) {
  let maximumUploadMs = 0;
  for (const texture of new Set(textures)) {
    // Give the onscreen renderer one presentation opportunity before every
    // full-resolution asset upload. ImageBitmap sources use exact striped
    // texSubImage2D uploads; compatibility sources still remain one asset per
    // frame instead of four consecutive uploads inside the bake draw.
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    await waitForSharedRendererBakeSlot();
    const startedAt = performance.now();
    await uploadPreviewTextureInStripes(renderer, texture);
    maximumUploadMs = Math.max(maximumUploadMs, performance.now() - startedAt);
  }
  if (typeof document !== 'undefined') {
    document.body.dataset.uvBakeMaximumStagedTextureUploadMs = Math.max(
      Number(document.body.dataset.uvBakeMaximumStagedTextureUploadMs ?? '0'),
      maximumUploadMs,
    ).toFixed(1);
  }
}

function disposeLayerTextures(textures: Iterable<THREE.Texture>) {
  for (const texture of new Set(textures)) {
    const image = texture.image;
    texture.dispose();
    if (
      texture.userData.liclickSharedResidentBitmap !== true &&
      typeof ImageBitmap !== 'undefined' &&
      image instanceof ImageBitmap
    )
      image.close();
  }
}

async function loadLayerTexturesWithOptions(
  layer: Layer,
  resolution: UvBakeResolution,
  options: { inputTextureFlipY: boolean },
): Promise<LoadedLayerTextures> {
  const projectedTexture = await loadLayerTextureFromCpuImageData({
    url: layer.imageUrl,
    resolution,
    label: `${layer.name} image`,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    flipY: options.inputTextureFlipY,
  });
  const neutralTexture = createNeutralTexture();
  const maskTexture = layer.maskUrl
    ? await loadLayerTextureFromCpuImageData({
        url: layer.maskUrl,
        resolution,
        label: `${layer.name} mask`,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        flipY: options.inputTextureFlipY,
      })
    : neutralTexture;
  const depthTexture = layer.depthUrl
    ? await loadLayerTextureFromCpuImageData({
        url: layer.depthUrl,
        resolution,
        label: `${layer.name} depth`,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        flipY: options.inputTextureFlipY,
      })
    : neutralTexture;
  const normalTexture = layer.normalUrl
    ? await loadLayerTextureFromCpuImageData({
        url: layer.normalUrl,
        resolution,
        label: `${layer.name} normal`,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        flipY: options.inputTextureFlipY,
      })
    : neutralTexture;
  return {
    projectedTexture,
    maskTexture,
    depthTexture,
    normalTexture,
    useMask: Boolean(layer.maskUrl),
    useDepthCheck: Boolean(layer.depthUrl),
    useNormalCheck: Boolean(layer.normalUrl),
    disposableTextures: [...new Set([projectedTexture, maskTexture, depthTexture, normalTexture])],
    sourceSizes: {
      layerId: layer.id,
      layerName: layer.name,
      projectedImage: getTextureImageSize(projectedTexture),
      maskImage: layer.maskUrl ? getTextureImageSize(maskTexture) : undefined,
      depthImage: layer.depthUrl ? getTextureImageSize(depthTexture) : undefined,
      normalImage: layer.normalUrl ? getTextureImageSize(normalTexture) : undefined,
    },
  };
}

function createObjectMatrixDelta(group: THREE.Group, layer: Layer) {
  group.updateMatrixWorld(true);
  if (!layer.objectMatrixWorld) return new THREE.Matrix4();
  return new THREE.Matrix4()
    .fromArray(layer.objectMatrixWorld)
    .multiply(group.matrixWorld.clone().invert());
}

function debugObjectMatrixDelta(group: THREE.Group, layer: Layer, delta: THREE.Matrix4) {
  if (!shouldDebugUvBake()) return;
  console.info('[Liclick 3D Texture] GPU UV bake object matrix delta:', layer.name);
  console.table({
    objectMatrixDelta: delta.elements.join(','),
    layerObjectMatrixWorld: layer.objectMatrixWorld?.join(',') ?? 'missing',
    currentGroupMatrixWorld: group.matrixWorld.elements.join(','),
  });
}

function getTriangleCount(mesh: THREE.Mesh) {
  const position = mesh.geometry.getAttribute('position');
  const uv = mesh.geometry.getAttribute('uv');
  if (!position || !uv) return 0;
  const index = mesh.geometry.getIndex();
  return index ? index.count / 3 : position.count / 3;
}

function collectPreparedMeshes(group: THREE.Group, warnings: string[]) {
  const meshes: PreparedMesh[] = [];
  group.updateMatrixWorld(true);
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const position = child.geometry.getAttribute('position');
    const uv = child.geometry.getAttribute('uv');
    if (!position || !uv) {
      warnings.push(`Mesh ${child.name || child.uuid} has no UV or position attribute.`);
      return;
    }
    if (!child.geometry.getAttribute('normal')) {
      child.geometry.computeVertexNormals();
      warnings.push(`Mesh ${child.name || child.uuid} had no normals; computed fallback normals.`);
    }
    meshes.push({ source: child, triangleCount: getTriangleCount(child) });
  });
  if (shouldDebugUvBake()) {
    console.table(
      meshes.map(({ source }) => ({
        name: source.name,
        uuid: source.uuid,
        visible: source.visible,
        positionCount: source.geometry.getAttribute('position')?.count,
        uvCount: source.geometry.getAttribute('uv')?.count,
        parent: source.parent?.name,
      })),
    );
  }
  return meshes;
}

function createLayerMaterial(input: {
  group: THREE.Group;
  layer: Layer;
  textures: LoadedLayerTextures;
  enableBackfaceCulling: boolean;
  compositeMode: GpuUvCompositeMode;
  projectedImageUvFlipY: boolean;
  strictDepthCheck?: boolean;
  maximumDepthError?: number;
  minimumOutputCoverage?: number;
}) {
  if (!input.layer.camera) throw new Error('Projected layer has no capture camera.');
  const objectMatrixDelta = createObjectMatrixDelta(input.group, input.layer);
  debugObjectMatrixDelta(input.group, input.layer, objectMatrixDelta);
  const projectedImage = input.textures.projectedTexture.image as {
    width?: number;
    height?: number;
  };
  const visibilityImage = (
    input.textures.useNormalCheck
      ? input.textures.normalTexture.image
      : input.textures.depthTexture.image
  ) as { width?: number; height?: number };
  return new THREE.ShaderMaterial({
    name: `LiclickGpuUvBake:${input.layer.id}`,
    vertexShader,
    fragmentShader,
    uniforms: {
      projectedMap: { value: input.textures.projectedTexture },
      maskMap: { value: input.textures.maskTexture },
      depthMap: { value: input.textures.depthTexture },
      normalMap: { value: input.textures.normalTexture },
      projectorMatrix: { value: buildProjectionMatrixBundle(input.layer.camera).projectorMatrix },
      projectorViewMatrix: {
        value: new THREE.Matrix4().fromArray(input.layer.camera.viewMatrix),
      },
      objectMatrixDelta: { value: objectMatrixDelta },
      objectNormalDelta: { value: new THREE.Matrix3().getNormalMatrix(objectMatrixDelta) },
      projectorPosition: { value: new THREE.Vector3().fromArray(input.layer.camera.position) },
      layerOpacity: { value: input.layer.opacity },
      layerStrength: { value: input.layer.strength ?? 1 },
      useMask: { value: input.textures.useMask ? 1 : 0 },
      maskUsesUv: { value: input.layer.maskSpace === 'uv' ? 1 : 0 },
      useDepthCheck: { value: input.textures.useDepthCheck ? 1 : 0 },
      useNormalCheck: { value: input.textures.useNormalCheck ? 1 : 0 },
      depthIsLinearView: { value: input.layer.depthEncoding === 'linear-view' ? 1 : 0 },
      projectorNear: { value: input.layer.camera.near },
      projectorFar: { value: input.layer.camera.far },
      strictDepthCheck: { value: input.strictDepthCheck ? 1 : 0 },
      maximumDepthError: {
        value: THREE.MathUtils.clamp(input.maximumDepthError ?? DEPTH_EPSILON, 0.001, 1),
      },
      minimumOutputCoverage: {
        value: THREE.MathUtils.clamp(input.minimumOutputCoverage ?? 0, 0, 0.99),
      },
      minimumProjectionFacing: {
        value: THREE.MathUtils.clamp(input.layer.minimumProjectionFacing ?? 0, 0, 0.99),
      },
      surfaceLockedVisibility: {
        value: input.layer.projectionVisibilityPolicy === 'surface-locked-v1' ? 1 : 0,
      },
      enableBackfaceCulling: { value: input.enableBackfaceCulling ? 1 : 0 },
      useCoverageAlpha: { value: input.compositeMode === 'coverage-alpha' ? 1 : 0 },
      useQualityDepth: { value: input.compositeMode === 'quality-depth' ? 1 : 0 },
      projectedImageUvFlipY: { value: input.projectedImageUvFlipY ? 1 : 0 },
      depthEpsilon: { value: DEPTH_EPSILON },
      visibilityTexelSize: {
        value: new THREE.Vector2(
          1 / Math.max(1, visibilityImage.width ?? 1),
          1 / Math.max(1, visibilityImage.height ?? 1),
        ),
      },
      projectedMapSize: {
        value: new THREE.Vector2(projectedImage.width ?? 1, projectedImage.height ?? 1),
      },
      hueShift: { value: (input.layer.adjustments?.hue ?? 0) / 100 },
      saturationShift: { value: (input.layer.adjustments?.saturation ?? 0) / 100 },
      lightnessShift: { value: (input.layer.adjustments?.lightness ?? 0) / 100 },
    },
    blending: input.compositeMode === 'quality-depth' ? THREE.NoBlending : THREE.NormalBlending,
    depthTest: input.compositeMode === 'quality-depth',
    depthWrite: input.compositeMode === 'quality-depth',
    depthFunc: THREE.LessDepth,
    premultipliedAlpha: false,
    transparent: input.compositeMode !== 'quality-depth',
    toneMapped: false,
    side: THREE.DoubleSide,
  });
}

async function createBakeScene(meshes: PreparedMesh[]) {
  const scene = new THREE.Scene();
  const bakeMeshes: THREE.Mesh[] = [];
  let budgetStartedAt = performance.now();
  for (const mesh of meshes) {
    const bakeMesh = new THREE.Mesh(mesh.source.geometry);
    bakeMesh.matrixAutoUpdate = false;
    bakeMesh.matrix.copy(mesh.source.matrixWorld);
    bakeMesh.matrixWorld.copy(mesh.source.matrixWorld);
    bakeMesh.matrixWorldAutoUpdate = false;
    bakeMesh.frustumCulled = false;
    scene.add(bakeMesh);
    bakeMeshes.push(bakeMesh);
    if (isGpuUvBakeInteractionProtected() && performance.now() - budgetStartedAt >= 4) {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      budgetStartedAt = performance.now();
    }
  }
  // Every child owns the already-resolved source matrixWorld and disables both
  // matrix update paths. A forced traversal here only re-walks large imported
  // scenes without changing a single bake transform.
  return { scene, bakeMeshes };
}

function createPostprocessTarget(resolution: number) {
  const target = new THREE.WebGLRenderTarget(resolution, resolution, {
    depthBuffer: false,
    stencilBuffer: false,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  return target;
}

function createTopologyTarget(resolution: number) {
  const target = new THREE.WebGLRenderTarget(resolution, resolution, {
    depthBuffer: false,
    stencilBuffer: false,
    format: THREE.RedFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  return target;
}

function getUvEdgeInward(edge: UvSeamEdgeRecord) {
  const direction = edge.b.uv.clone().sub(edge.a.uv);
  const length = direction.length();
  if (length <= 1e-8) return new THREE.Vector2();
  direction.multiplyScalar(1 / length);
  const inward = new THREE.Vector2(-direction.y, direction.x);
  if (edge.insideUv.clone().sub(edge.a.uv).dot(inward) < 0) inward.multiplyScalar(-1);
  return inward;
}

function createUvSeamRepairGeometry(root: THREE.Object3D, resolution: number, bandPixels: number) {
  let seamPairs = gpuUvSeamPairCache.get(root);
  if (!seamPairs) {
    seamPairs = collectUvSeamPairs(root, true);
    gpuUvSeamPairCache.set(root, seamPairs);
  }
  if (seamPairs.length === 0) return undefined;
  const positions: number[] = [];
  const pairedUvs: number[] = [];
  const indices: number[] = [];
  const minimumDepth = 0.25 / resolution;
  const maximumDepth = (Math.max(2, Math.min(32, bandPixels)) + 0.5) / resolution;

  const appendDirection = (destination: UvSeamEdgeRecord, paired: UvSeamEdgeRecord) => {
    const destinationInward = getUvEdgeInward(destination);
    const pairedInward = getUvEdgeInward(paired);
    if (destinationInward.lengthSq() <= 1e-12 || pairedInward.lengthSq() <= 1e-12) return;
    const destinationPoints = [
      destination.a.uv.clone().addScaledVector(destinationInward, minimumDepth),
      destination.b.uv.clone().addScaledVector(destinationInward, minimumDepth),
      destination.b.uv.clone().addScaledVector(destinationInward, maximumDepth),
      destination.a.uv.clone().addScaledVector(destinationInward, maximumDepth),
    ];
    const pairedPoints = [
      paired.a.uv.clone().addScaledVector(pairedInward, minimumDepth),
      paired.b.uv.clone().addScaledVector(pairedInward, minimumDepth),
      paired.b.uv.clone().addScaledVector(pairedInward, maximumDepth),
      paired.a.uv.clone().addScaledVector(pairedInward, maximumDepth),
    ];
    const baseIndex = positions.length / 3;
    destinationPoints.forEach((point) => positions.push(point.x, point.y, 0));
    pairedPoints.forEach((point) => pairedUvs.push(point.x, point.y));
    indices.push(baseIndex, baseIndex + 1, baseIndex + 2, baseIndex, baseIndex + 2, baseIndex + 3);
  };

  seamPairs.forEach(([first, second]) => {
    appendDirection(first, second);
    appendDirection(second, first);
  });
  if (indices.length === 0) return undefined;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('pairedUv', new THREE.Float32BufferAttribute(pairedUvs, 2));
  geometry.setIndex(indices);
  return { geometry, seamPairs: seamPairs.length };
}

function renderFullscreenPass(input: {
  renderer: THREE.WebGLRenderer;
  source: THREE.WebGLRenderTarget;
  target: THREE.WebGLRenderTarget;
  material: THREE.ShaderMaterial;
  camera: THREE.OrthographicCamera;
}) {
  input.material.uniforms.sourceMap.value = input.source.texture;
  input.renderer.setRenderTarget(input.target);
  input.renderer.clear(true, true, true);
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), input.material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  input.renderer.render(scene, input.camera);
  scene.clear();
  mesh.geometry.dispose();
}

function runGpuPostprocess(input: {
  renderer: THREE.WebGLRenderer;
  source: THREE.WebGLRenderTarget;
  uvTopologySource?: THREE.WebGLRenderTarget;
  uvSeamGeometry?: THREE.BufferGeometry;
  resolution: UvBakeResolution;
  enableDilation: boolean;
  dilationPixels: number;
  enableSharpen: boolean;
  constrainDilationToInteriorHoles?: boolean;
}) {
  if (!input.enableDilation && !input.enableSharpen && !input.uvSeamGeometry) {
    return { target: input.source, ownedTargets: [] };
  }

  let current = input.source;
  const ownedTargets: THREE.WebGLRenderTarget[] = [];
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  const texelSize = new THREE.Vector2(1 / input.resolution, 1 / input.resolution);
  const ping = createPostprocessTarget(input.resolution);
  const pong = createPostprocessTarget(input.resolution);
  ownedTargets.push(ping, pong);
  let next = ping;

  const dilationMaterial = new THREE.ShaderMaterial({
    vertexShader: fullscreenVertexShader,
    fragmentShader: dilationFragmentShader,
    uniforms: {
      sourceMap: { value: current.texture },
      texelSize: { value: texelSize },
    },
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });

  let paddedUvTopology: THREE.WebGLRenderTarget | undefined;
  if (input.enableDilation && input.constrainDilationToInteriorHoles && input.uvTopologySource) {
    const topologyPing = createTopologyTarget(input.resolution);
    const topologyPong = createTopologyTarget(input.resolution);
    ownedTargets.push(topologyPing, topologyPong);
    let topologyCurrent = input.uvTopologySource;
    let topologyNext = topologyPing;
    const topologyDilationMaterial = new THREE.ShaderMaterial({
      vertexShader: fullscreenVertexShader,
      fragmentShader: topologyDilationFragmentShader,
      uniforms: {
        sourceMap: { value: topologyCurrent.texture },
        texelSize: { value: texelSize },
      },
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    // Grow topology by the same number of texels as the colour pass. The final
    // constraint therefore keeps a real multi-pixel atlas gutter while still
    // rejecting dilation into an unpainted model-surface texel.
    for (let iteration = 0; iteration < input.dilationPixels; iteration += 1) {
      renderFullscreenPass({
        renderer: input.renderer,
        source: topologyCurrent,
        target: topologyNext,
        material: topologyDilationMaterial,
        camera,
      });
      topologyCurrent = topologyNext;
      topologyNext = topologyNext === topologyPing ? topologyPong : topologyPing;
    }
    paddedUvTopology = topologyCurrent;
    topologyDilationMaterial.dispose();
  }

  if (input.enableDilation) {
    for (let iteration = 0; iteration < input.dilationPixels; iteration += 1) {
      renderFullscreenPass({
        renderer: input.renderer,
        source: current,
        target: next,
        material: dilationMaterial,
        camera,
      });
      current = next;
      next = next === ping ? pong : ping;
    }
  }
  dilationMaterial.dispose();

  if (input.enableDilation && input.constrainDilationToInteriorHoles && paddedUvTopology) {
    const constraintMaterial = new THREE.ShaderMaterial({
      vertexShader: fullscreenVertexShader,
      fragmentShader: interiorHoleConstraintFragmentShader,
      uniforms: {
        sourceMap: { value: current.texture },
        originalMap: { value: input.source.texture },
        uvTopologyBaseMap: { value: input.uvTopologySource?.texture },
        uvTopologyMap: { value: paddedUvTopology.texture },
      },
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    renderFullscreenPass({
      renderer: input.renderer,
      source: current,
      target: next,
      material: constraintMaterial,
      camera,
    });
    current = next;
    next = next === ping ? pong : ping;
    constraintMaterial.dispose();
  }

  if (input.uvSeamGeometry) {
    const copyMaterial = new THREE.ShaderMaterial({
      vertexShader: fullscreenVertexShader,
      fragmentShader: copyFragmentShader,
      uniforms: { sourceMap: { value: current.texture } },
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    renderFullscreenPass({
      renderer: input.renderer,
      source: current,
      target: next,
      material: copyMaterial,
      camera,
    });
    copyMaterial.dispose();

    const seamMaterial = new THREE.ShaderMaterial({
      vertexShader: uvSeamRepairVertexShader,
      fragmentShader: uvSeamRepairFragmentShader,
      uniforms: { sourceMap: { value: current.texture } },
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const seamScene = new THREE.Scene();
    const seamMesh = new THREE.Mesh(input.uvSeamGeometry, seamMaterial);
    seamMesh.frustumCulled = false;
    seamScene.add(seamMesh);
    input.renderer.autoClear = false;
    input.renderer.setRenderTarget(next);
    input.renderer.render(seamScene, camera);
    seamScene.clear();
    seamMaterial.dispose();
    current = next;
    next = next === ping ? pong : ping;
  }

  if (input.enableSharpen && input.resolution <= MAX_GPU_SHARPEN_RESOLUTION) {
    const sharpenMaterial = new THREE.ShaderMaterial({
      vertexShader: fullscreenVertexShader,
      fragmentShader: sharpenFragmentShader,
      uniforms: {
        sourceMap: { value: current.texture },
        texelSize: { value: texelSize },
        sharpenAmount: { value: SHARPEN_AMOUNT },
        detailThreshold: { value: SHARPEN_DETAIL_THRESHOLD },
      },
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    renderFullscreenPass({
      renderer: input.renderer,
      source: current,
      target: next,
      material: sharpenMaterial,
      camera,
    });
    current = next;
    sharpenMaterial.dispose();
  }

  return { target: current, ownedTargets };
}

function waitForSharedRendererBakeSlot() {
  if (
    !isViewportInteractionBusy() &&
    (typeof document === 'undefined' ||
      document.body.dataset.perfSimulatedViewportInteraction !== '1')
  ) {
    return Promise.resolve();
  }
  // R3F owns this WebGL context. During an active drag, allow its onscreen
  // frame to submit before issuing the next offscreen 4K bake pass.
  return new Promise<void>((resolve) =>
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0)),
  );
}

// Four MiB PBO stripes keep both readPixels submission and getBufferSubData
// below the viewport frame budget under simultaneous 4K baking. Pixel bytes
// and their order are unchanged; only transfer scheduling is finer grained.
const GPU_READBACK_STRIPE_BYTES = 4 * 1024 * 1024;

type GpuReadbackBufferPool = {
  buffers: WebGLBuffer[];
  bytesPerBuffer: number;
};

const gpuReadbackBufferPools = new WeakMap<WebGL2RenderingContext, GpuReadbackBufferPool>();

function waitForGpuFence(gl: WebGL2RenderingContext, sync: WebGLSync) {
  return new Promise<void>((resolve, reject) => {
    const probe = () => {
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status === gl.WAIT_FAILED) {
        reject(new Error('GPU UV readback fence failed.'));
        return;
      }
      if (status === gl.TIMEOUT_EXPIRED) {
        window.setTimeout(probe, 4);
        return;
      }
      resolve();
    };
    window.setTimeout(probe, 0);
  });
}

function getGpuReadbackBuffers(gl: WebGL2RenderingContext, count: number, bytesPerBuffer: number) {
  let pool = gpuReadbackBufferPools.get(gl);
  const poolIsValid =
    pool &&
    pool.bytesPerBuffer >= bytesPerBuffer &&
    pool.buffers.length >= count &&
    pool.buffers.every((buffer) => gl.isBuffer(buffer));
  if (!poolIsValid) {
    pool?.buffers.forEach((buffer) => gl.deleteBuffer(buffer));
    const buffers: WebGLBuffer[] = [];
    for (let index = 0; index < count; index += 1) {
      const buffer = gl.createBuffer();
      if (!buffer) throw new Error('Unable to allocate GPU UV readback buffer.');
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytesPerBuffer, gl.STREAM_READ);
      buffers.push(buffer);
    }
    pool = { buffers, bytesPerBuffer };
    gpuReadbackBufferPools.set(gl, pool);
  }
  return pool!.buffers.slice(0, count);
}

/**
 * Submits every stripe before waiting for the first one. Three's public async
 * helper serializes submit -> fence -> copy for each stripe, leaving the GPU
 * idle between transfers. A bounded, reusable PBO pool keeps the exact same
 * 4K pixels while allowing the driver to pipeline the full target readback.
 */
async function readRenderTargetPixelsPipelined(
  renderer: THREE.WebGLRenderer,
  resolution: number,
  rowsPerStripe: number,
) {
  const gl = renderer.getContext();
  if (!(gl instanceof WebGL2RenderingContext)) return undefined;
  const readbackPhasePrefix =
    typeof document !== 'undefined' ? document.body.dataset.perfUvBakePhase : undefined;
  const markReadbackPhase = (suffix: string) => {
    if (!readbackPhasePrefix) return;
    markGpuUvBakeStep(`${readbackPhasePrefix}-${suffix}`);
  };

  const stripeCount = Math.ceil(resolution / rowsPerStripe);
  const maximumStripeBytes = resolution * rowsPerStripe * 4;
  const buffers = getGpuReadbackBuffers(gl, stripeCount, maximumStripeBytes);
  const fences: WebGLSync[] = [];

  try {
    for (let stripeIndex = 0; stripeIndex < stripeCount; stripeIndex += 1) {
      const y = stripeIndex * rowsPerStripe;
      const rowCount = Math.min(rowsPerStripe, resolution - y);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffers[stripeIndex]);
      markReadbackPhase('pbo-submit');
      gl.readPixels(0, y, resolution, rowCount, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!fence) throw new Error('Unable to create GPU UV readback fence.');
      fences.push(fence);
      if (isGpuUvBakeInteractionProtected() && stripeIndex + 1 < stripeCount) {
        markReadbackPhase('pbo-submit-yield');
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.flush();
        await new Promise<void>((resolve) =>
          window.requestAnimationFrame(() => window.setTimeout(resolve, 0)),
        );
      }
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.flush();

    const pixels = acquireGpuReadbackPixels(resolution * resolution * 4);
    let maximumStripeMs = 0;
    const startedAt = performance.now();
    for (let stripeIndex = 0; stripeIndex < stripeCount; stripeIndex += 1) {
      const stripeStartedAt = performance.now();
      markReadbackPhase('pbo-fence-wait');
      await waitForGpuFence(gl, fences[stripeIndex]);
      const y = stripeIndex * rowsPerStripe;
      const rowCount = Math.min(rowsPerStripe, resolution - y);
      const elementCount = resolution * rowCount * 4;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffers[stripeIndex]);
      markReadbackPhase('pbo-copy');
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels, y * resolution * 4, elementCount);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      maximumStripeMs = Math.max(maximumStripeMs, performance.now() - stripeStartedAt);
      if (typeof document !== 'undefined') {
        document.body.dataset.uvBakeReadbackCompletedStripes = String(stripeIndex + 1);
      }
      if (stripeIndex + 1 < stripeCount) {
        markReadbackPhase('pbo-copy-yield');
        await new Promise<void>((resolve) =>
          window.requestAnimationFrame(() => window.setTimeout(resolve, 0)),
        );
      }
    }
    return { pixels, maximumStripeMs, totalMs: performance.now() - startedAt };
  } finally {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    fences.forEach((fence) => gl.deleteSync(fence));
  }
}

async function readRenderTargetPixelsInStripes(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
  resolution: number,
) {
  const rowsPerStripe = Math.max(
    1,
    Math.min(resolution, Math.floor(GPU_READBACK_STRIPE_BYTES / (resolution * 4))),
  );
  const startedAt = performance.now();
  let maximumStripeMs = 0;
  let pipelinedResult: Awaited<ReturnType<typeof readRenderTargetPixelsPipelined>>;
  try {
    pipelinedResult = await readRenderTargetPixelsPipelined(renderer, resolution, rowsPerStripe);
  } catch (error) {
    console.warn('[Liclick 3D Texture] Pipelined UV readback failed; using safe fallback.', error);
    pipelinedResult = undefined;
  }
  let pixels: Uint8Array;
  if (pipelinedResult) {
    // The PBO path already filled one contiguous target-sized array. Returning
    // it directly avoids allocating and copying another 64 MiB for every color
    // and quality pass (28 duplicate 4K buffers in a 14-layer merge).
    pixels = pipelinedResult.pixels;
    maximumStripeMs = pipelinedResult.maximumStripeMs;
  } else {
    pixels = acquireGpuReadbackPixels(resolution * resolution * 4);
    for (let y = 0; y < resolution; y += rowsPerStripe) {
      if (y > 0) {
        await new Promise<void>((resolve) =>
          window.requestAnimationFrame(() => window.setTimeout(resolve, 0)),
        );
      }
      const rowCount = Math.min(rowsPerStripe, resolution - y);
      const stripe = new Uint8Array(resolution * rowCount * 4);
      const stripeStartedAt = performance.now();
      await renderer.readRenderTargetPixelsAsync(target, 0, y, resolution, rowCount, stripe);
      maximumStripeMs = Math.max(maximumStripeMs, performance.now() - stripeStartedAt);
      pixels.set(stripe, y * resolution * 4);
    }
  }
  if (typeof document !== 'undefined') {
    document.body.dataset.uvBakeReadbackStripeRows = String(rowsPerStripe);
    document.body.dataset.uvBakeReadbackStripeCount = String(Math.ceil(resolution / rowsPerStripe));
    document.body.dataset.uvBakeReadbackMaximumStripeMs = maximumStripeMs.toFixed(1);
    document.body.dataset.uvBakeReadbackTotalMs = (performance.now() - startedAt).toFixed(1);
  }
  return pixels;
}

async function readRenderTargetToImageData(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
  resolution: number,
  outputAlpha: 'opaque-viewport' | 'transparent' = 'opaque-viewport',
) {
  const pixels = await readRenderTargetPixelsInStripes(renderer, target, resolution);
  return convertFinalGpuReadbackInWorker(pixels, resolution, outputAlpha);
}

async function readRenderTargetToLayerImageData(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
  resolution: number,
) {
  const pixels = await readRenderTargetPixelsInStripes(renderer, target, resolution);
  return convertLayerGpuReadbackInWorker(pixels, resolution);
}

async function readRenderTargetAlphaToFloat(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
  resolution: number,
) {
  const pixels = await readRenderTargetPixelsInStripes(renderer, target, resolution);
  // Alpha extraction and Y-flip touch every 4K texel. Keep that exact byte
  // conversion off the UI thread; the RGBA buffer is transferred, not copied.
  return convertQualityGpuReadbackInWorker(pixels, resolution);
}

type RendererStateSnapshot = {
  target: THREE.WebGLRenderTarget | null;
  clearColor: THREE.Color;
  clearAlpha: number;
  viewport: THREE.Vector4;
  scissor: THREE.Vector4;
  scissorTest: boolean;
  autoClear: boolean;
  xrEnabled: boolean;
  pixelRatio: number;
};

let isolatedUvBakeRenderer: THREE.WebGLRenderer | undefined;
let isolatedUvBakeRendererUnavailable = false;

/**
 * Keeps the mandatory DPR=1 UV raster pipeline off the visible viewport
 * renderer. WebGLRenderer.setPixelRatio() resizes and clears its canvas even
 * when all subsequent drawing targets a WebGLRenderTarget; doing that on the
 * React Three Fiber renderer produces a visible flash. Geometry and source
 * pixels remain identical, while the detached renderer owns only bake GPU
 * resources and can be reused by every serialized full-resolution task.
 */
export function getIsolatedUvBakeRenderer(viewportRenderer: THREE.WebGLRenderer) {
  if (!isolatedUvBakeRenderer && !isolatedUvBakeRendererUnavailable) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      isolatedUvBakeRenderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
      });
      isolatedUvBakeRenderer.setPixelRatio(1);
    } catch (error) {
      isolatedUvBakeRendererUnavailable = true;
      console.warn(
        '[Liclick 3D Texture] Isolated UV bake renderer unavailable; using the viewport renderer.',
        error,
      );
    }
  }
  const renderer = isolatedUvBakeRenderer ?? viewportRenderer;
  renderer.outputColorSpace = viewportRenderer.outputColorSpace;
  renderer.toneMapping = viewportRenderer.toneMapping;
  renderer.toneMappingExposure = viewportRenderer.toneMappingExposure;
  renderer.sortObjects = viewportRenderer.sortObjects;
  renderer.localClippingEnabled = viewportRenderer.localClippingEnabled;
  if (typeof document !== 'undefined') {
    document.body.dataset.perfUvBakeRenderer =
      renderer === viewportRenderer ? 'shared-fallback' : 'isolated';
  }
  return renderer;
}

function captureRendererState(renderer: THREE.WebGLRenderer): RendererStateSnapshot {
  return {
    target: renderer.getRenderTarget(),
    clearColor: renderer.getClearColor(new THREE.Color()),
    clearAlpha: renderer.getClearAlpha(),
    viewport: renderer.getViewport(new THREE.Vector4()),
    scissor: renderer.getScissor(new THREE.Vector4()),
    scissorTest: renderer.getScissorTest(),
    autoClear: renderer.autoClear,
    xrEnabled: renderer.xr.enabled,
    pixelRatio: renderer.getPixelRatio(),
  };
}

function restoreRendererState(renderer: THREE.WebGLRenderer, state: RendererStateSnapshot) {
  renderer.setPixelRatio(state.pixelRatio);
  renderer.setRenderTarget(state.target);
  renderer.setClearColor(state.clearColor, state.clearAlpha);
  renderer.setViewport(state.viewport);
  renderer.setScissor(state.scissor);
  renderer.setScissorTest(state.scissorTest);
  renderer.autoClear = state.autoClear;
  renderer.xr.enabled = state.xrEnabled;
}

function setBakeRenderTargetState(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
  resolution: number,
) {
  renderer.xr.enabled = false;
  renderer.setPixelRatio(1);
  renderer.autoClear = false;
  renderer.setRenderTarget(target);
  renderer.setViewport(0, 0, resolution, resolution);
  renderer.setScissorTest(false);
}

function markGpuUvBakeStep(step: string) {
  if (
    typeof document !== 'undefined' &&
    document.body.dataset.perfSimulatedViewportInteraction === '1'
  ) {
    document.body.dataset.perfUvBakePhase = step;
  }
}

function isGpuUvBakeInteractionProtected() {
  return (
    isViewportInteractionBusy() ||
    (typeof document !== 'undefined' &&
      document.body.dataset.perfSimulatedViewportInteraction === '1')
  );
}

async function renderUvBakePass(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  resolution: number,
  maximumTileSize = 768,
) {
  const usesDetachedRenderer = !renderer.domElement.isConnected;
  if (!isGpuUvBakeInteractionProtected() || resolution <= 2048 || !usesDetachedRenderer) {
    renderer.render(scene, camera);
    return;
  }

  // Keep the full-resolution viewport transform, but bound fragment work to
  // one bounded scissor tile per presentation opportunity. This produces the same
  // target pixels while preventing a monolithic 4K pass from occupying the
  // physical GPU across several onscreen frames.
  // 768px keeps detached-renderer submissions below the presentation budget
  // without changing target resolution, sampling, or a single output pixel.
  // The larger 1K tile is faster, but repeated cold stress runs can overlap its
  // release with the following underlay composite and cost one presentation
  // interval. Keep the conservative tile because viewport interaction wins
  // over background completion time.
  const tileSize = maximumTileSize;
  renderer.setScissorTest(true);
  const tiles: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (let y = 0; y < resolution; y += tileSize) {
    for (let x = 0; x < resolution; x += tileSize) {
      tiles.push({
        x,
        y,
        width: Math.min(tileSize, resolution - x),
        height: Math.min(tileSize, resolution - y),
      });
    }
  }
  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index];
    renderer.setScissor(tile.x, tile.y, tile.width, tile.height);
    renderer.render(scene, camera);
    const context = renderer.getContext();
    if (context instanceof WebGL2RenderingContext) {
      // A detached context can enqueue tiles faster than the physical GPU can
      // retire them. Merely flushing once per frame allowed that queue to grow
      // until one quality pass stole two presentation intervals. Drain the
      // current tile asynchronously before admitting the next one: no main
      // thread wait, no pixel/quality change, and no cross-frame GPU backlog.
      const fence = context.fenceSync(context.SYNC_GPU_COMMANDS_COMPLETE, 0);
      context.flush();
      if (fence) {
        try {
          await waitForGpuFence(context, fence);
        } finally {
          context.deleteSync(fence);
        }
      }
    } else {
      context.flush();
    }
    if (index + 1 < tiles.length) {
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => window.setTimeout(resolve, 0)),
      );
    }
  }
  renderer.setScissorTest(false);
}

export async function bakeProjectedLayerRastersWithGpu(
  input: GpuLayerStackBakeInput,
): Promise<GpuLayerRastersBakeOutput> {
  const { renderer, resolution } = input;
  if (resolution > renderer.capabilities.maxTextureSize) {
    throw new Error(
      `GPU max texture size is ${renderer.capabilities.maxTextureSize}, requested ${resolution}.`,
    );
  }

  const warnings: string[] = [];
  markGpuUvBakeStep('gpu-setup-collect-meshes');
  const meshes = collectPreparedMeshes(input.group, warnings);
  const totalTrianglesPerLayer = meshes.reduce((sum, mesh) => sum + mesh.triangleCount, 0);
  const totalTriangles = totalTrianglesPerLayer * input.layers.length;
  if (totalTriangles <= 0) throw new Error('No UV triangles were available for GPU baking.');

  markGpuUvBakeStep('gpu-setup-targets');
  const colorTarget = createPostprocessTarget(resolution);
  const qualityTarget = createPostprocessTarget(resolution);
  let previousState = captureRendererState(renderer);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  const sourceSizes: GpuLayerSourceSize[] = [];
  const rasters: GpuLayerRaster[] = [];
  let processedTriangles = 0;
  let coveredPixels = 0;
  let lastProgressAt = 0;
  const reportProgress = (layer: Layer, layerIndex: number, force = false) => {
    if (!input.onProgress) return;
    const now = performance.now();
    if (!force && now - lastProgressAt < 80) return;
    lastProgressAt = now;
    input.onProgress({
      phase: 'rasterizing',
      progress: totalTriangles > 0 ? processedTriangles / totalTriangles : 0,
      layerName: layer.name,
      layerIndex,
      layerCount: input.layers.length,
      processedTriangles,
      totalTriangles,
    });
  };

  try {
    markGpuUvBakeStep('gpu-setup-scene');
    const bakeScene = await createBakeScene(meshes);
    for (const [layerIndex, layer] of input.layers.entries()) {
      markGpuUvBakeStep('gpu-load-layer-textures');
      input.onProgress?.({
        phase: 'loading-assets',
        progress: 0.04 + (layerIndex / input.layers.length) * 0.78,
        layerName: layer.name,
        layerIndex,
        layerCount: input.layers.length,
      });
      const textures = await loadLayerTexturesWithOptions(layer, resolution, {
        inputTextureFlipY: input.inputTextureFlipY ?? true,
      });
      sourceSizes.push(textures.sourceSizes);
      markGpuUvBakeStep('gpu-texture-upload');
      await stageLayerTexturesForGpu(renderer, textures.disposableTextures);

      const coverageMaterial = createLayerMaterial({
        group: input.group,
        layer,
        textures,
        enableBackfaceCulling: input.enableBackfaceCulling,
        compositeMode: 'coverage-alpha',
        projectedImageUvFlipY: input.projectedImageUvFlipY ?? false,
        strictDepthCheck: input.strictDepthCheck,
        maximumDepthError: input.maximumDepthError,
        minimumOutputCoverage: input.minimumOutputCoverage,
      });
      bakeScene.bakeMeshes.forEach((mesh) => {
        mesh.material = coverageMaterial;
      });
      await waitForSharedRendererBakeSlot();
      setBakeRenderTargetState(renderer, colorTarget, resolution);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      reportProgress(layer, layerIndex, true);
      markGpuUvBakeStep('gpu-color-render');
      await renderUvBakePass(renderer, bakeScene.scene, camera, resolution);
      markGpuUvBakeStep('gpu-color-readback');
      const layerRasterPromise = readRenderTargetToLayerImageData(
        renderer,
        colorTarget,
        resolution,
      );
      // Async GPU readback is safe only after React Three Fiber regains its
      // onscreen target and viewport. The PBO already owns the submitted pixels.
      restoreRendererState(renderer, previousState);
      const layerRaster = await layerRasterPromise;
      previousState = captureRendererState(renderer);
      coverageMaterial.dispose();

      const qualityMaterial = createLayerMaterial({
        group: input.group,
        layer,
        textures,
        enableBackfaceCulling: input.enableBackfaceCulling,
        compositeMode: 'quality-alpha',
        projectedImageUvFlipY: input.projectedImageUvFlipY ?? false,
        strictDepthCheck: input.strictDepthCheck,
        maximumDepthError: input.maximumDepthError,
        minimumOutputCoverage: input.minimumOutputCoverage,
      });
      bakeScene.bakeMeshes.forEach((mesh) => {
        mesh.material = qualityMaterial;
      });
      await waitForSharedRendererBakeSlot();
      setBakeRenderTargetState(renderer, qualityTarget, resolution);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      markGpuUvBakeStep('gpu-quality-render');
      await renderUvBakePass(renderer, bakeScene.scene, camera, resolution);
      markGpuUvBakeStep('gpu-quality-readback');
      const qualityPromise = readRenderTargetAlphaToFloat(renderer, qualityTarget, resolution);
      restoreRendererState(renderer, previousState);
      const quality = await qualityPromise;
      previousState = captureRendererState(renderer);
      qualityMaterial.dispose();

      disposeLayerTextures(textures.disposableTextures);
      const raster: GpuLayerRaster = {
        layer,
        imageData: layerRaster.imageData,
        quality,
        coveredPixels: layerRaster.coveredPixels,
      };
      coveredPixels += layerRaster.coveredPixels;
      if (input.onRaster) {
        await input.onRaster(raster);
      } else {
        rasters.push(raster);
      }
      processedTriangles += totalTrianglesPerLayer;
      reportProgress(layer, layerIndex, true);
      // React Three Fiber owns this renderer. Never yield to its animation frame
      // while the shared renderer still points at the square UV bake target.
      restoreRendererState(renderer, previousState);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      previousState = captureRendererState(renderer);
    }
    bakeScene.scene.clear();

    warnings.push(
      'GPU per-layer UV bake used CPU parity compositing; CPU raster fallback remains available for diagnostics.',
    );
    return {
      rasters,
      sourceSizes,
      totalTriangles,
      processedTriangles,
      coveredPixels,
      skippedPixels: resolution * resolution * input.layers.length - coveredPixels,
      warnings,
    };
  } finally {
    restoreRendererState(renderer, previousState);
    colorTarget.dispose();
    qualityTarget.dispose();
  }
}

export async function bakeProjectedLayerStackWithGpu(
  input: GpuLayerStackBakeInput,
): Promise<GpuLayerStackBakeOutput> {
  const { renderer, resolution } = input;
  if (resolution > renderer.capabilities.maxTextureSize) {
    throw new Error(
      `GPU max texture size is ${renderer.capabilities.maxTextureSize}, requested ${resolution}.`,
    );
  }

  const warnings: string[] = [];
  const meshes = collectPreparedMeshes(input.group, warnings);
  const totalTrianglesPerLayer = meshes.reduce((sum, mesh) => sum + mesh.triangleCount, 0);
  const totalTriangles = totalTrianglesPerLayer * input.layers.length;
  if (totalTriangles <= 0) throw new Error('No UV triangles were available for GPU baking.');

  const renderTarget = new THREE.WebGLRenderTarget(resolution, resolution, {
    depthBuffer: input.compositeMode === 'quality-depth',
    stencilBuffer: false,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });
  renderTarget.texture.colorSpace = THREE.NoColorSpace;
  let uvTopologyTarget: THREE.WebGLRenderTarget | undefined;
  let uvSeamGeometry: THREE.BufferGeometry | undefined;

  let previousState = captureRendererState(renderer);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  let processedTriangles = 0;
  let lastProgressAt = 0;
  const sourceSizes: GpuLayerSourceSize[] = [];
  const reportProgress = (layer: Layer, layerIndex: number, force = false) => {
    if (!input.onProgress) return;
    const now = performance.now();
    if (!force && now - lastProgressAt < 80) return;
    lastProgressAt = now;
    input.onProgress({
      phase: 'rasterizing',
      progress: totalTriangles > 0 ? processedTriangles / totalTriangles : 0,
      layerName: layer.name,
      layerIndex,
      layerCount: input.layers.length,
      processedTriangles,
      totalTriangles,
    });
  };

  try {
    const bakeScene = await createBakeScene(meshes);
    let renderTargetInitialized = false;
    for (const [layerIndex, layer] of input.layers.entries()) {
      input.onProgress?.({
        phase: 'loading-assets',
        progress: 0.04 + (layerIndex / input.layers.length) * 0.78,
        layerName: layer.name,
        layerIndex,
        layerCount: input.layers.length,
      });
      const textures = await loadLayerTexturesWithOptions(layer, resolution, {
        inputTextureFlipY: input.inputTextureFlipY ?? true,
      });
      sourceSizes.push(textures.sourceSizes);
      await stageLayerTexturesForGpu(renderer, textures.disposableTextures);
      const material = createLayerMaterial({
        group: input.group,
        layer,
        textures,
        enableBackfaceCulling: input.enableBackfaceCulling,
        compositeMode: input.compositeMode ?? 'quality-depth',
        projectedImageUvFlipY: input.projectedImageUvFlipY ?? false,
        strictDepthCheck: input.strictDepthCheck,
        maximumDepthError: input.maximumDepthError,
        minimumOutputCoverage: input.minimumOutputCoverage,
      });
      bakeScene.bakeMeshes.forEach((mesh) => {
        mesh.material = material;
      });
      reportProgress(layer, layerIndex, true);
      // Never leave the shared viewport renderer bound to the 4K bake target
      // across asset loads, striped uploads, rAF yields or progress callbacks.
      // Those awaits let React Three Fiber render a visible frame.
      setBakeRenderTargetState(renderer, renderTarget, resolution);
      if (!renderTargetInitialized) {
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderTargetInitialized = true;
      }
      renderer.render(bakeScene.scene, camera);
      processedTriangles += totalTrianglesPerLayer;
      reportProgress(layer, layerIndex, true);
      material.dispose();
      disposeLayerTextures(textures.disposableTextures);
      // The editor render loop can run at this await. Restore the onscreen target
      // and viewport first so UV baking can never leak into the main viewport.
      restoreRendererState(renderer, previousState);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      previousState = captureRendererState(renderer);
    }
    if (input.enableDilation && input.constrainDilationToInteriorHoles) {
      uvTopologyTarget = createTopologyTarget(resolution);
      const topologyMaterial = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader: uvTopologyFragmentShader,
        blending: THREE.NoBlending,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
      });
      bakeScene.bakeMeshes.forEach((mesh) => {
        mesh.material = topologyMaterial;
      });
      setBakeRenderTargetState(renderer, uvTopologyTarget, resolution);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(bakeScene.scene, camera);
      topologyMaterial.dispose();
    }
    bakeScene.scene.clear();

    input.onProgress?.({
      phase: 'compositing',
      progress: 0.88,
      layerIndex: input.layers.length - 1,
      layerCount: input.layers.length,
    });
    const outputAlpha = input.outputAlpha ?? 'opaque-viewport';
    if (input.repairMissingUvSeams) {
      const seamRepair = createUvSeamRepairGeometry(
        input.group,
        resolution,
        input.uvSeamRepairPixels ?? Math.ceil(resolution / 256),
      );
      uvSeamGeometry = seamRepair?.geometry;
      if (seamRepair) {
        warnings.push(`GPU UV seam repair mapped ${seamRepair.seamPairs} geometric seam pairs.`);
      }
    }
    const postprocess = runGpuPostprocess({
      renderer,
      source: renderTarget,
      uvTopologySource: uvTopologyTarget,
      uvSeamGeometry,
      resolution,
      enableDilation: input.enableDilation,
      dilationPixels: input.dilationPixels,
      enableSharpen: outputAlpha !== 'transparent',
      constrainDilationToInteriorHoles: input.constrainDilationToInteriorHoles,
    });
    const readbackPromise = readRenderTargetToImageData(
      renderer,
      postprocess.target,
      resolution,
      outputAlpha,
    );
    restoreRendererState(renderer, previousState);
    const { imageData, coverage, coveredPixels: finalCoveredPixels } = await readbackPromise;
    previousState = captureRendererState(renderer);
    postprocess.ownedTargets.forEach((target) => target.dispose());

    const canvas = document.createElement('canvas');
    canvas.width = resolution;
    canvas.height = resolution;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not create GPU UV bake canvas.');
    context.putImageData(imageData, 0, 0);

    warnings.push(
      'GPU bake does not expose per-rejection texel counters yet; fallback CPU remains available for diagnostics.',
    );

    return {
      canvas,
      coverage,
      sourceSizes,
      postProcessedOnGpu: true,
      opaqueBaseColorReady: outputAlpha === 'opaque-viewport',
      totalTriangles,
      processedTriangles,
      coveredPixels: finalCoveredPixels,
      skippedPixels: resolution * resolution - finalCoveredPixels,
      inFrustumPixels: finalCoveredPixels,
      maskRejectedPixels: 0,
      depthRejectedPixels: 0,
      backfaceRejectedPixels: 0,
      warnings,
    };
  } finally {
    restoreRendererState(renderer, previousState);
    uvSeamGeometry?.dispose();
    uvTopologyTarget?.dispose();
    renderTarget.dispose();
  }
}
