import type { Generation } from '@/types/generation';
import { getWorkspaceApiBase } from './workspaceApiBase';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

export type ModelviewInpaintInput = {
  clientGenerationId: string;
  projectId?: string;
  prompt?: string;
  captureId?: string;
  objectId?: string;
  image: {
    path: string;
    dataUrl: string;
  };
};

async function requestJson<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const { timeoutMs = 1_920_000, headers, signal, ...fetchInit } = init ?? {};
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

export function createModelviewApiClient() {
  return {
    async generateInpaint(
      input: ModelviewInpaintInput,
      options?: { signal?: AbortSignal },
    ): Promise<Generation> {
      const result = await requestJson<{
        id: string;
        resultUrl?: string;
        resultUrls?: string[];
        modelviewJobId?: string;
        modelviewClientId?: string;
        output?: unknown;
      }>('/api/modelview/inpaint', {
        method: 'POST',
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
          provider: 'modelview-seedvr2',
          workflow: 'local-repaint',
          clientGenerationId: input.clientGenerationId,
          serverJobId: result.modelviewJobId ?? result.id,
          projectId: input.projectId,
          modelviewJobId: result.modelviewJobId,
          modelviewClientId: result.modelviewClientId,
          resultUrls: result.resultUrls,
          output: result.output,
          objectId: input.objectId,
          serverSubmitted: true,
        },
      };
    },
  };
}
