/**
 * The viewport mixes the diagnostic empty-surface hatch out over this exact
 * aggregate projection-coverage range. Content-aware repair imports the same
 * value so its gap count cannot drift from what the editor actually displays.
 */
export const EMPTY_PROJECTION_COVERAGE_FEATHER_END = 0.12;

/** Highest quantized bake alpha that can still leave any hatch contribution. */
export const EMPTY_PROJECTION_MAX_VISIBLE_ALPHA =
  Math.ceil(EMPTY_PROJECTION_COVERAGE_FEATHER_END * 255) - 1;
