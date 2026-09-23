import { useSyncExternalStore } from 'react';

export type LiveSurfacePaintPreview = {
  objectId: string;
  layerId: string;
  target: 'uv-image' | 'projected-mask';
  assetUrl: string;
  /**
   * Stable full-resolution mask binding prepared before the first projected
   * eraser stroke. The transient assetUrl remains the low-latency multiplier;
   * this URL identifies the durable mask used by the exact pointer-up handoff.
   * Neutral activation never inserts it into the authored texture-array
   * structure; only LayerStore publication after a real stroke does that.
   */
  residentMaskUrl?: string;
  composition: 'replace' | 'multiply-original-mask';
  /** True only after the eraser tool owns presentation, not during neutral GPU prewarm. */
  displayArmed: boolean;
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
    currentPreview.residentMaskUrl === preview.residentMaskUrl &&
    currentPreview.composition === preview.composition &&
    currentPreview.displayArmed === preview.displayArmed
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
