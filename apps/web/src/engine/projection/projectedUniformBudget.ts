/** Conservative vec4 slots: matrices, visibility inputs and layer controls.
 * Keep a fixed reserve for lighting, UV overlays and renderer uniforms.
 * This changes scheduling only; no layer is removed from the composition.
 */
export function isProjectedUniformBudgetSafe(layerCount: number, maxFragmentUniforms: number) {
  return layerCount * 32 + 128 <= maxFragmentUniforms;
}
