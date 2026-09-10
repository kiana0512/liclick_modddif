// PROJECTED-MATERIAL-IDENTITY v1.0.0. The stack factory deliberately returns
// the single-layer shader for one input. Warmup shaders are never resident.
export function isResidentProjectedMaterial(material: { name: string }): boolean {
  return /^LiclickProjectedLayer(?:Stack)?:/.test(material.name);
}
