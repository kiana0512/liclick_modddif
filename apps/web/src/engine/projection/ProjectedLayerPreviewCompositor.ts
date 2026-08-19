import * as THREE from 'three';
import { loadProjectedTexture } from './ProjectedLayerMaterial';
import { buildProjectionMatrixBundle } from './projectionMath';
import type { ProjectionLayerStackInput } from './projectionTypes';

// Smaller tiles preserve the exact output resolution while bounding the cost of
// each individual GPU pass on slower devices.
const TILE_SIZE = 512;
const COVERAGE_THRESHOLD = 0.02;
const QUALITY_FLOOR_FROM_COVERAGE = 0.08;
const DEPTH_EPSILON = 0.0025;
const DEPTH_BACKED_ANGLE_COVERAGE_START = 0.02;
const DEPTH_BACKED_ANGLE_COVERAGE_END = 0.38;
const BLEND_POWER = 2.4;
const RESIDUAL_MIX = 0.2;
const DOMINANCE_BLEND_START = 1.45;
const DOMINANCE_BLEND_END = 2.6;
const DOMINANCE_MARGIN_START = 0.05;
const DOMINANCE_MARGIN_END = 0.2;
const MIN_CAPTURE_FACE_ON = 0.01;
const FULL_CAPTURE_FACE_ON = 0.2;
const MAX_GRAZING_DEPTH_SCALE = 5;
const MIN_VISIBILITY_SUPPORT = 1.25;
const MAX_GRAZING_VISIBILITY_SUPPORT = 3.75;
const VISIBILITY_SUPPORT_FEATHER = 1.25;
const FACE_ON_VISIBILITY_FULL = 0.06;
const MIN_CAPTURE_NORMAL_AGREEMENT = 0.72;
const FULL_CAPTURE_NORMAL_AGREEMENT = 0.92;
const SURFACE_LOCKED_FACING_START = 0.015;
const SURFACE_LOCKED_FACING_END = 0.06;
const SURFACE_LOCKED_MIN_SAFE_FACING = 0.25;
const SURFACE_LOCKED_VISIBILITY_THRESHOLD = 0.02;

type PreviewLayer = ProjectionLayerStackInput['layers'][number];

type PreparedLayer = {
  input: PreviewLayer;
  material: THREE.ShaderMaterial;
};

type RendererState = {
  target: THREE.WebGLRenderTarget | null;
  clearColor: THREE.Color;
  clearAlpha: number;
  viewport: THREE.Vector4;
  scissor: THREE.Vector4;
  scissorTest: boolean;
  autoClear: boolean;
  xrEnabled: boolean;
};

export type ProjectedPreviewComposite = {
  signature: string;
  resolution: number;
  colorTexture: THREE.Texture;
  renderedColorMaskTexture: THREE.Texture;
  layerIds: string[];
};

export type ProjectedPreviewCompositeRequest = {
  signature: string;
  renderer: THREE.WebGLRenderer;
  group: THREE.Group;
  layers: PreviewLayer[];
  resolution: number;
  onReady: (result: ProjectedPreviewComposite) => void;
  onError: (error: unknown) => void;
  onProgress?: (progress: ProjectedPreviewCompositeProgress) => void;
};

export type ProjectedPreviewCompositeProgress = {
  signature: string;
  phase: 'loading' | 'compositing';
  progress: number;
  elapsedMs: number;
};

type CompositeJob = {
  revision: number;
  request: ProjectedPreviewCompositeRequest;
  normalLayers: PreparedLayer[];
  underlayLayers: PreparedLayer[];
  overlayLayers: PreparedLayer[];
  bakeScene: THREE.Scene;
  bakeMeshes: THREE.Mesh[];
  camera: THREE.OrthographicCamera;
  candidateTarget: THREE.WebGLRenderTarget;
  rankTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  tileTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  outputTarget: THREE.WebGLRenderTarget;
  hasRenderedColor: boolean;
  rankMaterial: THREE.ShaderMaterial;
  composeMaterial: THREE.ShaderMaterial;
  underlayMaterial: THREE.ShaderMaterial;
  overlayMaterial: THREE.ShaderMaterial;
  fullscreenScene: THREE.Scene;
  fullscreenMesh: THREE.Mesh;
  tileIndex: number;
  layerIndex: number;
  phase: 'begin-tile' | 'rank' | 'compose' | 'underlay' | 'overlay' | 'copy';
  rankReadIndex: 0 | 1;
  tileReadIndex: 0 | 1;
  startedAt: number;
  lastProgressAt: number;
};

