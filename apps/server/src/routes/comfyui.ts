import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAuth } from '../auth/authMiddleware.js';
import { serverConfig } from '../config.js';
import {
  cancelComfyTextureMap,
  checkComfyInpaintServiceStatus,
  checkComfyuiStatus,
  generateComfyInpaint,
  generateComfyTextureMap,
  type ComfyInpaintInput,
  type ComfyTextureMapInput,
} from '../services/comfyuiGenerationService.js';
import { getPathSegments, readJsonBody, sendJson } from './httpUtils.js';

export async function handleComfyuiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  const segments = getPathSegments(url);
  if (segments[0] !== 'api' || segments[1] !== 'comfyui') return false;

  const user = await requireAuth(request, response);
  if (!user) return true;

  if (request.method === 'GET' && segments[2] === 'status') {
    try {
      await checkComfyuiStatus();
      sendJson(response, 200, { ok: true, baseUrl: serverConfig.comfyuiBaseUrl });
    } catch (error) {
      sendJson(response, 503, {
        ok: false,
        baseUrl: serverConfig.comfyuiBaseUrl,
        error: error instanceof Error ? error.message : 'ComfyUI 后端未启动。',
      });
    }
    return true;
  }

  if (request.method === 'GET' && segments[2] === 'inpaint-status') {
    try {
      const status = await checkComfyInpaintServiceStatus();
      sendJson(response, 200, {
        ok: true,
        serviceUrl: serverConfig.comfyuiInpaintServiceUrl,
        ...status,
      });
    } catch (error) {
      sendJson(response, 503, {
        ok: false,
        serviceUrl: serverConfig.comfyuiInpaintServiceUrl,
        error: error instanceof Error ? error.message : '局部重绘服务未启动。',
      });
    }
    return true;
  }

  if (request.method === 'POST' && segments[2] === 'generate-texture-map') {
    const input = await readJsonBody<ComfyTextureMapInput>(request);
    if (!input.prompt?.trim()) {
      sendJson(response, 400, { error: 'Prompt is required for ComfyUI texture generation.' });
      return true;
    }
    if (!Array.isArray(input.files) || input.files.length === 0) {
      sendJson(response, 400, { error: 'ComfyUI 控制图不能为空。' });
      return true;
    }
    const result = await generateComfyTextureMap(input, user.id);
    sendJson(response, 200, result);
    return true;
  }

  if (request.method === 'POST' && segments[2] === 'generate-inpaint') {
    const input = await readJsonBody<ComfyInpaintInput>(request);
    if (input.prompt && Array.from(input.prompt).length > 4096) {
      sendJson(response, 400, { error: '局部重绘提示词不能超过 4096 个字符。' });
      return true;
    }
    if (!input.image?.dataUrl) {
      sendJson(response, 400, { error: 'ComfyUI 局部重绘输入图不能为空。' });
      return true;
    }
    const result = await generateComfyInpaint(input, user.id);
    sendJson(response, 200, result);
    return true;
  }

  if (request.method === 'POST' && segments[2] === 'cancel') {
    const input = await readJsonBody<{ jobId?: string }>(request);
    try {
      const result = await cancelComfyTextureMap(input.jobId);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 202, {
        ok: false,
        cancelledJobId: input.jobId,
        error: error instanceof Error ? error.message : 'ComfyUI cancel failed.',
      });
    }
    return true;
  }

  return false;
}
