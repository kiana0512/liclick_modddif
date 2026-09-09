import { useSyncExternalStore } from 'react';

const pendingByObject = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();
let snapshot: readonly string[] = [];
export function projectionDisplayCapacity(maxFragmentUniforms: number) {
  return Math.max(0, Math.floor((maxFragmentUniforms - 128) / 32));
}
export function publishPendingProjectionLayers(objectId: string, ids: readonly string[]) {
  if (JSON.stringify(pendingByObject.get(objectId) ?? []) === JSON.stringify(ids)) return;
  pendingByObject.set(objectId, ids);
  snapshot = [...pendingByObject.values()].flat();
  listeners.forEach((listener) => listener());
}
export function usePendingProjectionLayers() {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => snapshot,
  );
}
