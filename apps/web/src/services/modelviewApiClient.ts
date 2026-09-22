import type { Generation } from '@/types/generation';
import type { Capture } from '@/types/capture';
import { urlToDataUrl } from './workspaceApiClient';
import { getWorkspaceApiBase } from './workspaceApiBase';
import { personalRepaintEnabled } from './personalRepaintMode';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

type ModelviewGenerationInput = {
  clientGenerationId: string;
  projectId?: string;
  prompt?: string;
  captureId?: string;
  objectId?: string;
  image: {
    path: string;
    dataUrl: string;
  };
  materialImage: {
    path: string;
    dataUrl: string;
  };
  materialReferenceId?: string;
  materialReferenceGroupId?: string;
  materialReferenceName?: string;
  materialReferenceRole?: 'multi-view' | 'single-view';
  modelViewReferenceId?: string;
};

export type ModelviewSingleViewInpaintInput = ModelviewGenerationInput & {
  resultBlend?: { version: 1; currentImage: { path: string; dataUrl: string };
    objectMask: { path: string; dataUrl: string };
    camera: { projection: 'perspective' | 'orthographic'; projectionMatrix: number[] } };
  promptPolishEnabled?: boolean;
  normalImage: { path: string; dataUrl: string };
  mask: {
    path: string;
    dataUrl: string;
  };
};

type ModelviewNormalInput = { normalImage: { path: string; dataUrl: string } };
export type ModelviewSingleViewInput = ModelviewGenerationInput & ModelviewNormalInput;
export type ModelviewInpaintInput = ModelviewSingleViewInpaintInput;

type ModelviewResponse = {
  resultComposition?: string;
  rawResultUrl?: string;
  resultBlendMaskUrl?: string;
  resultBlendBaseUrl?: string;
  id: string;
  resultUrl?: string;
  resultUrls?: string[];
  modelviewJobId?: string;
  modelviewClientId?: string;
  output?: unknown;
};

