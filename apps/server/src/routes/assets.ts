import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAuth } from '../auth/authMiddleware.js';
import { saveDataUrlAsset, saveRemoteImageAsset } from '../services/assetFileService.js';
import type { AssetCategory } from '../types/asset.js';
import { getPathSegments, readJsonBody, sendJson } from './httpUtils.js';

export async function handleAssetsRoute(request: IncomingMessage, response: ServerResponse, url: URL) {
  const segments = getPathSegments(url);
  const projectId = segments[2];
  if (request.method !== 'POST' || segments[1] !== 'projects' || !projectId || segments[3] !== 'assets') {
    return false;
  }
  const user = await requireAuth(request, response);
  if (!user) return true;

  const body = await readJsonBody<{
    category: AssetCategory;
    dataUrl?: string;
    url?: string;
    filename: string;
  }>(request);
  if (!body.dataUrl && !body.url) {
    sendJson(response, 400, { error: 'Asset dataUrl or url is required.' });
    return true;
  }
  const asset = body.url
    ? await saveRemoteImageAsset({
        userId: user.id,
        projectId,
        category: body.category,
        url: body.url,
        filename: body.filename,
      })
    : await saveDataUrlAsset({
        userId: user.id,
        projectId,
        category: body.category,
        dataUrl: body.dataUrl ?? '',
        filename: body.filename,
      });
  if (!asset) sendJson(response, 404, { error: 'Project not found.' });
  else sendJson(response, 201, { asset });
  return true;
}
