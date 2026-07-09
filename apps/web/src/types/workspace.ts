import type { Project } from './project';

export type LocalWorkspaceMode = 'file-system-access' | 'download-fallback';

export type WorkspaceSaveResult = {
  mode: LocalWorkspaceMode;
  workspaceName?: string;
  project: Project;
  lastSavedAt: string;
  message: string;
};

export type WorkspaceLoadResult = {
  project: Project;
  warnings: string[];
};
