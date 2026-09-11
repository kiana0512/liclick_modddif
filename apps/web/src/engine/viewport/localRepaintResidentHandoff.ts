import * as THREE from 'three';

/** A published row is resident work even if its older live marker has no revision. */
export function getTransientLocalRepaintLayerId(
  previewId: string | undefined,
  layers: readonly { id: string }[],
) {
  return previewId && !layers.some((layer) => layer.id === previewId) ? previewId : undefined;
}

/** Only the object that owns the previous preview can require a visual handoff. */
export function isLocalRepaintHandoffForObject(
  previousObjectId: string | undefined,
  nextObjectId: string | undefined,
) {
  return !previousObjectId || !nextObjectId || previousObjectId === nextObjectId;
}

/** Inspect assigned background materials, never the renderer-only twin or an in-flight build. */
export function isLocalRepaintLayerResident(group: THREE.Object3D, layerId: string) {
  let meshCount = 0;
  let ready = true;
  group.traverse((child) => {
    if (
      !(child instanceof THREE.Mesh) ||
      child.userData.liclickPaintOverlay ||
      child.userData.liclickViewportHelper ||
      child.userData.liclickSelectionGlow ||
      child.userData.liclickWireframeOverlay
    ) return;
    meshCount += 1;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    ready &&=
      materials.length > 0 &&
      materials.every((material) => {
        const uvIds = material.userData.liclickResidentUvProjectionLayers as string[] | undefined;
        if (material.name === 'LiclickUvOverlayPreview' && uvIds?.includes(layerId) &&
            material.userData.liclickDisposedMaterial !== true) return true;
        const state = material.userData.liclickProjectedLayerStackState as
          | { bindings?: Array<{ layerId?: string }> }
          | undefined;
        return (
          material.userData.liclickDisposedMaterial !== true &&
          Boolean(state?.bindings?.some((binding) => binding.layerId === layerId))
        );
      });
  });
  return meshCount > 0 && ready;
}

/** Yield between checks; timeout keeps the last good overlay instead of blanking it. */
export async function waitForLocalRepaintResidentHandoff(input: {
  ready: () => boolean;
  cancelled: () => boolean;
  nextFrame: () => Promise<void>;
  now: () => number;
}) {
  const deadline = input.now() + 10_000;
  while (!input.cancelled()) {
    if (input.ready()) return true;
    if (input.now() >= deadline) return false;
    await input.nextFrame();
  }
  return false;
}
