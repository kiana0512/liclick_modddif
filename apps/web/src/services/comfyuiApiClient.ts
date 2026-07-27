import type { Generation } from '@/types/generation';
import { getWorkspaceApiBase } from './workspaceApiBase';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

export type ComfyControlFile = {
  path: string;
  dataUrl: string;
};

export type ComfyTextureMapInput = {
  clientGenerationId: string;
  projectId?: string;
  prompt: string;
  referenceIds: string[];
  captureId?: string;
  objectId?: string;
  materialReferenceId?: string;
  resolution?: '1K' | '2K' | '4K' | '8K';
  files: ComfyControlFile[];
  seed?: number;
};

export type ComfyInpaintInput = {
  clientGenerationId: string;
  projectId?: string;
  prompt?: string;
  captureId?: string;
  objectId?: string;
  image: ComfyControlFile;
  seed?: number;
};

export type ComfyStatus = {
  ok: boolean;
  baseUrl?: string;
  error?: string;
};

async function requestJson<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const { timeoutMs = 20 * 60 * 1000, headers, signal, ...fetchInit } = init ?? {};
  const requestHeaders = new Headers(headers);
  if (fetchInit.body && !requestHeaders.has('content-type'))
    requestHeaders.set('content-type', 'application/json');
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
          : `ComfyUI request failed: ${response.status}`;
      throw new Error(message);
    }
    return payload as T;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abortRequest);
  }
}

export function createComfyuiApiClient() {
  return {
    getStatus() {
      return requestJson<ComfyStatus>('/api/comfyui/status', { timeoutMs: 3000 });
    },
    async generateTextureMap(
      input: ComfyTextureMapInput,
      options?: { signal?: AbortSignal },
    ): Promise<Generation> {
      const result = await requestJson<{
        id: string;
        resultUrl?: string;
        resultUrls?: string[];
        promptId?: string;
        output?: unknown;
      }>('/api/comfyui/generate-texture-map', {
        method: 'POST',
        timeoutMs: 30 * 60 * 1000,
        signal: options?.signal,
        body: JSON.stringify(input),
      });
      return {
        id: input.clientGenerationId,
        mode: 'single',
        prompt: input.prompt,
        referenceIds: input.referenceIds,
        captureId: input.captureId,
        resultUrl: result.resultUrl,
        status: result.resultUrl ? 'succeeded' : 'failed',
        metadata: {
          provider: 'comfyui-local',
          workflow: 'texture-map',
          clientGenerationId: input.clientGenerationId,
          serverJobId: result.id,
          projectId: input.projectId,
          promptId: result.promptId,
          resultUrls: result.resultUrls,
          output: result.output,
          objectId: input.objectId,
          materialReferenceId: input.materialReferenceId,
          resolution: input.resolution,
          serverSubmitted: true,
        },
      };
    },
    async generateInpaint(
      input: ComfyInpaintInput,
      options?: { signal?: AbortSignal },
    ): Promise<Generation> {
      const result = await requestJson<{
        id: string;
        resultUrl?: string;
        resultUrls?: string[];
        promptId?: string;
        output?: unknown;
      }>('/api/comfyui/generate-inpaint', {
        method: 'POST',
        timeoutMs: 1920 * 1000,
        signal: options?.signal,
        body: JSON.stringify(input),
      });
      return {
        id: input.clientGenerationId,
        mode: 'inpaint',
        prompt: input.prompt ?? '',
        referenceIds: [],
        captureId: input.captureId,
        resultUrl: result.resultUrl,
        status: result.resultUrl ? 'succeeded' : 'failed',
        metadata: {
          provider: 'comfyui-local',
          workflow: 'local-repaint',
          clientGenerationId: input.clientGenerationId,
          serverJobId: result.id,
          projectId: input.projectId,
          promptId: result.promptId,
          resultUrls: result.resultUrls,
          output: result.output,
          objectId: input.objectId,
          serverSubmitted: true,
        },
      };
    },
    cancelTextureMap(jobId: string) {
      return requestJson<{ ok: boolean; cancelledJobId?: string }>('/api/comfyui/cancel', {
        method: 'POST',
        timeoutMs: 10_000,
        body: JSON.stringify({ jobId }),
      });
    },
  };
}