const candidateVertexShader = `
  out vec3 vWorldPosition;
  out vec3 vWorldNormal;
  out vec2 vTextureUv;

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

const candidateFragmentShader = `
  precision highp float;
  uniform sampler2D projectedMap;
  uniform sampler2D maskMap;
  uniform sampler2D depthMap;
  uniform sampler2D normalMap;
  uniform mat4 projectorMatrix;
  uniform mat4 objectMatrixDelta;
  uniform mat3 objectNormalDelta;
  uniform mat4 projectorViewMatrix;
  uniform vec3 projectorPosition;
  uniform float layerOpacity;
  uniform float layerStrength;
  uniform float useMask;
  uniform float maskUsesUv;
  uniform float useDepthCheck;
  uniform float useNormalCheck;
  uniform float surfaceLockedVisibility;
  uniform float depthIsLinearView;
  uniform float projectorNear;
  uniform float projectorFar;
  uniform float renderedColor;
  uniform float hueShift;
  uniform float saturationShift;
  uniform float lightnessShift;
  in vec3 vWorldPosition;
  in vec3 vWorldNormal;
  in vec2 vTextureUv;
  layout(location = 0) out vec4 candidateColor;
  layout(location = 1) out vec4 candidateInfo;

  vec3 rgbToHsv(vec3 color) {
    vec4 k = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(color.bg, k.wz), vec4(color.gb, k.xy), step(color.b, color.g));
    vec4 q = mix(vec4(p.xyw, color.r), vec4(color.r, p.yzx), step(p.x, color.r));
    float delta = q.x - min(q.w, q.y);
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * delta + 1.0e-10)), delta / (q.x + 1.0e-10), q.x);
  }

  vec3 liclickLinearToSrgb(vec3 color) {
    return mix(color * 12.92, 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), color));
  }

  vec3 srgbToLinear(vec3 color) {
    return mix(color / 12.92, pow(max((color + 0.055) / 1.055, vec3(0.0)), vec3(2.4)), step(vec3(0.04045), color));
  }

  vec3 hsvToRgb(vec3 hsv) {
    vec3 channels = abs(fract(hsv.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return hsv.z * mix(vec3(1.0), clamp(channels - 1.0, 0.0, 1.0), hsv.y);
  }

  vec3 applyAdjustments(vec3 color) {
    if (abs(hueShift) < 0.0001 && abs(saturationShift) < 0.0001 && abs(lightnessShift) < 0.0001) return color;
    vec3 hsv = rgbToHsv(liclickLinearToSrgb(clamp(color, 0.0, 1.0)));
    hsv.x = mod(hsv.x + hueShift + 1.0, 1.0);
    hsv.y = clamp(hsv.y + saturationShift, 0.0, 1.0);
    hsv.z = clamp(hsv.z + lightnessShift, 0.0, 1.0);
    return srgbToLinear(hsvToRgb(hsv));
  }

  float unpackDepth(vec4 rgbaDepth) {
    return dot(
      rgbaDepth,
      vec4(
        255.0 / 256.0,
        255.0 / 65536.0,
        255.0 / 16777216.0,
        1.0 / 16777216.0
      )
    );
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
    // For local repaint, depth chooses the visible surface. Normal rejection is
    // intentionally disabled because it classifies adjacent thin triangles
    // differently and creates a striped boundary.
    float normalCheckWeight = useNormalCheck * (1.0 - surfaceLockedVisibility);
    return depthVisibility * mix(1.0, normalVisibility, normalCheckWeight);
  }

  float edgeFade(vec2 uv, float edge) {
    float distanceToEdge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    return smoothstep(0.0, edge, distanceToEdge);
  }

  void main() {
    vec4 captureWorldPosition = objectMatrixDelta * vec4(vWorldPosition, 1.0);
    vec3 captureWorldNormal = normalize(objectNormalDelta * vWorldNormal);
    vec4 projected = projectorMatrix * captureWorldPosition;
    if (projected.w <= 0.0001) discard;
    vec3 ndc = projected.xyz / projected.w;
    if (any(greaterThan(abs(ndc), vec3(1.0)))) discard;
    vec2 uv = ndc.xy * 0.5 + 0.5;
    uv.y = 1.0 - uv.y;
    vec2 maskUv = mix(uv, vec2(vTextureUv.x, 1.0 - vTextureUv.y), maskUsesUv);
    vec4 maskTexel = texture(maskMap, maskUv);
    float maskValue = dot(maskTexel.rgb, vec3(0.299, 0.587, 0.114)) * maskTexel.a;
    float maskAlpha = mix(1.0, maskValue, useMask);
    vec4 texel = texture(projectedMap, uv);
    texel.rgb = applyAdjustments(texel.rgb);
    float sourceAlpha = texel.a * maskAlpha;
    if (sourceAlpha < 0.01) discard;
    vec3 viewDirection = normalize(projectorPosition - captureWorldPosition.xyz);
    float ndv = dot(captureWorldNormal, viewDirection);
    if (useDepthCheck < 0.5 && ndv < -0.35) discard;
    float visibilityBackedNdv = mix(ndv, abs(ndv), useDepthCheck);
    float angleCoverage = mix(
      smoothstep(-0.62, -0.18, ndv),
      smoothstep(${DEPTH_BACKED_ANGLE_COVERAGE_START.toFixed(2)}, ${DEPTH_BACKED_ANGLE_COVERAGE_END.toFixed(2)}, visibilityBackedNdv),
      useDepthCheck
    );
    float projectedDepth = ndc.z * 0.5 + 0.5;
    float projectedViewDepth = -(projectorViewMatrix * captureWorldPosition).z;
    float projectedMetric = mix(projectedDepth, projectedViewDepth, depthIsLinearView);
    float depthTolerance = mix(
      ${DEPTH_EPSILON.toFixed(4)},
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
    vec2 visibilityTextureSize = mix(
      vec2(textureSize(depthMap, 0)),
      vec2(textureSize(normalMap, 0)),
      useNormalCheck
    );
    vec2 visibilityTexelSize = 1.0 / max(visibilityTextureSize, vec2(1.0));
    float faceOnFactor = abs(projectedFaceNormal.z);
    float grazingDepthScale = mix(
      ${MAX_GRAZING_DEPTH_SCALE.toFixed(1)},
      1.0,
      smoothstep(${MIN_CAPTURE_FACE_ON.toFixed(2)}, ${FULL_CAPTURE_FACE_ON.toFixed(2)}, faceOnFactor)
    );
    depthTolerance *= mix(1.0, grazingDepthScale, useNormalCheck);
    float centerVisibility = computeVisibilitySample(
      texture(depthMap, uv), texture(normalMap, uv),
      projectedMetric, depthTolerance, projectedFaceNormal
    );
    float visibilitySupport = centerVisibility;
    visibilitySupport += computeVisibilitySample(
      texture(depthMap, uv + vec2(visibilityTexelSize.x, 0.0)),
      texture(normalMap, uv + vec2(visibilityTexelSize.x, 0.0)),
      projectedMetric, depthTolerance, projectedFaceNormal
    );
    visibilitySupport += computeVisibilitySample(
      texture(depthMap, uv - vec2(visibilityTexelSize.x, 0.0)),
      texture(normalMap, uv - vec2(visibilityTexelSize.x, 0.0)),
      projectedMetric, depthTolerance, projectedFaceNormal
    );
    visibilitySupport += computeVisibilitySample(
      texture(depthMap, uv + vec2(0.0, visibilityTexelSize.y)),
      texture(normalMap, uv + vec2(0.0, visibilityTexelSize.y)),
      projectedMetric, depthTolerance, projectedFaceNormal
    );
    visibilitySupport += computeVisibilitySample(
      texture(depthMap, uv - vec2(0.0, visibilityTexelSize.y)),
      texture(normalMap, uv - vec2(0.0, visibilityTexelSize.y)),
      projectedMetric, depthTolerance, projectedFaceNormal
    );
    visibilitySupport += computeVisibilitySample(
      texture(depthMap, uv + visibilityTexelSize),
      texture(normalMap, uv + visibilityTexelSize),
      projectedMetric, depthTolerance, projectedFaceNormal
    );
    visibilitySupport += computeVisibilitySample(
      texture(depthMap, uv - visibilityTexelSize),
      texture(normalMap, uv - visibilityTexelSize),
      projectedMetric, depthTolerance, projectedFaceNormal
    );
    visibilitySupport += computeVisibilitySample(
      texture(depthMap, uv + vec2(visibilityTexelSize.x, -visibilityTexelSize.y)),
      texture(normalMap, uv + vec2(visibilityTexelSize.x, -visibilityTexelSize.y)),
      projectedMetric, depthTolerance, projectedFaceNormal
    );
    visibilitySupport += computeVisibilitySample(
      texture(depthMap, uv + vec2(-visibilityTexelSize.x, visibilityTexelSize.y)),
      texture(normalMap, uv + vec2(-visibilityTexelSize.x, visibilityTexelSize.y)),
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
    float visibilityCoverage =
      max(neighborhoodVisibility, centerBackedVisibility) *
      smoothstep(${MIN_CAPTURE_FACE_ON.toFixed(2)}, ${FACE_ON_VISIBILITY_FULL.toFixed(2)}, faceOnFactor);
    float projectionFacingFactor = abs(dot(projectedFaceNormal, normalize(-captureViewPosition)));
    float lockedFacingCoverage = smoothstep(
      ${SURFACE_LOCKED_FACING_START.toFixed(3)},
      ${SURFACE_LOCKED_FACING_END.toFixed(3)},
      projectionFacingFactor
    );
    float lockedVisibilityCoverage = step(0.001, visibilitySupport);
    visibilityCoverage = mix(
      visibilityCoverage,
      lockedVisibilityCoverage,
      surfaceLockedVisibility
    );
    angleCoverage = mix(angleCoverage, lockedFacingCoverage, surfaceLockedVisibility);
    float depthWeight = mix(0.7, 1.0, visibilityCoverage);
    float continuousCoverage = clamp(layerOpacity * sourceAlpha * angleCoverage * visibilityCoverage * mix(0.35, 1.0, edgeFade(uv, 0.015)), 0.0, 1.0);
    float lockedSurfaceFacing = abs(dot(captureViewVertexNormal, normalize(-captureViewPosition)));
    // Depth already identifies the front-most captured surface. Do not combine
    // it with a per-triangle normal cutoff: when the resident preview takes
    // over, scanned/dense meshes otherwise turn into alternating paint strips.
    // The angle cutoff remains a safe fallback for legacy captures without depth.
    float lockedSafetyCoverage = mix(
      step(${SURFACE_LOCKED_MIN_SAFE_FACING.toFixed(2)}, lockedSurfaceFacing),
      1.0,
      useDepthCheck
    );
    // Keep the depth/surface decision binary without binarizing the authored
    // mask itself; local-repaint feather is carried by sourceAlpha.
    float lockedCoverage =
      layerOpacity *
      sourceAlpha *
      lockedSafetyCoverage *
      step(${SURFACE_LOCKED_VISIBILITY_THRESHOLD.toFixed(2)}, visibilityCoverage);
    float coverage = mix(continuousCoverage, lockedCoverage, surfaceLockedVisibility);
    if (coverage <= ${COVERAGE_THRESHOLD.toFixed(2)}) discard;
    float strength = clamp(layerStrength, 0.25, 3.0);
    float angleWeight = smoothstep(0.02, 0.25, visibilityBackedNdv) * pow(clamp(visibilityBackedNdv, 0.0, 1.0), 4.0 / strength);
    float quality = coverage * depthWeight * angleWeight * mix(0.3, 1.0, edgeFade(uv, 0.035));
    float score = max(quality, coverage * ${QUALITY_FLOOR_FROM_COVERAGE.toFixed(2)});
    candidateColor = vec4(texel.rgb, score);
    candidateInfo = vec4(coverage, renderedColor, 0.0, 1.0);
  }
`;

const fullscreenVertexShader = `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const rankFragmentShader = `
  precision highp float;
  uniform sampler2D rank0Map;
  uniform sampler2D rank1Map;
  uniform sampler2D rank2Map;
  uniform sampler2D rankInfoMap;
  uniform sampler2D candidateMap;
  uniform sampler2D candidateInfoMap;
  uniform vec2 tileUvScale;
  in vec2 vUv;
  layout(location = 0) out vec4 nextRank0;
  layout(location = 1) out vec4 nextRank1;
  layout(location = 2) out vec4 nextRank2;
  layout(location = 3) out vec4 nextRankInfo;

  void main() {
    vec2 uv = vUv * tileUvScale;
    vec4 r0 = texture(rank0Map, uv);
    vec4 r1 = texture(rank1Map, uv);
    vec4 r2 = texture(rank2Map, uv);
    vec4 info = texture(rankInfoMap, uv);
    vec4 candidate = texture(candidateMap, uv);
    vec2 candidateInfo = texture(candidateInfoMap, uv).rg;
    float flags = floor(info.a * 7.0 + 0.5);
    float f0 = mod(flags, 2.0);
    float f1 = mod(floor(flags / 2.0), 2.0);
    float f2 = mod(floor(flags / 4.0), 2.0);
    float cf = step(0.5, candidateInfo.y);
    if (candidate.a > r0.a) {
      nextRank0 = candidate;
      nextRank1 = r0;
      nextRank2 = r1;
      nextRankInfo = vec4(candidateInfo.x, info.r, info.g, (cf + 2.0 * f0 + 4.0 * f1) / 7.0);
    } else if (candidate.a > r1.a) {
      nextRank0 = r0;
      nextRank1 = candidate;
      nextRank2 = r1;
      nextRankInfo = vec4(info.r, candidateInfo.x, info.g, (f0 + 2.0 * cf + 4.0 * f1) / 7.0);
    } else if (candidate.a > r2.a) {
      nextRank0 = r0;
      nextRank1 = r1;
      nextRank2 = candidate;
      nextRankInfo = vec4(info.r, info.g, candidateInfo.x, (f0 + 2.0 * f1 + 4.0 * cf) / 7.0);
    } else {
      nextRank0 = r0;
      nextRank1 = r1;
      nextRank2 = r2;
      nextRankInfo = info;
    }
  }
`;

const composeFragmentShader = `
  precision highp float;
  uniform sampler2D rank0Map;
  uniform sampler2D rank1Map;
  uniform sampler2D rank2Map;
  uniform sampler2D rankInfoMap;
  uniform vec2 tileUvScale;
  in vec2 vUv;
  layout(location = 0) out vec4 composedColor;
  layout(location = 1) out vec4 composedRenderedMask;

  vec3 liclickLinearToSrgb(vec3 color) {
    return mix(color * 12.92, 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), color));
  }

  void main() {
    vec2 uv = vUv * tileUvScale;
    vec4 r0 = texture(rank0Map, uv);
    vec4 r1 = texture(rank1Map, uv);
    vec4 r2 = texture(rank2Map, uv);
    vec4 info = texture(rankInfoMap, uv);
    float flags = floor(info.a * 7.0 + 0.5);
    vec3 rendered = vec3(mod(flags, 2.0), mod(floor(flags / 2.0), 2.0), mod(floor(flags / 4.0), 2.0));
    float count = step(${COVERAGE_THRESHOLD.toFixed(2)}, info.r) + step(${COVERAGE_THRESHOLD.toFixed(2)}, info.g) + step(${COVERAGE_THRESHOLD.toFixed(2)}, info.b);
    if (count < 0.5) {
      composedColor = vec4(0.0);
      composedRenderedMask = vec4(0.0);
      return;
    }
    vec3 color;
    float renderedMix;
    if (count < 1.5) {
      color = r0.rgb;
      renderedMix = rendered.x;
    } else {
      vec3 strong = pow(max(vec3(r0.a, r1.a, r2.a), vec3(0.0)), vec3(${BLEND_POWER.toFixed(1)}));
      float strongSum = max(dot(strong, vec3(1.0)), 0.000001);
      float softSum = max(info.r + info.g + info.b, 0.000001);
      vec3 weights = mix(strong / strongSum, info.rgb / softSum, ${RESIDUAL_MIX.toFixed(2)});
      vec3 blendedColor = r0.rgb * weights.x + r1.rgb * weights.y + r2.rgb * weights.z;
      float blendedRendered = dot(rendered, weights);
      float qualityRatio = r0.a / max(r1.a, 0.000001);
      float dominance =
        smoothstep(${DOMINANCE_BLEND_START.toFixed(2)}, ${DOMINANCE_BLEND_END.toFixed(2)}, qualityRatio) *
        smoothstep(${DOMINANCE_MARGIN_START.toFixed(2)}, ${DOMINANCE_MARGIN_END.toFixed(2)}, r0.a - r1.a);
      color = mix(blendedColor, r0.rgb, dominance);
      renderedMix = mix(blendedRendered, rendered.x, dominance);
    }
    composedColor = vec4(liclickLinearToSrgb(clamp(color, 0.0, 1.0)), 1.0);
    composedRenderedMask = vec4(renderedMix, 0.0, 0.0, 1.0);
  }
`;

const overlayFragmentShader = `
  precision highp float;
  uniform sampler2D baseMap;
  uniform sampler2D baseRenderedMaskMap;
  uniform sampler2D candidateMap;
  uniform sampler2D candidateInfoMap;
  uniform vec2 tileUvScale;
  in vec2 vUv;
  layout(location = 0) out vec4 composedColor;
  layout(location = 1) out vec4 composedRenderedMask;

  vec3 liclickLinearToSrgb(vec3 color) {
    return mix(color * 12.92, 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), color));
  }

  void main() {
    vec2 uv = vUv * tileUvScale;
    vec4 base = texture(baseMap, uv);
    float baseRendered = texture(baseRenderedMaskMap, uv).r;
    vec4 candidate = texture(candidateMap, uv);
    vec2 candidateInfo = texture(candidateInfoMap, uv).rg;
    float qualityFade = smoothstep(0.0, 0.15, max(candidate.a, candidateInfo.x * 0.25));
    float alpha = clamp(candidateInfo.x * mix(0.75, 1.0, qualityFade), 0.0, 1.0);
    vec3 color = mix(base.rgb, candidate.rgb, alpha);
    composedColor = vec4(liclickLinearToSrgb(clamp(color, 0.0, 1.0)), max(base.a, step(0.0001, alpha)));
    composedRenderedMask = vec4(mix(baseRendered, candidateInfo.y, alpha), 0.0, 0.0, 1.0);
  }
`;

const underlayFragmentShader = `
  precision highp float;
  uniform sampler2D baseMap;
  uniform sampler2D baseRenderedMaskMap;
  uniform sampler2D candidateMap;
  uniform sampler2D candidateInfoMap;
  uniform vec2 tileUvScale;
  in vec2 vUv;
  layout(location = 0) out vec4 composedColor;
  layout(location = 1) out vec4 composedRenderedMask;

  vec3 liclickLinearToSrgb(vec3 color) {
    return mix(color * 12.92, 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), color));
  }

  void main() {
    vec2 uv = vUv * tileUvScale;
    vec4 base = texture(baseMap, uv);
    float baseRendered = texture(baseRenderedMaskMap, uv).r;
    vec4 candidate = texture(candidateMap, uv);
    vec2 candidateInfo = texture(candidateInfoMap, uv).rg;
    float basePresent = step(0.5, base.a);
    float candidatePresent = step(${COVERAGE_THRESHOLD.toFixed(2)}, candidateInfo.x);
    // Existing projections win completely. The repair candidate is used only
    // where normal projection composition produced no texel, and is accepted
    // as an opaque fallback to avoid a dark half-alpha boundary.
    float useCandidate = (1.0 - basePresent) * candidatePresent;
    vec3 color = mix(base.rgb, candidate.rgb, useCandidate);
    composedColor = vec4(liclickLinearToSrgb(clamp(color, 0.0, 1.0)), max(base.a, useCandidate));
    composedRenderedMask = vec4(
      mix(baseRendered, candidateInfo.y, useCandidate),
      0.0,
      0.0,
      1.0
    );
  }
`;

function captureRendererState(renderer: THREE.WebGLRenderer): RendererState {
  return {
    target: renderer.getRenderTarget(),
    clearColor: renderer.getClearColor(new THREE.Color()),
    clearAlpha: renderer.getClearAlpha(),
    viewport: renderer.getViewport(new THREE.Vector4()),
    scissor: renderer.getScissor(new THREE.Vector4()),
    scissorTest: renderer.getScissorTest(),
    autoClear: renderer.autoClear,
    xrEnabled: renderer.xr.enabled,
  };
}

function restoreRendererState(renderer: THREE.WebGLRenderer, state: RendererState) {
  renderer.setRenderTarget(state.target);
  renderer.setClearColor(state.clearColor, state.clearAlpha);
  renderer.setViewport(state.viewport);
  renderer.setScissor(state.scissor);
  renderer.setScissorTest(state.scissorTest);
  renderer.autoClear = state.autoClear;
  renderer.xr.enabled = state.xrEnabled;
}

function createMrt(width: number, height: number, count: number) {
  const target = new THREE.WebGLRenderTarget(width, height, {
    count,
    depthBuffer: false,
    stencilBuffer: false,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
  });
  target.textures.forEach((texture) => {
    texture.colorSpace = THREE.NoColorSpace;
    texture.generateMipmaps = false;
  });
  return target;
}

function createFullscreenMaterial(fragmentShader: string, uniforms: Record<string, unknown>) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: fullscreenVertexShader,
    fragmentShader,
    uniforms: Object.fromEntries(Object.entries(uniforms).map(([key, value]) => [key, { value }])),
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
  });
}

function createObjectMatrixDelta(group: THREE.Group, layer: PreviewLayer) {
  if (!layer.objectMatrixWorld) return new THREE.Matrix4();
  group.updateMatrixWorld(true);
  return new THREE.Matrix4()
    .fromArray(layer.objectMatrixWorld)
    .multiply(group.matrixWorld.clone().invert());
}

async function createCandidateMaterial(group: THREE.Group, layer: PreviewLayer) {
  const neutral = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  neutral.needsUpdate = true;
  const [projectedMap, maskMap, depthMap, normalMap] = await Promise.all([
    loadProjectedTexture(layer.imageUrl),
    layer.useMask && layer.maskUrl
      ? loadProjectedTexture(layer.maskUrl, THREE.NoColorSpace, 'mask')
      : Promise.resolve(neutral),
    layer.useDepthCheck && layer.depthUrl
      ? loadProjectedTexture(layer.depthUrl, THREE.NoColorSpace, 'depth')
      : Promise.resolve(neutral),
    layer.useNormalCheck && layer.normalUrl
      ? loadProjectedTexture(layer.normalUrl, THREE.NoColorSpace, 'normal')
      : Promise.resolve(neutral),
  ]);
  const objectMatrixDelta = createObjectMatrixDelta(group, layer);
  const material = new THREE.ShaderMaterial({
    name: `LiclickProjectedPreviewComposite:${layer.layerId}`,
    glslVersion: THREE.GLSL3,
    vertexShader: candidateVertexShader,
    fragmentShader: candidateFragmentShader,
    uniforms: {
      projectedMap: { value: projectedMap },
      maskMap: { value: maskMap },
      depthMap: { value: depthMap },
      normalMap: { value: normalMap },
      projectorMatrix: { value: buildProjectionMatrixBundle(layer.camera).projectorMatrix },
      objectMatrixDelta: { value: objectMatrixDelta },
      objectNormalDelta: { value: new THREE.Matrix3().getNormalMatrix(objectMatrixDelta) },
      projectorViewMatrix: {
        value: new THREE.Matrix4().fromArray(layer.camera.viewMatrix),
      },
      projectorPosition: { value: new THREE.Vector3().fromArray(layer.camera.position) },
      layerOpacity: { value: layer.visible ? layer.opacity : 0 },
      layerStrength: { value: layer.strength ?? 1 },
      useMask: { value: layer.useMask && layer.maskUrl ? 1 : 0 },
      maskUsesUv: { value: layer.maskSpace === 'uv' ? 1 : 0 },
      useDepthCheck: { value: layer.useDepthCheck && layer.depthUrl ? 1 : 0 },
      useNormalCheck: { value: layer.useNormalCheck && layer.normalUrl ? 1 : 0 },
      surfaceLockedVisibility: {
        value: layer.projectionVisibilityPolicy === 'surface-locked-v1' ? 1 : 0,
      },
      depthIsLinearView: { value: layer.depthIsLinearView ? 1 : 0 },
      projectorNear: { value: layer.camera.near },
      projectorFar: { value: layer.camera.far },
      renderedColor: { value: layer.renderedColor ? 1 : 0 },
      hueShift: { value: layer.hue ?? 0 },
      saturationShift: { value: layer.saturation ?? 0 },
      lightnessShift: { value: layer.lightness ?? 0 },
    },
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  material.userData.liclickNeutralTexture = neutral;
  return material;
}

function createBakeScene(group: THREE.Group) {
  const scene = new THREE.Scene();
  const bakeMeshes: THREE.Mesh[] = [];
  group.updateMatrixWorld(true);
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object.userData.liclickPaintOverlay) return;
    if (!object.geometry.getAttribute('position') || !object.geometry.getAttribute('uv')) return;
    if (!object.geometry.getAttribute('normal')) object.geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(object.geometry);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(object.matrixWorld);
    mesh.matrixWorld.copy(object.matrixWorld);
    mesh.matrixWorldAutoUpdate = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    bakeMeshes.push(mesh);
  });
  if (bakeMeshes.length === 0)
    throw new Error('No UV-mapped mesh is available for projected preview composition.');
  return { scene, bakeMeshes };
}

