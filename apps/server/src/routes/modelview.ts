import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAuth } from '../auth/authMiddleware.js';
import {
  checkModelviewInpaintServiceStatus,
  generateModelviewInpaint,
  ModelviewInpaintError,
  type ModelviewInpaintInput,
} from '../services/modelviewInpaintService.js';
import { getPathSegments, readJsonBody, sendJson } from './httpUtils.js';

export async function handleModelviewRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  const segments = getPathSegments(url);
  if (segments[0] !== 'api' || segments[1] !== 'modelview') return false;

  const user = await requireAuth(request, response);
  if (!user) return true;

  if (request.method === 'GET' && segments[2] === 'status') {
    try {
      sendJson(response, 200, { ok: true, ...checkModelviewInpaintServiceStatus() });
    } catch (error) {
      sendJson(response, 503, {
        ok: false,
        error: error instanceof Error ? error.message : 'ModelView 局部重绘服务配置无效。',
      });
    }
    return true;
  }

  if (request.method === 'POST' && segments[2] === 'inpaint') {
    const input = await readJsonBody<ModelviewInpaintInput>(request);
    const controller = new AbortController();
    const abortRemoteRequest = () => controller.abort();
    request.once('aborted', abortRemoteRequest);
    response.once('close', abortRemoteRequest);
    try {
      const result = await generateModelviewInpaint(input, user.id, {
        signal: controller.signal,
      });
      if (!response.destroyed && !response.writableEnded) sendJson(response, 200, result);
    } catch (error) {
      if (response.destroyed || response.writableEnded) return true;
      sendJson(response, error instanceof ModelviewInpaintError ? error.httpStatus : 500, {
        error: error instanceof Error ? error.message : 'ModelView 局部重绘请求失败。',
        ...(error instanceof ModelviewInpaintError && error.remoteJobId
          ? { jobId: error.remoteJobId }
          : {}),
      });
    } finally {
      request.removeListener('aborted', abortRemoteRequest);
      response.removeListener('close', abortRemoteRequest);
    }
    return true;
  }

  return false;
}
