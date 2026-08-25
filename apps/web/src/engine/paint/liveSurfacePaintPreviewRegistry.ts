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
  // Pointer-down re-enters the already-active projected eraser for every short
  // stroke. The live canvas and CanvasTexture are intentionally stable, so an
  // identical publication carries no new React state. Emitting anyway caused
  // SceneRoot to restart its async projected-material pass on every dot; a late
  // pass could then publish the previous layer binding over the resident one.
  if (
    currentPreview?.objectId === preview.objectId &&
    currentPreview.layerId === preview.layerId &&
    currentPreview.target === preview.target &&
    currentPreview.assetUrl === preview.assetUrl &&
    currentPreview.composition === preview.composition
  )
    return;
  currentPreview = preview;
  emitChange();
}

export function getLiveSurfacePaintPreview() {
  return currentPreview;
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