function bindRankTextures(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) {
  material.uniforms.rank0Map.value = target.textures[0];
  material.uniforms.rank1Map.value = target.textures[1];
  material.uniforms.rank2Map.value = target.textures[2];
  material.uniforms.rankInfoMap.value = target.textures[3];
}

function disposeJob(job: CompositeJob) {
  for (const layer of [...job.normalLayers, ...job.underlayLayers, ...job.overlayLayers]) {
    const neutral = layer.material.userData.liclickNeutralTexture as THREE.Texture | undefined;
    neutral?.dispose();
    layer.material.dispose();
  }
  job.rankTargets.forEach((target) => target.dispose());
  job.tileTargets.forEach((target) => target.dispose());
  job.candidateTarget.dispose();
  job.outputTarget.dispose();
  job.rankMaterial.dispose();
  job.composeMaterial.dispose();
  job.underlayMaterial.dispose();
  job.overlayMaterial.dispose();
  job.fullscreenMesh.geometry.dispose();
  job.bakeScene.clear();
  job.fullscreenScene.clear();
}

export class ProjectedLayerPreviewCompositor {
  private revision = 0;
  private job?: CompositeJob;
  private publishedTarget?: THREE.WebGLRenderTarget;
  private readonly neutralRenderedColorMask = (() => {
    const texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    texture.needsUpdate = true;
    texture.colorSpace = THREE.NoColorSpace;
    return texture;
  })();

