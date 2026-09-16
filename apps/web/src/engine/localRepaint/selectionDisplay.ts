// INPAINT-SELECTION-DISPLAY/1.0.0. Visual feedback only: never use this
// transfer function for authored masks, capture, persistence or UV writes.
// Linear UV filtering attenuates coverage at island edges. Saturate supported
// pixels while retaining a short smooth transition at the unchanged cutoff.
// This does not fill zero-coverage holes or sample neighbouring UV islands.
export const inpaintSelectionDisplayShader = `
  float inpaintSelectionDisplayAlpha(float coverage) {
    return smoothstep(0.01, 0.08, coverage);
  }
`;
