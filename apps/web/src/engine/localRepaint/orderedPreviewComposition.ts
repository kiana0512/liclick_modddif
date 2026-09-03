import type { Layer } from '@/types/layer';

function belongsToSameObject(layer: Layer, preview: Layer) {
  return !layer.objectId || !preview.objectId || layer.objectId === preview.objectId;
}

/**
 * Renderer-owned repaint previews carry the live image/mask, while the persisted
 * row remains the authority for presentation state and panel order. Combining
 * them lets a dragged row move immediately without republishing the live canvas.
 */
export function resolveLocalRepaintPreviewPresentation(
  preview: Layer,
  layers: readonly Layer[],
): Layer {
  const persisted = layers.find((layer) => layer.id === preview.id);
  if (!persisted) return preview;
  return {
    ...persisted,
    ...preview,
    order: persisted.order,
    visible: persisted.visible,
    opacity: persisted.opacity,
    strength: persisted.strength,
    blendMode: persisted.blendMode,
    adjustments: persisted.adjustments,
  };
}

/**
 * The dedicated repaint mesh is a valid fast path only while the repaint is the
 * highest ordered edit. A visible priority single-view above it must remain the
 * final source-over operation so its core covers the repaint and its feathered
 * edge attenuates it.
 */
export function shouldPresentLocalRepaintInOrderedStack(
  layers: readonly Layer[],
  preview: Layer | undefined,
) {
  if (!preview?.imageUrl || !preview.camera || preview.type !== 'projected') return false;
  const resolved = resolveLocalRepaintPreviewPresentation(preview, layers);
  return layers.some(
    (layer) =>
      layer.id !== resolved.id &&
      layer.type === 'projected' &&
      layer.visible &&
      Boolean(layer.imageUrl) &&
      Boolean(layer.camera) &&
      belongsToSameObject(layer, resolved) &&
      layer.order < resolved.order &&
      layer.projectionCompositeMode === 'single-view-priority-v1',
  );
}

/**
 * The ordered stack contains a packed snapshot of projected masks. While the
 * apply brush is live it cannot reflect mutations to the renderer-owned canvas
 * until the stack is rebuilt, so the dedicated overlay must temporarily own
 * presentation even when normal idle ordering would place a priority layer
 * above the repaint.
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

export function getOrderedLocalRepaintPreviewLayer(
  layers: readonly Layer[],
  preview: Layer | undefined,
) {
  if (!preview || !shouldPresentLocalRepaintInOrderedStack(layers, preview)) return undefined;
  return resolveLocalRepaintPreviewPresentation(preview, layers);
}

/** A new topmost preview is overlay-only until its first stroke is published. */
export function shouldWaitForLocalRepaintResidentMaterial(
  layers: readonly Layer[],
  preview: Layer | undefined,
  layerId: string,
) {
  return (
    layers.some((layer) => layer.id === layerId && layer.visible) ||
    getOrderedLocalRepaintPreviewLayer(layers, preview)?.id === layerId
  );
}

/** Layer order zero is the top row; renderer inputs are consumed bottom-up. */
export function mergeOrderedLocalRepaintPreview(
  layers: readonly Layer[],
  preview: Layer | undefined,
) {
  if (!preview) return [...layers];
  return [...layers.filter((layer) => layer.id !== preview.id), preview].sort(
    (left, right) => right.order - left.order,
  );
}
