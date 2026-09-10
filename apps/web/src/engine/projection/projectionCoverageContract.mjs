/**
 * The viewport mixes the diagnostic empty-surface hatch out over this exact
 * aggregate projection-coverage range. Content-aware repair imports the same
 * value so its gap count cannot drift from what the editor actually displays.
 */
export const EMPTY_PROJECTION_COVERAGE_FEATHER_END = 0.12;

/** Highest quantized bake alpha that can still leave any hatch contribution. */
export const EMPTY_PROJECTION_MAX_VISIBLE_ALPHA =
  Math.ceil(EMPTY_PROJECTION_COVERAGE_FEATHER_END * 255) - 1;

// PROJECTION-RELIABLE-FOOTPRINT v1.0.0: harden geometric support, not authored masks.
export const PROJECTION_RELIABILITY_CUTOFF = 0.98;
export function reliableProjectionSupport(support) {
  return Number.isFinite(support) && support >= PROJECTION_RELIABILITY_CUTOFF ? 1 : 0;
}
export const RELIABLE_PROJECTION_GLSL = `
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
