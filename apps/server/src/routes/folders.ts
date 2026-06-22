import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAuth } from '../auth/authMiddleware.js';
import { createFolder, deleteFolder, listFoldersForUser, renameFolder } from '../services/folderFileService.js';
import { getPathSegments, readJsonBody, sendJson } from './httpUtils.js';

export async function handleFoldersRoute(request: IncomingMessage, response: ServerResponse, url: URL) {
  const segments = getPathSegments(url);
  const folderId = segments[2];
  const user = await requireAuth(request, response);
  if (!user) return true;

  if (request.method === 'GET' && segments.length === 2) {
    sendJson(response, 200, { folders: await listFoldersForUser(user.id) });
    return true;
  }

  if (request.method === 'POST' && segments.length === 2) {
    const body = await readJsonBody<{ name?: string }>(request);
    sendJson(response, 201, { folder: await createFolder(user.id, body.name ?? 'New Folder') });
    return true;
  }

  if (request.method === 'PATCH' && folderId && segments.length === 3) {
    const body = await readJsonBody<{ name?: string }>(request);
    const folder = body.name ? await renameFolder(user.id, folderId, body.name) : undefined;
    if (!folder) sendJson(response, 404, { error: 'Folder not found.' });
    else sendJson(response, 200, { folder });
    return true;
  }

  if (request.method === 'DELETE' && folderId && segments.length === 3) {
    const result = await deleteFolder(user.id, folderId);
    if (!result) sendJson(response, 404, { error: 'Folder not found.' });
    else sendJson(response, 200, result);
    return true;
  }

  return false;
}
