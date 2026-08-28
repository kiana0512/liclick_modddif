import { getWorkspaceApiBase } from '@/services/workspaceApiBase.cloud';

/** Cloud projects and user settings use the authenticated same-origin control plane. */
export function getProjectApiBase() {
  return getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);
}