  request(request: ProjectedPreviewCompositeRequest) {
    if (this.job?.request.signature === request.signature) return;
    const revision = ++this.revision;
    request.onProgress?.({
      signature: request.signature,
      phase: 'loading',
      progress: 0.02,
      elapsedMs: 0,
    });
    if (this.job) {
      disposeJob(this.job);
      this.job = undefined;
    }
    void this.prepareJob(request, revision).catch((error) => {
      if (revision === this.revision) request.onError(error);
    });
  }

  cancelPending() {
    this.revision += 1;
    if (this.job) disposeJob(this.job);
    this.job = undefined;
  }

  private async prepareJob(request: ProjectedPreviewCompositeRequest, revision: number) {
    if (!request.renderer.capabilities.isWebGL2) {
      throw new Error('Progressive projected preview composition requires WebGL 2.');
    }
    const context = request.renderer.getContext() as WebGL2RenderingContext;
    const maxDrawBuffers = context.getParameter(context.MAX_DRAW_BUFFERS) as number;
    if (maxDrawBuffers < 4) {
      throw new Error(
        `Progressive projected preview composition needs 4 draw buffers; this GPU exposes ${maxDrawBuffers}.`,
      );
    }
    if (request.resolution > request.renderer.capabilities.maxTextureSize) {
      throw new Error(
        `Requested ${request.resolution}px preview exceeds this GPU's ${request.renderer.capabilities.maxTextureSize}px texture limit.`,
      );
    }
    const prepared = await Promise.all(
      request.layers.map(async (input) => ({
        input,
        material: await createCandidateMaterial(request.group, input),
      })),
    );
    if (revision !== this.revision) {
      prepared.forEach(({ material }) => {
        (material.userData.liclickNeutralTexture as THREE.Texture | undefined)?.dispose();
        material.dispose();
      });
      return;
    }
    const { scene: bakeScene, bakeMeshes } = createBakeScene(request.group);
    const fullscreenScene = new THREE.Scene();
    const fullscreenMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    fullscreenMesh.frustumCulled = false;
    fullscreenScene.add(fullscreenMesh);
    const candidateTarget = createMrt(TILE_SIZE, TILE_SIZE, 2);
    const rankTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] = [
      createMrt(TILE_SIZE, TILE_SIZE, 4),
      createMrt(TILE_SIZE, TILE_SIZE, 4),
    ];
    const tileTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] = [
      createMrt(TILE_SIZE, TILE_SIZE, 2),
      createMrt(TILE_SIZE, TILE_SIZE, 2),
    ];
    tileTargets.forEach((target) => {
      target.textures[0].colorSpace = THREE.SRGBColorSpace;
    });
    const hasRenderedColor = request.layers.some((layer) => layer.renderedColor);
    const outputTarget = createMrt(
      request.resolution,
      request.resolution,
      hasRenderedColor ? 2 : 1,
    );
    outputTarget.textures[0].colorSpace = THREE.SRGBColorSpace;
    const rankMaterial = createFullscreenMaterial(rankFragmentShader, {
      rank0Map: rankTargets[0].textures[0],
      rank1Map: rankTargets[0].textures[1],
      rank2Map: rankTargets[0].textures[2],
      rankInfoMap: rankTargets[0].textures[3],
      candidateMap: candidateTarget.textures[0],
      candidateInfoMap: candidateTarget.textures[1],
      tileUvScale: new THREE.Vector2(1, 1),
    });
    const composeMaterial = createFullscreenMaterial(composeFragmentShader, {
      rank0Map: rankTargets[0].textures[0],
      rank1Map: rankTargets[0].textures[1],
      rank2Map: rankTargets[0].textures[2],
      rankInfoMap: rankTargets[0].textures[3],
      tileUvScale: new THREE.Vector2(1, 1),
    });
    const overlayMaterial = createFullscreenMaterial(overlayFragmentShader, {
      baseMap: tileTargets[0].textures[0],
      baseRenderedMaskMap: tileTargets[0].textures[1],
      candidateMap: candidateTarget.textures[0],
      candidateInfoMap: candidateTarget.textures[1],
      tileUvScale: new THREE.Vector2(1, 1),
    });
    this.job = {
      revision,
      request,
      normalLayers: prepared.filter(
        ({ input }) =>
          (input.compositeRole ?? (input.blendMode === 'overlay' ? 'overlay' : 'normal')) ===
          'normal',
      ),
      underlayLayers: prepared.filter(({ input }) => input.compositeRole === 'underlay'),
      overlayLayers: prepared.filter(
        ({ input }) =>
          (input.compositeRole ?? (input.blendMode === 'overlay' ? 'overlay' : 'normal')) ===
          'overlay',
      ),
      bakeScene,
      bakeMeshes,
      camera: new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1),
      candidateTarget,
      rankTargets,
      tileTargets,
      outputTarget,
      hasRenderedColor,
      rankMaterial,
      composeMaterial,
      underlayMaterial: createFullscreenMaterial(underlayFragmentShader, {
        baseMap: tileTargets[0].textures[0],
        baseRenderedMaskMap: tileTargets[0].textures[1],
        candidateMap: candidateTarget.textures[0],
        candidateInfoMap: candidateTarget.textures[1],
        tileUvScale: new THREE.Vector2(1, 1),
      }),
      overlayMaterial,
      fullscreenScene,
      fullscreenMesh,
      tileIndex: 0,
      layerIndex: 0,
      phase: 'begin-tile',
      rankReadIndex: 0,
      tileReadIndex: 0,
      startedAt: performance.now(),
      lastProgressAt: 0,
    };
    request.onProgress?.({
      signature: request.signature,
      phase: 'compositing',
      progress: 0.08,
      elapsedMs: 0,
    });
  }

  step(frameBudgetMs = 3, maxOperations = 2) {
    const job = this.job;
    if (!job) return;
    const startedAt = performance.now();
    let operations = 0;
    try {
      do {
        this.stepOnce(job);
        operations += 1;
        if (!this.job || this.job !== job) return;
      } while (operations < maxOperations && performance.now() - startedAt < frameBudgetMs);
      this.reportProgress(job);
    } catch (error) {
      if (this.job === job) this.job = undefined;
      disposeJob(job);
      job.request.onError(error);
    }
  }

  private reportProgress(job: CompositeJob, force = false) {
    if (!job.request.onProgress) return;
    const now = performance.now();
    if (!force && now - job.lastProgressAt < 250) return;
    job.lastProgressAt = now;
    const resolution = job.request.resolution;
    const tileCount = Math.ceil(resolution / TILE_SIZE) ** 2;
    const operationsPerTile =
      job.normalLayers.length + job.underlayLayers.length + job.overlayLayers.length + 3;
    const phaseOffset =
      job.phase === 'begin-tile'
        ? 0
        : job.phase === 'rank'
          ? 1 + job.layerIndex
          : job.phase === 'compose'
            ? 1 + job.normalLayers.length
            : job.phase === 'underlay'
              ? 2 + job.normalLayers.length + job.layerIndex
            : job.phase === 'overlay'
              ? 2 + job.normalLayers.length + job.underlayLayers.length + job.layerIndex
              : operationsPerTile - 1;
    const completedOperations = Math.min(
      tileCount * operationsPerTile,
      job.tileIndex * operationsPerTile + phaseOffset,
    );
    job.request.onProgress({
      signature: job.request.signature,
      phase: 'compositing',
      progress: Math.min(
        0.98,
        0.08 + (completedOperations / (tileCount * operationsPerTile)) * 0.9,
      ),
      elapsedMs: now - job.startedAt,
    });
  }

  private stepOnce(job: CompositeJob) {
    const renderer = job.request.renderer;
    const state = captureRendererState(renderer);
    try {
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      const columns = Math.ceil(job.request.resolution / TILE_SIZE);
      const rows = Math.ceil(job.request.resolution / TILE_SIZE);
      const tileX = (job.tileIndex % columns) * TILE_SIZE;
      const tileY = Math.floor(job.tileIndex / columns) * TILE_SIZE;
      const tileWidth = Math.min(TILE_SIZE, job.request.resolution - tileX);
      const tileHeight = Math.min(TILE_SIZE, job.request.resolution - tileY);
      const uvScale = new THREE.Vector2(tileWidth / TILE_SIZE, tileHeight / TILE_SIZE);

      if (job.phase === 'begin-tile') {
        for (const target of [...job.rankTargets, ...job.tileTargets, job.candidateTarget]) {
          renderer.setRenderTarget(target);
          renderer.setViewport(0, 0, TILE_SIZE, TILE_SIZE);
          renderer.setScissorTest(false);
          renderer.setClearColor(0x000000, 0);
          renderer.clear(true, true, true);
        }
        job.layerIndex = 0;
        job.rankReadIndex = 0;
        job.tileReadIndex = 0;
        job.phase = job.normalLayers.length > 0 ? 'rank' : 'compose';
        return;
      }

      if (job.phase === 'rank') {
        const layer = job.normalLayers[job.layerIndex];
        job.bakeMeshes.forEach((mesh) => {
          mesh.material = layer.material;
        });
        renderer.setRenderTarget(job.candidateTarget);
        renderer.setViewport(-tileX, -tileY, job.request.resolution, job.request.resolution);
        renderer.setScissor(0, 0, tileWidth, tileHeight);
        renderer.setScissorTest(true);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.render(job.bakeScene, job.camera);

        const rankRead = job.rankTargets[job.rankReadIndex];
        const rankWriteIndex = job.rankReadIndex === 0 ? 1 : 0;
        bindRankTextures(job.rankMaterial, rankRead);
        job.rankMaterial.uniforms.tileUvScale.value.copy(uvScale);
        job.fullscreenMesh.material = job.rankMaterial;
        renderer.setRenderTarget(job.rankTargets[rankWriteIndex]);
        renderer.setViewport(0, 0, tileWidth, tileHeight);
        renderer.setScissorTest(false);
        renderer.render(job.fullscreenScene, job.camera);
        job.rankReadIndex = rankWriteIndex;
        job.layerIndex += 1;
        if (job.layerIndex >= job.normalLayers.length) {
          job.layerIndex = 0;
          job.phase = 'compose';
        }
        return;
      }

      if (job.phase === 'compose') {
        bindRankTextures(job.composeMaterial, job.rankTargets[job.rankReadIndex]);
        job.composeMaterial.uniforms.tileUvScale.value.copy(uvScale);
        job.fullscreenMesh.material = job.composeMaterial;
        renderer.setRenderTarget(job.tileTargets[0]);
        renderer.setViewport(0, 0, tileWidth, tileHeight);
        renderer.setScissorTest(false);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.render(job.fullscreenScene, job.camera);
        job.tileReadIndex = 0;
        job.layerIndex = 0;
        job.phase =
          job.underlayLayers.length > 0
            ? 'underlay'
            : job.overlayLayers.length > 0
              ? 'overlay'
              : 'copy';
        return;
      }

      if (job.phase === 'underlay') {
        const layer = job.underlayLayers[job.layerIndex];
        job.bakeMeshes.forEach((mesh) => {
          mesh.material = layer.material;
        });
        renderer.setRenderTarget(job.candidateTarget);
        renderer.setViewport(-tileX, -tileY, job.request.resolution, job.request.resolution);
        renderer.setScissor(0, 0, tileWidth, tileHeight);
        renderer.setScissorTest(true);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.render(job.bakeScene, job.camera);

        const tileRead = job.tileTargets[job.tileReadIndex];
        const tileWriteIndex = job.tileReadIndex === 0 ? 1 : 0;
        job.underlayMaterial.uniforms.baseMap.value = tileRead.textures[0];
        job.underlayMaterial.uniforms.baseRenderedMaskMap.value = tileRead.textures[1];
        job.underlayMaterial.uniforms.tileUvScale.value.copy(uvScale);
        job.fullscreenMesh.material = job.underlayMaterial;
        renderer.setRenderTarget(job.tileTargets[tileWriteIndex]);
        renderer.setViewport(0, 0, tileWidth, tileHeight);
        renderer.setScissorTest(false);
        renderer.render(job.fullscreenScene, job.camera);
        job.tileReadIndex = tileWriteIndex;
        job.layerIndex += 1;
        if (job.layerIndex >= job.underlayLayers.length) {
          job.layerIndex = 0;
          job.phase = job.overlayLayers.length > 0 ? 'overlay' : 'copy';
        }
        return;
      }

      if (job.phase === 'overlay') {
        const layer = job.overlayLayers[job.layerIndex];
        job.bakeMeshes.forEach((mesh) => {
          mesh.material = layer.material;
        });
        renderer.setRenderTarget(job.candidateTarget);
        renderer.setViewport(-tileX, -tileY, job.request.resolution, job.request.resolution);
        renderer.setScissor(0, 0, tileWidth, tileHeight);
        renderer.setScissorTest(true);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.render(job.bakeScene, job.camera);

        const tileRead = job.tileTargets[job.tileReadIndex];
        const tileWriteIndex = job.tileReadIndex === 0 ? 1 : 0;
        job.overlayMaterial.uniforms.baseMap.value = tileRead.textures[0];
        job.overlayMaterial.uniforms.baseRenderedMaskMap.value = tileRead.textures[1];
        job.overlayMaterial.uniforms.tileUvScale.value.copy(uvScale);
        job.fullscreenMesh.material = job.overlayMaterial;
        renderer.setRenderTarget(job.tileTargets[tileWriteIndex]);
        renderer.setViewport(0, 0, tileWidth, tileHeight);
        renderer.setScissorTest(false);
        renderer.render(job.fullscreenScene, job.camera);
        job.tileReadIndex = tileWriteIndex;
        job.layerIndex += 1;
        if (job.layerIndex >= job.overlayLayers.length) job.phase = 'copy';
        return;
      }

      const tile = job.tileTargets[job.tileReadIndex];
      renderer.initRenderTarget(job.outputTarget);
      const sourceRegion = new THREE.Box2(
        new THREE.Vector2(0, 0),
        new THREE.Vector2(tileWidth, tileHeight),
      );
      const destination = new THREE.Vector2(tileX, tileY);
      renderer.copyTextureToTexture(
        tile.textures[0],
        job.outputTarget.textures[0],
        sourceRegion,
        destination,
      );
      if (job.hasRenderedColor) {
        renderer.copyTextureToTexture(
          tile.textures[1],
          job.outputTarget.textures[1],
          sourceRegion,
          destination,
        );
      }
      job.tileIndex += 1;
      if (job.tileIndex < columns * rows) {
        job.phase = 'begin-tile';
        return;
      }
      this.publish(job);
    } finally {
      restoreRendererState(renderer, state);
    }
  }

  private publish(job: CompositeJob) {
    if (job.revision !== this.revision) return;
    const previousPublished = this.publishedTarget;
    this.publishedTarget = job.outputTarget;
    job.outputTarget = createMrt(1, 1, 2);
    const result: ProjectedPreviewComposite = {
      signature: job.request.signature,
      resolution: job.request.resolution,
      colorTexture: this.publishedTarget.textures[0],
      renderedColorMaskTexture: this.publishedTarget.textures[1] ?? this.neutralRenderedColorMask,
      layerIds: job.request.layers.map((layer) => layer.layerId),
    };
    this.job = undefined;
    disposeJob(job);
    job.request.onProgress?.({
      signature: job.request.signature,
      phase: 'compositing',
      progress: 1,
      elapsedMs: performance.now() - job.startedAt,
    });
    job.request.onReady(result);
    window.setTimeout(() => previousPublished?.dispose(), 1000);
  }

  dispose() {
    this.revision += 1;
    if (this.job) disposeJob(this.job);
    this.job = undefined;
    this.publishedTarget?.dispose();
    this.publishedTarget = undefined;
    this.neutralRenderedColorMask.dispose();
  }
}
