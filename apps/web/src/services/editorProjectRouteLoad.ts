export type EditorProjectLoadToken = {
  projectId: string;
  revision: number;
};

// Keep the atomic loading cover long enough for normal model/material restore,
// but never let a malformed asset or a missed renderer event trap the editor.
export const EDITOR_PROJECT_VIEWPORT_PRESENTATION_TIMEOUT_MS = 12_000;

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

export function isEditorProjectViewportReady(input: {
  routeProjectId: string;
  serverReadyProjectId?: string;
  presentedViewportProjectId?: string;
  presentationTimedOutProjectId?: string;
  objectCount: number;
}) {
  if (!isEditorProjectServerReady(input.routeProjectId, input.serverReadyProjectId)) {
    return false;
  }

  // The model renderer publishes `initial-model-frame-presented` only after a
  // real model reaches the WebGL framebuffer. A brand-new project has no model,
  // so waiting for that signal would leave the route cover visible forever.
  return (
    input.objectCount === 0 ||
    input.presentedViewportProjectId === input.routeProjectId ||
    input.presentationTimedOutProjectId === input.routeProjectId
  );
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
