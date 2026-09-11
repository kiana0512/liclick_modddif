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
  const deadline = performance.now() + 60_000;
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
    if (performance.now() >= deadline) throw new Error('UV 预览尚未更新完成，请稍后重试截图。');
    await waitForBrowserPaint();
  }
}
