export const PRIORITY_PROJECTION_BOUNDARY_QUALITY_START = 0.05;
export const PRIORITY_PROJECTION_BOUNDARY_QUALITY_END = 0.35;
export const PRIORITY_PROJECTION_BOUNDARY_ALPHA_MIN = 0.45;
export const PRIORITY_PROJECTION_CORE_COVERAGE_START = 0.7;
export const PRIORITY_PROJECTION_CORE_COVERAGE_END = 0.92;
export const PRIORITY_PROJECTION_CORE_QUALITY_START = 0.55;
export const PRIORITY_PROJECTION_CORE_QUALITY_END = 0.82;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = clamp01((value - edge0) / Math.max(edge1 - edge0, 0.000001));
  return t * t * (3 - 2 * t);
}

/**
 * A single-view paintover owns the high-confidence centre of its valid
 * projection while retaining a continuous feather at depth/angle/image edges.
 * Coverage has already passed the geometric visibility guards, so this never
 * grants a layer access to an occluded or out-of-frustum surface.
 */
export function getPriorityProjectionAlpha(coverage: number, quality: number) {
  const safeCoverage = clamp01(coverage);
  const safeQuality = Math.max(0, quality);
  const boundaryConfidence = smoothstep(
    PRIORITY_PROJECTION_BOUNDARY_QUALITY_START,
    PRIORITY_PROJECTION_BOUNDARY_QUALITY_END,
    safeQuality,
  );
  const boundaryAlpha =
    safeCoverage *
    (PRIORITY_PROJECTION_BOUNDARY_ALPHA_MIN +
      (1 - PRIORITY_PROJECTION_BOUNDARY_ALPHA_MIN) * boundaryConfidence);
  const coreConfidence =
    smoothstep(
      PRIORITY_PROJECTION_CORE_COVERAGE_START,
      PRIORITY_PROJECTION_CORE_COVERAGE_END,
      safeCoverage,
    ) *
    smoothstep(
      PRIORITY_PROJECTION_CORE_QUALITY_START,
      PRIORITY_PROJECTION_CORE_QUALITY_END,
      safeQuality,
    );
  return clamp01(boundaryAlpha + (1 - boundaryAlpha) * coreConfidence);
}

