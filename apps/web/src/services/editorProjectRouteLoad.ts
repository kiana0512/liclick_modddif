export type EditorProjectLoadToken = {
  projectId: string;
  revision: number;
};

export function shouldLoadEditorProjectRoute(
  routeProjectId: string,
) {
  // A cached project may be only a list summary or a same-id demo placeholder.
  // Every editor route therefore starts one authoritative detail request.
  return Boolean(routeProjectId);
}

export function isEditorProjectServerReady(
  routeProjectId: string,
  serverReadyProjectId?: string,
) {
  return Boolean(routeProjectId) && routeProjectId === serverReadyProjectId;
}

export function isCurrentEditorProjectLoad(input: {
  token: EditorProjectLoadToken;
  currentRevision: number;
  currentRouteProjectId: string;
  resultProjectId: string;
}) {
  return (
    input.token.revision === input.currentRevision &&
    input.token.projectId === input.currentRouteProjectId &&
    input.resultProjectId === input.currentRouteProjectId
  );
}
