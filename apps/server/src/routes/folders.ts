import type { IncomingMessage, ServerResponse } from 'node:http';
import { createFolder, deleteFolder, listFolders, renameFolder } from '../services/folderFileService.js';
import { getPathSegments, readJsonBody, sendJson } from './httpUtils.js';

export async function handleFoldersRoute(request: IncomingMessage, response: ServerResponse, url: URL) {
  const segments = getPathSegments(url);
  const folderId = segments[2];

  if (request.method === 'GET' && segments.length === 2) {
    sendJson(response, 200, { folders: await listFolders() });
    return true;
  }

  if (request.method === 'POST' && segments.length === 2) {
    const body = await readJsonBody<{ name?: string }>(request);
    sendJson(response, 201, { folder: await createFolder(body.name ?? 'New Folder') });
    return true;
  }

  if (request.method === 'PATCH' && folderId && segments.length === 3) {
    const body = await readJsonBody<{ name?: string }>(request);
    const folder = body.name ? await renameFolder(folderId, body.name) : undefined;
    if (!folder) sendJson(response, 404, { error: 'Folder not found.' });
    else sendJson(response, 200, { folder });
    return true;
  }

  if (request.method === 'DELETE' && folderId && segments.length === 3) {
    const result = await deleteFolder(folderId);
    if (!result) sendJson(response, 404, { error: 'Folder not found.' });
    else sendJson(response, 200, result);
    return true;
  }

  return false;
}
