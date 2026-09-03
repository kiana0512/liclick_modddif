import type { WorkspaceMode } from '@/components/workspace/workspacePanelTypes';

export type WorkspaceCameraTransition = 'none' | 'focus-selected' | 'preserve';

export function getWorkspaceCameraTransition(
  previousMode: WorkspaceMode,
  currentMode: WorkspaceMode,
  modelSetUnchanged: boolean,
): WorkspaceCameraTransition {
  if (previousMode === currentMode || !modelSetUnchanged) return 'none';
  return currentMode === 'texture' ? 'focus-selected' : 'preserve';
}

export function shouldFocusImportedModelAfterImport(workspaceMode: WorkspaceMode) {
  return workspaceMode === 'texture';
}

export function isStrictModelAppend(
  previousModelIds: ReadonlySet<string>,
  currentModelIds: ReadonlySet<string>,
) {
  return (
    previousModelIds.size > 0 &&
    currentModelIds.size > previousModelIds.size &&
    [...previousModelIds].every((objectId) => currentModelIds.has(objectId))
  );
}
