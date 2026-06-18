import type { IncomingMessage, ServerResponse } from 'node:http';
import { saveDataUrlAsset } from '../services/assetFileService.js';
import type { AssetCategory } from '../types/asset.js';
import { getPathSegments, readJsonBody, sendJson } from './httpUtils.js';

export async function handleAssetsRoute(request: IncomingMessage, response: ServerResponse, url: URL) {
  const segments = getPathSegments(url);
  const projectId = segments[2];
  if (request.method !== 'POST' || segments[1] !== 'projects' || !projectId || segments[3] !== 'assets') {
    return false;
  }

  const body = await readJsonBody<{
    category: AssetCategory;
    dataUrl: string;
    filename: string;
  }>(request);
  const asset = await saveDataUrlAsset({ projectId, ...body });
  if (!asset) sendJson(response, 404, { error: 'Project not found.' });
  else sendJson(response, 201, { asset });
  return true;
}
