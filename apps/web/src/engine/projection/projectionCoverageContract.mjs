/**
 * The viewport mixes the diagnostic empty-surface hatch out over this exact
 * aggregate projection-coverage range. Content-aware repair imports the same
 * value so its gap count cannot drift from what the editor actually displays.
 */
export const EMPTY_PROJECTION_COVERAGE_FEATHER_END = 0.12;

/** Highest quantized bake alpha that can still leave any hatch contribution. */
export const EMPTY_PROJECTION_MAX_VISIBLE_ALPHA =
  Math.ceil(EMPTY_PROJECTION_COVERAGE_FEATHER_END * 255) - 1;

// PROJECTION-RELIABLE-FOOTPRINT v1.1.0: broaden support without changing visibility gates.
export const PROJECTION_RELIABILITY_CUTOFF = 0.90;
export function reliableProjectionSupport(support) {
  return Number.isFinite(support) && support >= PROJECTION_RELIABILITY_CUTOFF ? 1 : 0;
}
// PROJECTION-CAMERA-DIRECTION/1.0.0: P*V has a constant homogeneous row for orthographic cameras.
export const RELIABLE_PROJECTION_GLSL = `
  bool captureIsOrthographic(mat4 projector) {
    return length(vec3(projector[0][3], projector[1][3], projector[2][3])) < 0.000001;
  }
  vec3 captureViewDirection(vec3 position, mat4 projector) {
    if (captureIsOrthographic(projector)) return vec3(0.0, 0.0, 1.0);
    return normalize(-position);
  }
  vec3 captureWorldDirection(vec3 position, vec3 cameraPosition, mat4 projector, mat4 captureView) {
    if (captureIsOrthographic(projector)) return normalize(vec3(captureView[0][2], captureView[1][2], captureView[2][2]));
    return normalize(cameraPosition - position);
  }

  float reliableProjectionSupport(float support) {
    return step(${PROJECTION_RELIABILITY_CUTOFF.toFixed(2)}, support);
  }
`;

/** Coverage-mode PNG alpha is a renderer-owned mask, never inferred from RGB. */
export function projectionGapMaskFromAlpha(image, objectMask) {
  const { width, height } = image;
  if (objectMask.width !== width || objectMask.height !== height ||
      objectMask.data.length !== width * height || image.data.length !== width * height * 4) {
    throw new Error('Projection coverage dimensions differ.');
  }
  const data = new Uint8ClampedArray(width * height);
  for (let index = 0; index < data.length; index++) {
    // Include partially covered MSAA edge pixels, not just zero-alpha holes.
    if (objectMask.data[index] > 0 && image.data[index * 4 + 3] < 255) data[index] = 255;
  }
  return { width, height, data };
}
