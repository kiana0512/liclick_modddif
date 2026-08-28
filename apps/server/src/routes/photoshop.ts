import type { IncomingMessage, ServerResponse } from 'node:http';
import { maxSourceBytes, photoshopBridge } from '../photoshop/photoshopBridgeService.js';
import { getPathSegments, readBinaryBody, readJsonBody, sendJson } from './httpUtils.js';

function sessionToken(request: IncomingMessage, url: URL) {
  const header = request.headers['x-liclick-session-token'];
  return (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('token') ?? '';
}

function errorStatus(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/令牌|不存在|无效/.test(message)) return 403;
  if (/超过|too large/i.test(message)) return 413;
  if (/未检测到|尚未连接|尚未上传/.test(message)) return 409;
  return 400;
}

export async function handlePhotoshopRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  if (!url.pathname.startsWith('/api/photoshop')) return false;
  const segments = getPathSegments(url);
  try {
    if (request.method === 'GET' && url.pathname === '/api/photoshop/status') {
      sendJson(response, 200, await photoshopBridge.getStatus());
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/photoshop/launch') {
      sendJson(response, 200, await photoshopBridge.launchPhotoshop());
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/photoshop/sessions') {
      const body = await readJsonBody<{
        projectId?: string;
        layerId?: string;
        layerName?: string;
        layerType?: 'projected' | 'uv';
      }>(request);
      if (!body.projectId || !body.layerId || !body.layerName || !['projected', 'uv'].includes(body.layerType ?? '')) {
        sendJson(response, 400, { error: '项目、图层和图层类型不能为空。' });
        return true;
      }
      const session = await photoshopBridge.createSession({
        projectId: body.projectId,
        layerId: body.layerId,
        layerName: body.layerName,
        layerType: body.layerType as 'projected' | 'uv',
      });
      sendJson(response, session.reused ? 200 : 201, session);
      return true;
    }
    const sessionId = segments[3];
    if (segments[2] === 'sessions' && sessionId) {
      const token = sessionToken(request, url);
      if (request.method === 'GET' && segments.length === 4) {
        sendJson(response, 200, await photoshopBridge.getSession(sessionId, token));
        return true;
      }
      if (request.method === 'PUT' && segments[4] === 'source') {
        const mime = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() || 'image/png';
        const buffer = await readBinaryBody(request, maxSourceBytes);
        sendJson(response, 200, await photoshopBridge.uploadSource(sessionId, token, mime, buffer));
        return true;
      }
      if (request.method === 'POST' && segments[4] === 'open') {
        sendJson(response, 200, await photoshopBridge.openSession(sessionId, token));
        return true;
      }
      if (request.method === 'POST' && segments[4] === 'sync') {
        sendJson(response, 200, await photoshopBridge.requestSync(sessionId, token));
        return true;
      }
      if (request.method === 'POST' && segments[4] === 'close') {
        sendJson(response, 200, await photoshopBridge.closeSession(sessionId, token));
        return true;
      }
    }
    sendJson(response, 404, { error: 'Photoshop bridge route not found.' });
    return true;
  } catch (error) {
    sendJson(response, errorStatus(error), {
      error: error instanceof Error ? error.message : 'Photoshop bridge request failed.',
    });
    return true;
  }
}
