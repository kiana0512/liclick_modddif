import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAuth } from '../auth/authMiddleware.js';
import { exportProjectPackage } from '../services/exportService.js';
import { getPathSegments, sendJson } from './httpUtils.js';

export async function handleExportRoute(request: IncomingMessage, response: ServerResponse, url: URL) {
  const segments = getPathSegments(url);
  const projectId = segments[2];
  if (
    request.method !== 'POST' ||
    segments[1] !== 'projects' ||
    !projectId ||
    segments[3] !== 'export' ||
    segments[4] !== 'package'
  ) {
    return false;
  }
  const user = await requireAuth(request, response);
  if (!user) return true;

  const result = await exportProjectPackage(user.id, projectId);
  if (!result) sendJson(response, 404, { error: 'Project not found.' });
  else sendJson(response, 202, result);
  return true;
}
