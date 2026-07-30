import { useSyncExternalStore } from 'react';

export type LiveSurfacePaintPreview = {
  objectId: string;
  layerId: string;
  target: 'uv-image' | 'projected-mask';
  assetUrl: string;
  composition: 'replace' | 'multiply-original-mask';
};

let currentPreview: LiveSurfacePaintPreview | undefined;
const listeners = new Set<() => void>();

function emitChange() {
  listeners.forEach((listener) => listener());
}

export function publishLiveSurfacePaintPreview(preview: LiveSurfacePaintPreview) {
  currentPreview = preview;
  emitChange();
}

export function clearLiveSurfacePaintPreview(layerId: string, assetUrl?: string) {
  if (
    currentPreview?.layerId !== layerId ||
    (assetUrl !== undefined && currentPreview.assetUrl !== assetUrl)
  )
    return;
  currentPreview = undefined;
  emitChange();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentPreview;
}

export function useLiveSurfacePaintPreview() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
