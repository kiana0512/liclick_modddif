import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkLiclickApiAccess } from '../auth/atlasAuthService.js';
import { requireAuth } from '../auth/authMiddleware.js';
import { getPathSegments, sendJson } from './httpUtils.js';

export async function handleLiclickRoute(request: IncomingMessage, response: ServerResponse, url: URL) {
  const segments = getPathSegments(url);
  if (segments[0] !== 'api' || segments[1] !== 'liclick') return false;
  const user = await requireAuth(request, response);
  if (!user) return true;

  if (request.method === 'GET' && segments[2] === 'status') {
    const result = await checkLiclickApiAccess();
    sendJson(response, result.ok ? 200 : 503, result);
    return true;
  }

  return false;
}
