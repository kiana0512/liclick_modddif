/** Deletion may change live layers, never inputs still being captured. */
export function isGenerationLayerDeletionLocked(input: {
  contentAwareRepairRunning: boolean;
  snapshotPreparing: boolean;
  localInputsPreparing: boolean;
  localRequestPending: boolean;
}) {
  return input.contentAwareRepairRunning || input.snapshotPreparing ||
    input.localInputsPreparing || input.localRequestPending;
}

/** Allow only row selection and explicit delete/menu controls, not sibling tools. */
export function isLayerDeletionInteractionTarget(target: HTMLElement) {
  const control = target.closest('button, input, select, textarea, a, label, [role="button"]');
  return Boolean(control?.matches('[data-task-layer-delete-allowed="true"], [data-layer-id][role="button"]'));
}