async function requestJson<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const { timeoutMs = 2_760_000, headers, signal, ...fetchInit } = init ?? {};
  const requestHeaders = new Headers(headers);
  if (fetchInit.body && !requestHeaders.has('content-type')) {
    requestHeaders.set('content-type', 'application/json');
  }
  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abortRequest, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${workspaceApiBase}${path}`, {
      ...fetchInit,
      signal: controller.signal,
      credentials: 'include',
      headers: requestHeaders,
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message =
        payload &&
        typeof payload === 'object' &&
        'error' in payload &&
        typeof payload.error === 'string'
          ? payload.error
          : `ModelView request failed: ${response.status}`;
      throw new Error(message);
    }
    return payload as T;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abortRequest);
  }
}

export async function getGenerationServerLabel(provider: unknown, signal?: AbortSignal): Promise<string> {
  if (provider === 'autodl-personal') return 'AutoDL · pro-78993043bdb0';
  const routes: Record<string, string> = {
    'modelview-int8': 'status',
    'modelview-single-view': 'single-view/status',
    'modelview-single-view-inpaint': 'single-view-inpaint/status',
  };
  const route = typeof provider === 'string' ? routes[provider] : undefined;
  if (!route) return provider === 'liclick-atlas' ? '莉刻服务 · 算力服务器未公开' : '服务器信息暂不可用';
  try {
    const status = await requestJson<{ serviceUrl: string }>(`/api/modelview/${route}`, { signal, timeoutMs: 10000 });
    return `LI3D 后端 · ${new URL(status.serviceUrl).host}`;
  } catch {
    return 'LI3D 后端 · 服务器信息暂不可用';
  }
}

function toGeneration(
  input: ModelviewGenerationInput,
  result: ModelviewResponse,
  provider: string,
  modelviewWorkflow: string,
  mode: Generation['mode'] = 'single',
): Generation {
  return {
    id: input.clientGenerationId,
    mode,
    prompt: input.prompt ?? '',
    referenceIds:
      mode === 'inpaint'
        ? []
        : [input.modelViewReferenceId, input.materialReferenceId].filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          ),
    captureId: input.captureId,
    resultUrl: result.resultUrl,
    status: result.resultUrl ? 'succeeded' : 'failed',
    metadata: {
      provider,
      workflow: mode === 'inpaint' ? 'local-repaint' : 'texture-map',
      modelviewWorkflow,
      clientGenerationId: input.clientGenerationId,
      serverJobId: result.modelviewJobId ?? result.id,
      projectId: input.projectId,
      modelviewJobId: result.modelviewJobId,
      modelviewClientId: result.modelviewClientId,
      resultUrls: result.resultUrls,
      output: result.output,
      ...(result.resultComposition ? { resultComposition: result.resultComposition,
        rawResultUrl: result.rawResultUrl, resultBlendMaskUrl: result.resultBlendMaskUrl,
        resultBlendBaseUrl: result.resultBlendBaseUrl } : {}),
      objectId: input.objectId,
      materialReferenceId: input.materialReferenceId,
      materialReferenceGroupId: input.materialReferenceGroupId,
      materialReferenceName: input.materialReferenceName,
      materialReferenceRole: input.materialReferenceRole,
      ...(mode === 'single' ? { singleViewProvider: 'remote' } : {}),
      ...(provider === 'modelview-single-view-inpaint'
        ? { singleViewInputMode: 'existing-texture-completion' }
        : {}),
      serverSubmitted: true,
    },
  };
}

export function createModelviewApiClient() {
  return {
    async prepareResultBlend(currentEffectUrl: string | undefined, capture: Capture, signal?: AbortSignal): Promise<NonNullable<ModelviewSingleViewInpaintInput['resultBlend']>> {
      if (!currentEffectUrl) throw new Error('生成前的当前视角图不可用，请重新捕获。');
      signal?.throwIfAborted();
      const [current, objectMask] = await Promise.all([urlToDataUrl(currentEffectUrl), urlToDataUrl(capture.maskUrl)]);
      signal?.throwIfAborted();
      return { version: 1,
        currentImage: { path: `${capture.id}-blend-base.png`, dataUrl: current },
        objectMask: { path: `${capture.id}-object-mask.png`, dataUrl: objectMask },
        camera: { projection: capture.camera.projection, projectionMatrix: [...capture.camera.projectionMatrix] },
      };
    },
    async generateSingleView(
      input: ModelviewSingleViewInput,
      options?: { signal?: AbortSignal },
    ): Promise<Generation> {
      const result = await requestJson<ModelviewResponse>('/api/modelview/single-view', {
        method: 'POST',
        signal: options?.signal,
        body: JSON.stringify(input),
      });
      return toGeneration(
        input,
        result,
        'modelview-single-view',
        '2026.09.18-refcontrol-normal-single-view-4step-r1',
      );
    },
    async generateSingleViewInpaint(
      input: ModelviewSingleViewInpaintInput,
      options?: { signal?: AbortSignal },
    ): Promise<Generation> {
      const result = await requestJson<ModelviewResponse>('/api/modelview/single-view-inpaint', {
        method: 'POST',
        signal: options?.signal,
        body: JSON.stringify(input),
      });
      return toGeneration(
        input,
        result,
        'modelview-single-view-inpaint',
        '2026.09.18-refcontrol-normal-single-view-inpaint-2step-r1',
      );
    },
    async generateInpaint(
      input: ModelviewInpaintInput,
      options?: { signal?: AbortSignal; onStatus?: (status: string) => void },
    ): Promise<Generation> {
      if (personalRepaintEnabled) {
        const { generatePersonalRepaint } = await import('./personalRepaintClient');
        const result = await generatePersonalRepaint(input, options?.signal, options?.onStatus);
        const generation = toGeneration(input, result, 'autodl-personal', result.workflow, 'inpaint');
        generation.metadata.personalRepaintTimings = result.timings;
        return generation;
      }
      const result = await requestJson<ModelviewResponse>('/api/modelview/inpaint', {
        method: 'POST',
        timeoutMs: 2_760_000,
        signal: options?.signal,
        body: JSON.stringify(input),
      });
      return toGeneration(
        input,
        result,
        'modelview-int8',
        '2026.09.18-refcontrol-normal-4step-r1',
        'inpaint',
      );
    },
  };
}
