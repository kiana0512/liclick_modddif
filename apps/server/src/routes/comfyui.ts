import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAuth } from '../auth/authMiddleware.js';
import { serverConfig } from '../config.js';
import {
  cancelComfyTextureMap,
  checkComfyMaterialRepaintStatus,
  checkComfyuiStatus,
  comfyCancelErrorStatus,
  generateComfyMaterialRepaint,
  generateComfyTextureMap,
  type ComfyMaterialRepaintInput,
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

  if (request.method === 'GET' && segments[2] === 'material-repaint-status') {
    try {
      const result = await checkComfyMaterialRepaintStatus();
      sendJson(response, 200, result);
    } catch (error) {
      console.error('[ComfyUI Material Repaint] health check failed', error);
      sendJson(response, 503, {
        ok: false,
        code: 'MATERIAL_REPAINT_COMFY_UNREACHABLE',
        baseUrl: serverConfig.comfyuiMaterialRepaintBaseUrl,
        error: '局部重绘工作流服务未启动或端口不可达，请联系管理员启动服务后重试。',
        detail: error instanceof Error ? error.message : undefined,
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

  if (request.method === 'POST' && segments[2] === 'generate-material-repaint') {
    const input = await readJsonBody<ComfyMaterialRepaintInput>(request);
    if (!input.whiteModel?.dataUrl || !input.materialReference?.dataUrl) {
      sendJson(response, 400, {
        error: '局部重绘需要当前视角白模图和多视图材质参考图。',
      });
      return true;
    }
    try {
      const result = await generateComfyMaterialRepaint(input, user.id);
      sendJson(response, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : '局部重绘工作流执行失败。';
      const unreachable = /ComfyUI 后端未启动或无法连接|fetch failed|ECONN/i.test(message);
      console.error('[ComfyUI Material Repaint] generation failed', error);
      sendJson(response, unreachable ? 503 : 500, {
        code: unreachable ? 'MATERIAL_REPAINT_COMFY_UNREACHABLE' : 'MATERIAL_REPAINT_COMFY_FAILED',
        error: unreachable
          ? '局部重绘工作流服务未启动或端口不可达，请联系管理员启动服务后重试。'
          : message,
        detail: message,
      });
    }
    return true;
  }

  if (request.method === 'POST' && segments[2] === 'cancel') {
    const input = await readJsonBody<{ jobId?: string }>(request);
    const jobId = input.jobId?.trim();
    if (!jobId) {
      sendJson(response, 400, { error: 'ComfyUI cancel requires a non-empty jobId.' });
      return true;
    }
    try {
      const result = await cancelComfyTextureMap(jobId, user.id);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, comfyCancelErrorStatus(error), {
        ok: false,
        cancelledJobId: jobId,
        error: error instanceof Error ? error.message : 'ComfyUI cancel failed.',
      });
    }
    return true;
  }

  return false;
}
