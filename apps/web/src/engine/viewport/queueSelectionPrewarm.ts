import type * as THREE from 'three';

const pending = new WeakMap<THREE.WebGLRenderer, Promise<void>>();

// Cleanup cannot cancel Three's native program poll. Keep the renderer owned
// until that work settles; superseded selections skip allocation on admission.
export function queueSelectionPrewarm(
  renderer: THREE.WebGLRenderer,
  shouldRun: () => boolean,
  run: () => Promise<void>,
) {
  const task = (pending.get(renderer) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => shouldRun() ? run() : undefined);
  pending.set(renderer, task);
  return task.finally(() => {
    if (pending.get(renderer) === task) pending.delete(renderer);
  });
}
