import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createProject,
  deleteProject,
  duplicateProject,
  listProjects,
  loadProject,
  moveProject,
  renameProject,
  saveProject,
  ProjectSaveConflictError,
} from '../services/projectFileService.js';
import type { WorkspaceProject } from '../types/project.js';
import { requireAuth } from '../auth/authMiddleware.js';
import { getPathSegments, readJsonBody, sendJson } from './httpUtils.js';

export async function handleProjectsRoute(request: IncomingMessage, response: ServerResponse, url: URL) {
  const segments = getPathSegments(url);
  const projectId = segments[2];
  const user = await requireAuth(request, response);
  if (!user) return true;

  if (request.method === 'GET' && segments.length === 2) {
    sendJson(response, 200, { projects: await listProjects(user.id) });
    return true;
  }

  if (request.method === 'POST' && segments.length === 2) {
    const body = await readJsonBody<{ name?: string; folderId?: string }>(request);
    const result = await createProject(user.id, body);
    sendJson(response, 201, result);
    return true;
  }

  if (request.method === 'GET' && projectId && segments.length === 3) {
    const result = await loadProject(user.id, projectId);
    if (!result) sendJson(response, 404, { error: 'Project not found.' });
    else sendJson(response, 200, result);
    return true;
  }

  if (request.method === 'PUT' && projectId && segments.length === 3) {
    const body = await readJsonBody<WorkspaceProject>(request);
    let result: Awaited<ReturnType<typeof saveProject>>;
    try {
      result = await saveProject(user.id, projectId, body);
    } catch (error) {
      if (error instanceof ProjectSaveConflictError) {
        sendJson(response, error.statusCode, { error: error.message });
        return true;
      }
      throw error;
    }
    if (!result) sendJson(response, 404, { error: 'Project not found.' });
    else sendJson(response, 200, result);
    return true;
  }

  if (request.method === 'PATCH' && projectId && segments.length === 3) {
    const body = await readJsonBody<{ name?: string }>(request);
    const result = body.name ? await renameProject(user.id, projectId, body.name) : undefined;
    if (!result) sendJson(response, 404, { error: 'Project not found.' });
    else sendJson(response, 200, result);
    return true;
  }

  if (request.method === 'DELETE' && projectId && segments.length === 3) {
    const result = await deleteProject(user.id, projectId);
    if (!result) sendJson(response, 404, { error: 'Project not found.' });
    else sendJson(response, 200, result);
    return true;
  }

  if (request.method === 'POST' && projectId && segments.length === 4 && segments[3] === 'duplicate') {
    const result = await duplicateProject(user.id, projectId);
    if (!result) sendJson(response, 404, { error: 'Project not found.' });
    else sendJson(response, 201, result);
    return true;
  }

  if (request.method === 'POST' && projectId && segments.length === 4 && segments[3] === 'move') {
    const body = await readJsonBody<{ folderId?: string | null }>(request);
    const result = await moveProject(user.id, projectId, body.folderId ?? null);
    if (!result) sendJson(response, 404, { error: 'Project not found.' });
    else sendJson(response, 200, result);
    return true;
  }

  return false;
}
