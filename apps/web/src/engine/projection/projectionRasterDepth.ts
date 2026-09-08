/**
 * ALG-PROJ-006 v2.1.0: a shared raster tie-break, not capture-space visibility.
 * Only empty diagnostic fragments retain their existing 0.000006 retreat.
 * Authored colour keeps geometric depth: it must never move ahead of a shell.
 * Live repaint and resident colour use the SAME depth; LessEqualDepth plus
 * draw order puts the authored overlay on its own surface, not ahead of shells.
 * Never add slope-scaled polygonOffset on top of this explicit depth write.
 * UV raster/CPU/Worker/export do not use current-camera depth priority.
 */
export const PROJECTED_RASTER_DEPTH_GLSL = `
  float projectedRasterDepth(float geometricDepth, float accepted) {
    return clamp(geometricDepth + (1.0 - accepted) * 0.000006, 0.0, 1.0);
  }
`;
