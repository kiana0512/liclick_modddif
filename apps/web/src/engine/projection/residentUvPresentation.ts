import type { Object3D } from 'three';
import { waitForBrowserPaint } from '@/utils/browserScheduling';
import { getLiveProjectedCanvasState } from './liveProjectedCanvasTextureRegistry';

const pending = new WeakMap<Object3D, { objectId: string; error?: unknown }>();
const managed = new WeakSet<Object3D>();
export type ResidentUvMaskBinding = { layerId: string; url: string; revision?: number };
const masks = new WeakMap<Object3D, ResidentUvMaskBinding[]>();
export function isResidentUvMaskPresented(root: Object3D, layerId: string, url: string) {
  return !pending.has(root) && Boolean(masks.get(root)?.some(binding =>
    binding.layerId === layerId && binding.url === url &&
    binding.revision === getLiveProjectedCanvasState(url)?.revision));
}
export function isResidentUvManaged(root: Object3D) { return managed.has(root); }
export function releaseResidentUvManagement(root: Object3D) { managed.delete(root); pending.delete(root); masks.delete(root); }
export function markResidentUvPending(root: Object3D, objectId: string, error?: unknown) {
  managed.add(root);
  pending.set(root, { objectId, error });
}
export function finishResidentUvPresentation(root: Object3D, bindings?: ResidentUvMaskBinding[]) {
  if (bindings) masks.set(root, bindings);
  pending.delete(root);
}

/** Generation references must not freeze the previous UV while a new state is pending. */
export async function waitForResidentUvPresentation(scene: Object3D, objectId: string) {
  await waitForBrowserPaint();
  for (;;) {
    let waiting = false;
    scene.traverse((object) => {
      const state = pending.get(object);
      if (state?.objectId !== objectId) return;
      if (state.error) throw state.error;
      waiting = true;
    });
    if (!waiting) return;
    // Pending projection is an ordered correctness barrier, not a generation
    // failure. The scheduler has a background-tab fallback, so keep driving
    // the resident publication until it completes or publishes its real error.
    await waitForBrowserPaint();
  }
}
