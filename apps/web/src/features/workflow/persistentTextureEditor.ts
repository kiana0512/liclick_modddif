type ProjectWorkflowRoute = {
  name: string;
  projectId?: string;
};

const TEXTURE_EDITOR_COMPANION_ROUTES = new Set(['autoRetopology', 'autoUv', 'bake']);

export function nextRetainedTextureProjectId(
  previousProjectId: string | undefined,
  route: ProjectWorkflowRoute,
) {
  if (route.name === 'editor') return route.projectId;
  if (
    previousProjectId &&
    route.projectId === previousProjectId &&
    TEXTURE_EDITOR_COMPANION_ROUTES.has(route.name)
  ) {
    return previousProjectId;
  }
  return undefined;
}

export function persistentTextureProjectId(
  retainedProjectId: string | undefined,
  route: ProjectWorkflowRoute,
) {
  return nextRetainedTextureProjectId(retainedProjectId, route);
}
