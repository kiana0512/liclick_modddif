import type { Layer } from '@/types/layer';

/**
 * The ordered stack contains a packed snapshot of projected masks. While the
 * apply brush is live it cannot reflect mutations to the renderer-owned canvas
 * until the stack is rebuilt, so the dedicated overlay temporarily owns live
 * feedback while the persisted repaint row remains the idle authority.
 */
export function shouldUseDedicatedLocalRepaintOverlay(
  _layers: readonly Layer[],
  _preview: Layer | undefined,
  liveFeedbackRequested: boolean,
) {
  // The apply brush mutates a CanvasTexture every frame. Keep that hot path on
  // the already-compiled exact overlay; the shared stack is authoritative again
  // as soon as the gesture/session hands off. This avoids making the first
  // stroke wait for a resident material publication while preserving ordered
  // composition outside the interactive phase.
  // The dedicated mesh has exactly one job: frame-by-frame feedback while the
  // new-result apply brush is active. Persisted repaint rows (including their
  // eraser) must stay in the resident stack so mask edits, eye toggles and
  // ordering all observe the same material instance.
  return liveFeedbackRequested;
}

/**
 * A renderer-owned preview only mutes its persisted twin while the dedicated
 * GPU overlay is the presentation path. When layer order requires the preview
 * to participate in the shared projected stack, muting the same id there makes
 * both owners transparent: the dedicated overlay is hidden by the order guard
 * and the resident binding is disabled by the preview marker.
 */
export function shouldMuteLocalRepaintResidentLayer(
  layers: readonly Layer[],
  preview: Layer | undefined,
  layerId: string,
  liveFeedbackRequested = false,
) {
  return (
    preview?.id === layerId &&
    shouldUseDedicatedLocalRepaintOverlay(layers, preview, liveFeedbackRequested)
  );
}

/** Match SceneRoot's merged UV boundary; covered rows have no resident sampler. */
export function isLocalRepaintBelowMergedUv(layers: readonly Layer[], target: Layer) {
  return layers.some((layer) =>
    layer.type === 'uv' && layer.role === 'merged-uv' && layer.visible &&
    Boolean(layer.imageUrl) && (!layer.objectId || layer.objectId === target.objectId) &&
    Number.isFinite(layer.order) && layer.order <= target.order,
  );
}

/** New foreground or merged-away rows have no resident binding to wait for. */
export function shouldWaitForLocalRepaintResidentMaterial(
  layers: readonly Layer[],
  preview: Layer | undefined,
  layerId: string,
) {
  const target = layers.find((layer) => layer.id === layerId) ??
    (preview?.id === layerId ? preview : undefined);
  if (target && isLocalRepaintBelowMergedUv(layers, target)) return false;
  return layers.some((layer) => layer.id === layerId && layer.visible);
}
