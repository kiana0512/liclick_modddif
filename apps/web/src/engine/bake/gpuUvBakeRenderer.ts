import { RELIABLE_PROJECTION_GLSL } from '../projection/projectionCoverageContract.mjs';
import { readRenderTargetPixelsInStripes } from './gpuReadbackStripes';
import { QualityAlphaReadback } from './qualityAlphaReadback';
import { projectionAttributeRevision } from './projectionBakeSignature';
import { ResidentQualityComposite } from './residentQualityComposite';
import { createSingleItemLookahead } from './singleItemLookahead';
import { isLiveProjectedCanvasUrl } from '../projection/liveProjectedCanvasTextureRegistry';
import type { QualityBlendWorkerResult } from './qualityBlendWorker';
import { getProjectedLayerOverlayMode } from './projectedOverlayComposition';
import * as THREE from 'three';
import { loadImageData } from './imageSampler';
import { collectUvSeamPairs, type UvSeamEdgeRecord } from './uvSeamReconciliation';
import type { BakeProgress, GpuUvCompositeMode, UvBakeResolution } from './uvBakeTypes';
import { buildProjectionMatrixBundle } from '@/engine/projection/projectionMath';
import type { Layer } from '@/types/layer';
import { isViewportInteractionBusy } from '@/engine/viewport/viewportInteractionState';
import { waitForBrowserPaint } from '@/utils/browserScheduling';
import {
  residentPreviewTextureCache,
  retainPreviewTexture,
  uploadPreviewTextureInStripes,
} from '@/engine/viewport/previewTextureCache';
import { yieldToBrowserTask } from '@/utils/browserScheduling';
import {
  convertFinalGpuReadbackInWorker,
  convertLayerGpuReadbackInWorker,
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
const SURFACE_LOCKED_FACING_START = 0.015;
const SURFACE_LOCKED_FACING_END = 0.06;
const SURFACE_LOCKED_MIN_SAFE_FACING = 0.25;
const SURFACE_LOCKED_VISIBILITY_FEATHER = 0.05;
const gpuUvSeamPairCache = new WeakMap<THREE.Object3D, ReturnType<typeof collectUvSeamPairs>>();

type GpuLayerStackBakeInput = {
  region?: import('./incrementalUvComposite').UvBakeRegion;
  allowWhileInteracting?: boolean;
  rasterCache?: import('./ProjectedUvRasterCache').ProjectedUvRasterCache;
  residentQuality?: { preserveAlpha: boolean; retainRasters: boolean };
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
  /** Keep straight RGBA in memory without uploading it to a compatibility canvas. */
  skipCanvasUpload?: boolean;
  onProgress?: (progress: BakeProgress) => void;
};

export type GpuLayerStackBakeOutput = {
  canvas: HTMLCanvasElement;
  imageData: ImageData;
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
  coverage: Uint8Array;
  quality: Float32Array;
  coveredPixels: number;
};

export type GpuLayerRastersBakeOutput = {
  sourcePreparationWaitMs?: number;
  textureUploadMs?: number;
  layerReadbackWaitMs?: number;
  residentQuality?: QualityBlendWorkerResult;
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

// Projection visibility invariants kept outside the emitted GLSL:
// - surface-locked repaint uses depth as authority; flat-normal rejection can
//   expose adjacent triangles as strips;
// - masks preserve continuous feather coverage, matching live projection;
// - grazing depth always receives wider tolerance, while a face-on,
//   center-normal match preserves capture-texel-wide low-poly bevels;
// - surface-locked overlay quality is depth-authoritative rather than driven by
//   normal-angle confidence across one captured surface.
const fragmentShader = `
  ${RELIABLE_PROJECTION_GLSL}

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
  uniform float ignoreSourceAlpha;
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
  #if MRT == 1
    layout(location = 0) out vec4 mrtColor;
    layout(location = 1) out vec4 mrtQuality;
  #endif

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
    #if UV_RASTER_SKIP_NORMAL == 1
      return depthVisibility;
    #else
    vec3 capturedFaceNormal = normalTexel.rgb * 2.0 - 1.0;
    float normalAgreement = dot(projectedFaceNormal, normalize(capturedFaceNormal));
    float normalVisibility = step(0.25, length(capturedFaceNormal)) * smoothstep(
      ${MIN_CAPTURE_NORMAL_AGREEMENT.toFixed(2)},
      ${FULL_CAPTURE_NORMAL_AGREEMENT.toFixed(2)},
      mix(abs(normalAgreement), normalAgreement, surfaceLockedVisibility)
    );
    float normalCheckWeight = useNormalCheck * (1.0 - surfaceLockedVisibility);
    return depthVisibility * mix(1.0, normalVisibility, normalCheckWeight);
    #endif
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

    if (w00 > 0.0 && (ignoreSourceAlpha > 0.5 || c00.a >= threshold)) {
      rgb += c00.rgb * w00;
      totalWeight += w00;
      maxAlpha = max(maxAlpha, c00.a);
    }
    if (w10 > 0.0 && (ignoreSourceAlpha > 0.5 || c10.a >= threshold)) {
      rgb += c10.rgb * w10;
      totalWeight += w10;
      maxAlpha = max(maxAlpha, c10.a);
    }
    if (w01 > 0.0 && (ignoreSourceAlpha > 0.5 || c01.a >= threshold)) {
      rgb += c01.rgb * w01;
      totalWeight += w01;
      maxAlpha = max(maxAlpha, c01.a);
    }
    if (w11 > 0.0 && (ignoreSourceAlpha > 0.5 || c11.a >= threshold)) {
      rgb += c11.rgb * w11;
      totalWeight += w11;
      maxAlpha = max(maxAlpha, c11.a);
    }

    if (totalWeight <= 0.00001) return vec4(0.0);
    return vec4(rgb / totalWeight, mix(maxAlpha, 1.0, ignoreSourceAlpha));
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
    float faceOnFactor = abs(captureViewVertexNormal.z);
    float projectionFacingFactor = abs(
      dot(captureViewVertexNormal, normalize(-captureViewPosition))
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
    depthTolerance *= grazingDepthScale;
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
    float centerBackedVisibility =
      centerVisibility *
      mix(0.35, 1.0, grazingConfidence) *
      max(useNormalCheck, smoothstep(${MIN_CAPTURE_FACE_ON.toFixed(2)}, ${FULL_CAPTURE_FACE_ON.toFixed(2)}, faceOnFactor));
    float supportedVisibilityCoverage =
      max(neighborhoodVisibility, centerBackedVisibility) *
      smoothstep(${MIN_CAPTURE_FACE_ON.toFixed(2)}, ${FACE_ON_VISIBILITY_FULL.toFixed(2)}, faceOnFactor);
    float grazingVisibilityCoverage =
      smoothstep(0.0, 1.0, visibilitySupport) *
      smoothstep(${MIN_CAPTURE_FACE_ON.toFixed(2)}, ${FACE_ON_VISIBILITY_FULL.toFixed(2)}, faceOnFactor);
    float visibilityCoverage = mix(
      grazingVisibilityCoverage,
      supportedVisibilityCoverage,
      grazingConfidence
    );
    float lockedFacingCoverage = smoothstep(
      ${SURFACE_LOCKED_FACING_START.toFixed(3)},
      ${SURFACE_LOCKED_FACING_END.toFixed(3)},
      projectionFacingFactor
    );
    visibilityCoverage = mix(
      visibilityCoverage,
      smoothstep(
        0.0,
        ${SURFACE_LOCKED_VISIBILITY_FEATHER.toFixed(2)},
        visibilitySupport
      ),
      surfaceLockedVisibility
    );
    angleCoverage = mix(angleCoverage, lockedFacingCoverage, surfaceLockedVisibility);
    if (strictDepthCheck > 0.5 && useDepthCheck > 0.5 && visibilityCoverage < 0.5) discard;
    float depthWeight = mix(0.7, 1.0, visibilityCoverage);
    #if UV_RASTER_QUALITY_ONLY == 1
      vec4 texel = ignoreSourceAlpha > 0.5 ? vec4(0.0, 0.0, 0.0, 1.0)
        : sampleProjectedCleanBilinear(projectedMap, projectedSampleUv);
    #else
      vec4 texel = sampleProjectedCleanBilinear(projectedMap, projectedSampleUv);
      texel.rgb = applyHsvAdjustments(texel.rgb);
    #endif
    float sourceAlpha = mix(texel.a, 1.0, ignoreSourceAlpha) * maskCoverage;
    if (sourceAlpha < 0.01) discard;
    float angleWeight = computeAngleWeight(visibilityBackedNdv, layerStrength);
    float coverageEdge = computeImageEdgeFade(projectedSampleUv, 0.015);
    float continuousCoverage = clamp(layerOpacity * sourceAlpha * reliableProjectionSupport(angleCoverage * visibilityCoverage * projectionFacingCoverage * mix(0.35, 1.0, coverageEdge)), 0.0, 1.0);
    float lockedSafetyCoverage = mix(
      smoothstep(
        ${(SURFACE_LOCKED_MIN_SAFE_FACING - 0.08).toFixed(2)},
        ${(SURFACE_LOCKED_MIN_SAFE_FACING + 0.08).toFixed(2)},
        projectionFacingFactor
      ),
      1.0,
      useDepthCheck
    );
    float lockedCoverage =
      layerOpacity *
      sourceAlpha *
      projectionFacingCoverage *
      lockedSafetyCoverage *
      visibilityCoverage;
    float coverage = mix(continuousCoverage, lockedCoverage, surfaceLockedVisibility);
    if (coverage <= max(0.025, minimumOutputCoverage)) discard;
    float qualityEdge = computeImageEdgeFade(projectedSampleUv, 0.035);
    float quality = coverage * depthWeight * angleWeight * mix(0.3, 1.0, qualityEdge);
    quality = mix(quality, max(quality, coverage), surfaceLockedVisibility);
    float qualityAlpha = clamp(max(quality, coverage * ${QUALITY_FLOOR_FROM_COVERAGE.toFixed(2)}), 0.0, 1.0);
    float writeAlpha = mix(qualityAlpha, coverage, useCoverageAlpha);

    #if MRT == 1
      mrtColor = vec4(texel.rgb, coverage);
      mrtQuality = vec4(1.0, 1.0, 1.0, qualityAlpha);
    #else
      if (useQualityDepth > 0.5) {
        gl_FragDepthEXT = 1.0 - qualityAlpha;
        gl_FragColor = vec4(texel.rgb * coverage, coverage);
        return;
      }
      #if UV_RASTER_QUALITY_ONLY == 1
        gl_FragColor = vec4(writeAlpha);
      #else
        gl_FragColor = vec4(texel.rgb, writeAlpha);
      #endif
    #endif
  }
`;

const fullscreenVertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Render targets contain premultiplied RGB. Preserve the neighbouring alpha
// instead of forcing a solid ring around a feathered transparent overlay.
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

// Never alter the original projection edge: fading creates dark UV contours.
// Only bridge absent original UV raster texels recovered by topology padding;
// transparent texels inside an existing island are brush boundaries, not holes.
const interiorHoleConstraintFragmentShader = `
  uniform sampler2D sourceMap;
  uniform sampler2D originalMap;
  uniform sampler2D uvTopologyBaseMap;
  uniform sampler2D uvTopologyMap;
  varying vec2 vUv;

  void main() {
    vec4 original = texture2D(originalMap, vUv);
    if (original.a > 0.0001) {


      gl_FragColor = original;
      return;
    }

    vec4 expanded = texture2D(sourceMap, vUv);
    float insideOriginalUv = texture2D(uvTopologyBaseMap, vUv).r;
    float insidePaddedUv = texture2D(uvTopologyMap, vUv).r;



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

// Local repaint transfers only missing coverage from a geometrically paired UV
// side; preserve authored texels instead of averaging their colours.
const uvSeamRepairFragmentShader = `
  uniform sampler2D sourceMap;
  varying vec2 vDestinationUv;
  varying vec2 vPairedUv;

  void main() {
    vec4 destination = texture2D(sourceMap, clamp(vDestinationUv, vec2(0.0), vec2(1.0)));
    vec4 paired = texture2D(sourceMap, clamp(vPairedUv, vec2(0.0), vec2(1.0)));



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
  const resident = residentPreviewTextureCache.get(input.url);
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
    const texture = prepareTexture(
      new THREE.Texture(residentImage),
      input.minFilter,
      input.magFilter,
      resident.flipY,
    );
    texture.userData.liclickSharedResidentBitmap = true;
    const release = retainPreviewTexture(input.url);
    texture.addEventListener('dispose', release);
    return texture;
  }
  if (typeof createImageBitmap === 'function') {
    const bitmap = await loadImageData(input.url, input.resolution, input.label, true);
    return prepareTexture(new THREE.Texture(bitmap), input.minFilter, input.magFilter, input.flipY);
  }
  const imageData = await loadImageData(input.url, input.resolution, input.label);
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error(`Could not create texture canvas for ${input.label}.`);
  context.putImageData(imageData, 0, 0);
  return prepareTexture(
    new THREE.CanvasTexture(canvas),
    input.minFilter,
    input.magFilter,
    input.flipY,
  );
}

async function stageLayerTexturesForGpu(
  renderer: THREE.WebGLRenderer,
  textures: Iterable<THREE.Texture>,
  allowWhileInteracting = false,
) {
  let maximumUploadMs = 0;
  const usesVisibleRenderer = renderer.domElement.isConnected;
  let nextYieldAt = performance.now() + 4;
  for (const texture of new Set(textures)) {
    // Uploads already yield in stripes. Do not charge an extra frame for each
    // source (including the 1px neutral); retain a bounded submission budget.
    if (performance.now() >= nextYieldAt) {
      if (usesVisibleRenderer) await waitForBrowserPaint();
      else await yieldToBrowserTask();
      nextYieldAt = performance.now() + 4;
    }
    await waitForSharedRendererBakeSlot();
    const startedAt = performance.now();
    await uploadPreviewTextureInStripes(renderer, texture, { allowWhileInteracting });
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
  const neutralTexture = createNeutralTexture();
  // Decode the four immutable inputs concurrently. The old serial chain made
  // every layer pay image + mask + depth + normal latency back-to-back even
  // though decoding is already isolated in workers and does not touch GL.
  // Filtering, orientation and source bytes are unchanged.
  const loaded = await Promise.allSettled([
    loadLayerTextureFromCpuImageData({
      url: layer.imageUrl,
      resolution,
      label: `${layer.name} image`,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      flipY: options.inputTextureFlipY,
    }),
    layer.maskUrl
      ? loadLayerTextureFromCpuImageData({
          url: layer.maskUrl,
          resolution,
          label: `${layer.name} mask`,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          flipY: options.inputTextureFlipY,
        })
      : Promise.resolve(neutralTexture),
    layer.depthUrl
      ? loadLayerTextureFromCpuImageData({
          url: layer.depthUrl,
          resolution,
          label: `${layer.name} depth`,
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          flipY: options.inputTextureFlipY,
        })
      : Promise.resolve(neutralTexture),
    layer.normalUrl
      ? loadLayerTextureFromCpuImageData({
          url: layer.normalUrl,
          resolution,
          label: `${layer.name} normal`,
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          flipY: options.inputTextureFlipY,
        })
      : Promise.resolve(neutralTexture),
  ]);
  const failure=loaded.find(result=>result.status==='rejected');
  if(failure?.status==='rejected') {
    disposeLayerTextures([neutralTexture,...loaded.flatMap(result=>result.status==='fulfilled'?[result.value]:[])]);
    throw failure.reason;
  }
  const [projectedTexture, maskTexture, depthTexture, normalTexture]=loaded.map(result=>{
    if(result.status==='rejected')throw result.reason;
    return result.value;
  });
  if (layer.maskUrl && layer.depthUrl && layer.normalUrl) neutralTexture.dispose();
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

function createLayerTextureLookahead(input: GpuLayerStackBakeInput) {
  // Mutable paint sources must be sampled at consumption, never ahead of it.
  const enabled = !input.layers.some(layer =>
    [layer.imageUrl, layer.maskUrl, layer.depthUrl, layer.normalUrl].some(
      url => url && isLiveProjectedCanvasUrl(url),
    ),
  );
  return createSingleItemLookahead(
    input.layers.length,
    index => loadLayerTexturesWithOptions(input.layers[index], input.resolution, {
      inputTextureFlipY: input.inputTextureFlipY ?? true,
    }),
    textures => disposeLayerTextures(textures.disposableTextures),
    enabled,
    // Overlap independent decoders. Limit the extra
    // slot to two inputs at <=4K (at most 128 MiB of prepared source pixels).
    // Larger/masked+normal stacks retain one-item lookahead.
    input.resolution <= 4096 && input.layers.every(layer =>
      [layer.imageUrl, layer.maskUrl, layer.depthUrl, layer.normalUrl].filter(Boolean).length <= 2),
  );
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
    if (child.userData.liclickPaintOverlay || child.userData.liclickWireframeOverlay || child.userData.liclickLocalRepaintGpuOverlay) return;
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
  qualityOnly?: boolean;
  mrt?: boolean;
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
  // UV-RASTER-SPECIALIZATION/1: alpha-only private targets do not consume RGB;
  // surface-locked/no-normal inputs give captured-normal agreement zero weight.
  return new THREE.ShaderMaterial({
    name: `LiclickGpuUvBake:${input.layer.id}`,
    glslVersion: input.mrt ? THREE.GLSL3 : undefined,
    vertexShader,
    fragmentShader,
    defines: {
      UV_RASTER_QUALITY_ONLY: input.qualityOnly ? 1 : 0,
      MRT: input.mrt ? 1 : 0,
      UV_RASTER_SKIP_NORMAL: !input.textures.useNormalCheck ||
        input.layer.projectionVisibilityPolicy === 'surface-locked-v1' ? 1 : 0,
    },
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
      ignoreSourceAlpha: { value: input.layer.ignoreSourceAlpha ? 1 : 0 },
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
    // Weight in red must use the original alpha source-over factors (ONE,
    // ONE_MINUS_SRC_ALPHA), not multiply itself by alpha a second time.
    premultipliedAlpha: Boolean(input.qualityOnly),
    transparent: input.compositeMode !== 'quality-depth',
    toneMapped: false,
    side: THREE.DoubleSide,
  });
}

function createLayerMrtTarget(resolution: number) {
  const target = createPostprocessTarget(resolution, THREE.RGBAFormat, 2);
  target.textures[1].format = THREE.RedFormat;
  target.textures[1].colorSpace = THREE.NoColorSpace;
  return target;
}

function createBakeScene(meshes: PreparedMesh[]) {
  const scene = new THREE.Scene();
  const bakeMeshes: THREE.Mesh[] = [];
  for (const mesh of meshes) {
    const bakeMesh = new THREE.Mesh(mesh.source.geometry);
    bakeMesh.matrixAutoUpdate = false;
    bakeMesh.matrix.copy(mesh.source.matrixWorld);
    bakeMesh.matrixWorld.copy(mesh.source.matrixWorld);
    bakeMesh.matrixWorldAutoUpdate = false;
    bakeMesh.frustumCulled = false;
    scene.add(bakeMesh);
    bakeMeshes.push(bakeMesh);
  }
  scene.updateMatrixWorld(true);
  return { scene, bakeMeshes };
}

function createPostprocessTarget(
  resolution: number,
  format: THREE.PixelFormat = THREE.RGBAFormat,
  count = 1,
) {
  const target = new THREE.WebGLRenderTarget(resolution, resolution, {
    count,
    depthBuffer: false,
    stencilBuffer: false,
    format,
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
  if (!isViewportInteractionBusy()) return Promise.resolve();
  // R3F owns this WebGL context. During an active drag, allow its onscreen
  // frame to submit before issuing the next offscreen 4K bake pass.
  return waitForBrowserPaint();
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
  region?: GpuLayerStackBakeInput['region'],
) {
  renderer.xr.enabled = false;
  renderer.setPixelRatio(1);
  renderer.autoClear = false;
  renderer.setRenderTarget(target);
  renderer.setViewport(0, 0, resolution, resolution);
  if (region) renderer.setScissor(region.x, resolution - region.y - region.size, region.size, region.size);
  renderer.setScissorTest(Boolean(region));
}

function copyBakeRegion(renderer: THREE.WebGLRenderer, source: THREE.WebGLRenderTarget,
  target: THREE.WebGLRenderTarget, region: NonNullable<GpuLayerStackBakeInput['region']>) {
  const y = source.height - region.y - region.size;
  const box = new THREE.Box2(new THREE.Vector2(region.x, y), new THREE.Vector2(region.x + region.size, y + region.size));
  renderer.setRenderTarget(target);
  for (let i = 0; i < target.textures.length; i++)
    renderer.copyTextureToTexture(source.textures[i], target.textures[i], box);
}

export async function bakeProjectedLayerRastersWithGpu(
  input: GpuLayerStackBakeInput,
): Promise<GpuLayerRastersBakeOutput> {
  const { renderer } = input;
  const resolution = input.region?.size ?? input.resolution;
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

  const retainRasters = !input.residentQuality || input.residentQuality.retainRasters;
  let residentAccumulateMs = 0;
  let sourcePreparationWaitMs=0,textureUploadMs=0,layerReadbackWaitMs=0;
  const rasterCache = input.rasterCache;
  const fullKeys = input.layers.map(layer => JSON.stringify({ ...layer, visible: true, name: '', order: 0 }));
  const keys = fullKeys.map(key => key + (input.region ? JSON.stringify(input.region) : ''));
  if (rasterCache) {
    const geometry = meshes.map(({ source }) => [source.uuid, source.matrixWorld.elements,
      source.geometry.uuid, ...['position', 'normal', 'uv'].map(name =>
        projectionAttributeRevision(source.geometry.getAttribute(name))),
      projectionAttributeRevision(source.geometry.index), source.geometry.drawRange.start, source.geometry.drawRange.count]);
    rasterCache.prepare(renderer, JSON.stringify([input.resolution, geometry, input.enableBackfaceCulling,
      input.inputTextureFlipY, input.projectedImageUvFlipY, input.strictDepthCheck,
      input.maximumDepthError, input.minimumOutputCoverage]), keys);
  }
  // Mutable brush sources must be sampled again, even when their URL is stable.
  const cacheable = input.layers.map(layer => !getProjectedLayerOverlayMode(layer) &&
    ![layer.imageUrl, layer.maskUrl, layer.depthUrl, layer.normalUrl].some(url => url && isLiveProjectedCanvasUrl(url)));
  const resolvedKey = input.residentQuality && cacheable.every(Boolean)
    ? JSON.stringify([keys, input.residentQuality.preserveAlpha]) : undefined;
  if (rasterCache && resolvedKey && !retainRasters) {
    const resolved = await rasterCache.getResolved(resolvedKey);
    document.body.dataset.residentUvNormalBaseHit = String(Boolean(resolved));
    if (resolved) return resolved;
  }
  let colorTarget: THREE.WebGLRenderTarget | undefined;
  // UV-QUALITY-R8/1: private weights consume one original byte, not four.
  // Odd/legacy readback paths retain their existing RGBA layout.
  const qualityFormat = renderer.capabilities.isWebGL2 && resolution % 2 === 0
    ? THREE.RedFormat : THREE.RGBAFormat;
  let qualityTarget: THREE.WebGLRenderTarget | undefined;
  let mrtTarget: THREE.WebGLRenderTarget | undefined;
  let regionColor: THREE.WebGLRenderTarget | undefined, regionQuality: THREE.WebGLRenderTarget | undefined;
  let regionMrt: THREE.WebGLRenderTarget | undefined;
  const qualityReadback = new QualityAlphaReadback(renderer, resolution);
  const cached = keys.map((key, i) => {
    if (!cacheable[i] || !rasterCache) return;
    const hit = rasterCache.get(key);
    if (hit || !input.region) return hit;
    const full = rasterCache.get(fullKeys[i]);
    if (!full) return;
    const color = full.color.textures.length === 2
      ? createLayerMrtTarget(resolution) : createPostprocessTarget(resolution);
    const quality = full.quality ? createPostprocessTarget(resolution,
      full.qualityTexture.format === THREE.RedFormat ? THREE.RedFormat : THREE.RGBAFormat) : undefined;
    const state = captureRendererState(renderer);
    let retained = false;
    try {
      copyBakeRegion(renderer, full.color, color, input.region);
      if (quality && full.quality) copyBakeRegion(renderer, full.quality, quality, input.region);
      const entry = { color, quality, qualityTexture: quality?.texture ?? color.textures[1], sourceSize: full.sourceSize };
      retained = rasterCache.take(key, entry);
      if (retained) return entry;
    } finally {
      restoreRendererState(renderer, state);
      if (!retained) { color.dispose(); quality?.dispose(); }
    }
  });
  if (rasterCache) {
    document.body.dataset.residentUvRasterHits = String(cached.filter(Boolean).length);
    document.body.dataset.residentUvRasterMisses = String(cached.filter(value => !value).length);
  }
  const resumeKeys = cacheable.every(Boolean) ? keys : [];
  const residentLease = input.residentQuality && rasterCache
    ? rasterCache.leaseResident(renderer, resolution, resumeKeys)
    : undefined;
  const resident = input.residentQuality
    ? residentLease?.composite ?? new ResidentQualityComposite(renderer,resolution)
    : undefined;
  const residentStartIndex = residentLease?.startIndex ?? 0;
  const sources=createLayerTextureLookahead({ ...input, layers: input.layers.filter((_, i) =>
    i >= residentStartIndex && !cached[i]) });
  let activeTextures: THREE.Texture[] = [];
  const activeMaterials: THREE.Material[] = [];
  let previousState = captureRendererState(renderer);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  const sourceSizes: GpuLayerSourceSize[] = residentLease?.sourceSizes ?? [];
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
    const bakeScene = createBakeScene(meshes);
    for (const [layerIndex, layer] of input.layers.entries()) {
      if (layerIndex < residentStartIndex) {
        processedTriangles += totalTrianglesPerLayer;
        reportProgress(layer, layerIndex, true);
        continue;
      }
      const isOverlay=!!getProjectedLayerOverlayMode(layer);
      const retainLayerRaster=retainRasters || isOverlay;
      const hit = cached[layerIndex];
      if (hit) {
        reportProgress(layer, layerIndex, true);
        sourceSizes.push(hit.sourceSize);
        if (resident) {
          const start = performance.now();
          resident.push(hit.color.texture, hit.qualityTexture);
          rasterCache?.recordResidentState(keys.slice(0, layerIndex + 1), sourceSizes);
          residentAccumulateMs += performance.now() - start;
        }
        if (retainLayerRaster) {
          const [raster, quality] = await Promise.all([
            readRenderTargetToLayerImageData(renderer, hit.color, resolution),
            qualityReadback.read(hit.color, hit.qualityTexture),
          ]);
          rasters.push({ layer, imageData: raster.imageData, coverage: raster.coverage, quality, coveredPixels: raster.coveredPixels });
          coveredPixels += raster.coveredPixels;
        }
        processedTriangles += totalTrianglesPerLayer;
        previousState = captureRendererState(renderer);
        continue;
      }
      input.onProgress?.({
        phase: 'loading-assets',
        progress: 0.04 + (layerIndex / input.layers.length) * 0.78,
        layerName: layer.name,
        layerIndex,
        layerCount: input.layers.length,
      });
      const sourceStartedAt=performance.now();
      const textures = await sources.take();
      sourcePreparationWaitMs+=performance.now()-sourceStartedAt;
      activeTextures = textures.disposableTextures;
      sourceSizes.push(textures.sourceSizes);
      const uploadStartedAt=performance.now();
      await stageLayerTexturesForGpu(renderer, textures.disposableTextures, input.allowWhileInteracting);
      textureUploadMs+=performance.now()-uploadStartedAt;

      const useMrt = Boolean(
        resident
        && renderer.capabilities.isWebGL2
        && resolution % 2 === 0
        && !isOverlay
      );
      const materialInput = {
        group: input.group, layer, textures,
        enableBackfaceCulling: input.enableBackfaceCulling,
        projectedImageUvFlipY: input.projectedImageUvFlipY ?? false,
        strictDepthCheck: input.strictDepthCheck,
        maximumDepthError: input.maximumDepthError,
        minimumOutputCoverage: input.minimumOutputCoverage,
      };
      const layerColorTarget = useMrt
        ? (mrtTarget ??= createLayerMrtTarget(resolution))
        : (colorTarget ??= createPostprocessTarget(resolution));
      let layerQualityTexture: THREE.Texture;
      const coverageMaterial = createLayerMaterial({
        ...materialInput, compositeMode: 'coverage-alpha', mrt: useMrt,
      });
      activeMaterials.push(coverageMaterial);
      bakeScene.bakeMeshes.forEach(mesh => { mesh.material = coverageMaterial; });
      await waitForSharedRendererBakeSlot();
      const drawColorTarget = input.region ? useMrt
        ? (regionMrt ??= createLayerMrtTarget(input.resolution))
        : (regionColor ??= createPostprocessTarget(input.resolution)) : layerColorTarget;
      setBakeRenderTargetState(renderer, drawColorTarget, input.resolution, input.region);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      reportProgress(layer, layerIndex, true);
      renderer.render(bakeScene.scene, camera);
      if (input.region) copyBakeRegion(renderer, drawColorTarget, layerColorTarget, input.region);
      const layerRasterPromise = retainLayerRaster
        ? readRenderTargetToLayerImageData(renderer, layerColorTarget, resolution)
        : undefined;
      restoreRendererState(renderer, previousState);

      let qualityPromise: ReturnType<QualityAlphaReadback['read']> | undefined;
      if (useMrt) {
        layerQualityTexture = layerColorTarget.textures[1];
        qualityPromise = retainLayerRaster
          ? qualityReadback.read(layerColorTarget, layerQualityTexture)
          : undefined;
        const accumulatedAt = performance.now();
        resident!.push(layerColorTarget.textures[0], layerQualityTexture);
        rasterCache?.recordResidentState(keys.slice(0, layerIndex + 1), sourceSizes);
        residentAccumulateMs += performance.now() - accumulatedAt;
      } else {
        const qualityTargetValue = (qualityTarget ??= createPostprocessTarget(resolution, qualityFormat));
        const qualityMaterial = createLayerMaterial({
          ...materialInput, compositeMode: 'quality-alpha', qualityOnly: true,
        });
        activeMaterials.push(qualityMaterial);
        bakeScene.bakeMeshes.forEach(mesh => { mesh.material = qualityMaterial; });
        await waitForSharedRendererBakeSlot();
        const drawQualityTarget = input.region
          ? (regionQuality ??= createPostprocessTarget(input.resolution, qualityFormat)) : qualityTargetValue;
        setBakeRenderTargetState(renderer, drawQualityTarget, input.resolution, input.region);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.render(bakeScene.scene, camera);
        if (input.region) copyBakeRegion(renderer, drawQualityTarget, qualityTargetValue, input.region);
        qualityPromise = retainLayerRaster ? qualityReadback.read(qualityTargetValue) : undefined;
        layerQualityTexture = qualityTargetValue.texture;
        restoreRendererState(renderer, previousState);
      }
      // The PBOs own both submitted images now. Convert the two exact byte
      // buffers concurrently while R3F has already regained the viewport.
      const readbackStartedAt=performance.now();
      const [layerRaster, quality] = await Promise.all([layerRasterPromise, qualityPromise]);
      layerReadbackWaitMs+=performance.now()-readbackStartedAt;
      previousState = captureRendererState(renderer);
      for (const material of activeMaterials) {
        if (rasterCache) rasterCache.releaseMaterial(material as THREE.ShaderMaterial);
        else material.dispose();
      }
      activeMaterials.length=0;

      disposeLayerTextures(textures.disposableTextures);
      activeTextures=[];
      if (layerRaster && quality) rasters.push({
        layer,
        imageData: layerRaster.imageData,
        coverage: layerRaster.coverage,
        quality,
        coveredPixels: layerRaster.coveredPixels,
      });
      coveredPixels += layerRaster?.coveredPixels ?? 0;
      if (cacheable[layerIndex] && rasterCache?.take(keys[layerIndex], {
        color: layerColorTarget,
        quality: useMrt ? undefined : qualityTarget,
        qualityTexture: layerQualityTexture,
        sourceSize: textures.sourceSizes,
      })) {
        // Transfer target ownership; later layers must never overwrite cached UVs.
        if (useMrt) mrtTarget = undefined;
        else { colorTarget = undefined; qualityTarget = undefined; }
      }
      processedTriangles += totalTrianglesPerLayer;
      reportProgress(layer, layerIndex, true);
      // React Three Fiber owns this renderer. Never yield to its animation frame
      // while the shared renderer still points at the square UV bake target.
      restoreRendererState(renderer, previousState);
      await yieldToBrowserTask();
      previousState = captureRendererState(renderer);
    }
    bakeScene.scene.clear();

    let residentQuality: QualityBlendWorkerResult | undefined;
    if (resident) {
      const started = performance.now();
      const {output,correctedPixels} = await resident.readCorrected(input.residentQuality!.preserveAlpha);
      const {imageData,coverage,coveredPixels:writtenTexels}=await convertLayerGpuReadbackInWorker(
        new Uint8Array(output.buffer,output.byteOffset,output.byteLength),resolution,true);
      if (!retainRasters) coveredPixels+=await resident.countLayerCoverage();
      const resolveMs=performance.now()-started;
      residentQuality={imageData,coverage,
        renderedColorMask:new Uint8Array(0),writtenTexels,backend:'webgl-resident',
        accumulateMs:residentAccumulateMs,resolveMs,overlayMs:0,totalMs:residentAccumulateMs+resolveMs};
      // Live canvases and overlay passes are mutable even when their serialized
      // layer key is stable, so their aggregate must never become resumable.
      if (rasterCache && resumeKeys.length === keys.length) {
        rasterCache.commitResident(keys, sourceSizes);
      }
      warnings.push(`Resident GPU quality: ${correctedPixels} rounding-boundary texels corrected; ${retainRasters ? 'calibration retains reference rasters' : 'no per-layer readbacks'}.`);
      if (rasterCache) document.body.dataset.residentUvAggregatePrefixLayers = String(residentStartIndex);
    }

    warnings.push(
      'GPU UV uses quantized sampling; CPU raster is diagnostic-only.',
    );
    const result = {
      residentQuality,
      sourcePreparationWaitMs,textureUploadMs,layerReadbackWaitMs,
      rasters,
      sourceSizes,
      totalTriangles,
      processedTriangles,
      coveredPixels,
      skippedPixels: resolution * resolution * input.layers.length - coveredPixels,
      warnings,
    };
    if (rasterCache && resolvedKey) await rasterCache.retainResolved(resolvedKey, result);
    return result;
  } finally {
    if (!rasterCache) resident?.dispose();
    activeMaterials.forEach(material=>material.dispose());
    disposeLayerTextures(activeTextures);
    restoreRendererState(renderer, previousState);
    colorTarget?.dispose();
    qualityTarget?.dispose();
    mrtTarget?.dispose();
    regionColor?.dispose(); regionQuality?.dispose(); regionMrt?.dispose();
    qualityReadback.dispose();
    await sources.close();
  }
}

export async function bakeProjectedLayerStackWithGpu(
  input: GpuLayerStackBakeInput,
): Promise<GpuLayerStackBakeOutput> {
  const { renderer } = input;
  const resolution = input.region?.size ?? input.resolution;
  if (input.region && (input.enableDilation || input.repairMissingUvSeams || input.compositeMode !== 'coverage-alpha'))
    throw new Error('Region raster requires canonical full-image postprocessing.');
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

  const renderTarget = new THREE.WebGLRenderTarget(input.resolution, input.resolution, {
    depthBuffer: input.compositeMode === 'quality-depth',
    stencilBuffer: false,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });
  renderTarget.texture.colorSpace = THREE.NoColorSpace;
  const regionTarget = input.region ? createPostprocessTarget(resolution) : undefined;
  let uvTopologyTarget: THREE.WebGLRenderTarget | undefined;
  let uvSeamGeometry: THREE.BufferGeometry | undefined;
  const sources=createLayerTextureLookahead(input);
  let activeTextures:THREE.Texture[]=[];
  let activeMaterial:THREE.Material|undefined;

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
    const bakeScene = createBakeScene(meshes);
    let renderTargetInitialized = false;
    for (const [layerIndex, layer] of input.layers.entries()) {
      input.onProgress?.({
        phase: 'loading-assets',
        progress: 0.04 + (layerIndex / input.layers.length) * 0.78,
        layerName: layer.name,
        layerIndex,
        layerCount: input.layers.length,
      });
      const textures = await sources.take();
      activeTextures=textures.disposableTextures;
      sourceSizes.push(textures.sourceSizes);
      await stageLayerTexturesForGpu(renderer, textures.disposableTextures, input.allowWhileInteracting);
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
      activeMaterial=material;
      bakeScene.bakeMeshes.forEach((mesh) => {
        mesh.material = material;
      });
      reportProgress(layer, layerIndex, true);
      // Never leave the shared viewport renderer bound to the 4K bake target
      // across asset loads, striped uploads, rAF yields or progress callbacks.
      // Those awaits let React Three Fiber render a visible frame.
      setBakeRenderTargetState(renderer, renderTarget, input.resolution, input.region);
      if (!renderTargetInitialized) {
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderTargetInitialized = true;
      }
      renderer.render(bakeScene.scene, camera);
      processedTriangles += totalTrianglesPerLayer;
      reportProgress(layer, layerIndex, true);
      if (input.rasterCache) input.rasterCache.releaseMaterial(material);
      else material.dispose();
      activeMaterial=undefined;
      disposeLayerTextures(textures.disposableTextures);
      activeTextures=[];
      // The editor render loop can run at this await. Restore the onscreen target
      // and viewport first so UV baking can never leak into the main viewport.
      restoreRendererState(renderer, previousState);
      await yieldToBrowserTask();
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
    if (regionTarget && input.region) copyBakeRegion(renderer, renderTarget, regionTarget, input.region);
    const postprocess = runGpuPostprocess({
      renderer,
      source: regionTarget ?? renderTarget,
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
    if (!input.skipCanvasUpload) {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Could not create GPU UV bake canvas.');
      context.putImageData(imageData, 0, 0);
    }

    warnings.push(
      'GPU bake does not expose per-rejection texel counters yet; fallback CPU remains available for diagnostics.',
    );

    return {
      canvas,
      imageData,
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
    regionTarget?.dispose();
    activeMaterial?.dispose();disposeLayerTextures(activeTextures);
    await sources.close();
  }
}
