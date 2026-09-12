import type { Object3D } from 'three';
import { waitForBrowserPaint } from '@/utils/browserScheduling';

const pending = new WeakMap<Object3D, { objectId: string; error?: unknown }>();
const managed = new WeakSet<Object3D>();
export function isResidentUvManaged(root: Object3D) { return managed.has(root); }
export function releaseResidentUvManagement(root: Object3D) { managed.delete(root); pending.delete(root); }
export function markResidentUvPending(root: Object3D, objectId: string, error?: unknown) {
  managed.add(root);
  pending.set(root, { objectId, error });
}
export function finishResidentUvPresentation(root: Object3D) {
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
