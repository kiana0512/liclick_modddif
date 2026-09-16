import * as THREE from 'three';
import { waitForBrowserPaint } from '@/utils/browserScheduling';

/** Inspect the bound UV material, not computation-ready/FPS telemetry. */
export function hasPresentedProjectedUvLayers(root: THREE.Object3D, expectedIds: string[]) {
  const expected = new Set(expectedIds);
  let found = false;
  let matches = true;
  root.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (material.name !== 'LiclickUvOverlayPreview' || material.userData.liclickLiveLocalRepaintOverlayMaterial) continue;
      found = true;
      const ids: unknown = material.userData.liclickResidentUvProjectionLayers;
      matches &&= Array.isArray(ids) && ids.length === expected.size && ids.every(id => expected.has(id)) &&
        new Set(ids).size === expected.size && Number((material as THREE.ShaderMaterial).uniforms?.useBaseMap?.value ?? 0) > 0;
    }
  });
  return found && matches;
}

export async function waitForProjectedUvLayers(root: THREE.Object3D, expectedIds: string[], timeoutMs = 60_000) {
  const deadline = performance.now() + timeoutMs;
  // React must first reconcile the eye update; a ready dataset may describe
  // the previous request and must never count as presentation acknowledgement.
  await waitForBrowserPaint();
  while (!hasPresentedProjectedUvLayers(root, expectedIds)) {
    if (performance.now() >= deadline) throw new Error('图层显隐 UV 发布超时，不能用旧画面通过测试。');
    await waitForBrowserPaint();
  }
}
