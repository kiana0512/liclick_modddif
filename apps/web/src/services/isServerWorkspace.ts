import type { WorkspaceMode } from '@/types/project';

/** GENERATION-SERVER-PERSISTENCE/1.0.0: legacy and cloud projects share the authenticated API. */
export function isServerWorkspace(mode: WorkspaceMode | undefined) {
  return mode === 'local-server' || mode === 'cloud-server';
}
