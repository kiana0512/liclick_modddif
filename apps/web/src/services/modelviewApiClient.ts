import type { Generation } from '@/types/generation';
import { getWorkspaceApiBase } from './workspaceApiBase';

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

export type ModelviewInpaintInput = ModelviewGenerationInput & {
  mask: {
    path: string;
    dataUrl: string;
  };
};

export type ModelviewSingleViewInput = ModelviewGenerationInput;
export type ModelviewSingleViewInpaintInput = ModelviewInpaintInput;

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
    async generateSingleView(
      input: ModelviewSingleViewInput,
      options?: { signal?: AbortSignal },
    ): Promise<Generation> {
      const result = await requestJson<{
        id: string;
        resultUrl?: string;
        resultUrls?: string[];
        modelviewJobId?: string;
        modelviewClientId?: string;
        output?: unknown;
      }>('/api/modelview/single-view', {
        method: 'POST',
        signal: options?.signal,
        body: JSON.stringify(input),
      });
      return {
        id: input.clientGenerationId,
        mode: 'single',
        prompt: input.prompt ?? '',
        referenceIds: [input.modelViewReferenceId, input.materialReferenceId].filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ),
        captureId: input.captureId,
        resultUrl: result.resultUrl,
        status: result.resultUrl ? 'succeeded' : 'failed',
        metadata: {
          provider: 'modelview-single-view',
          workflow: 'texture-map',
          modelviewWorkflow: '2026.08.26-c0e6218-single-view-4step-r1',
          clientGenerationId: input.clientGenerationId,
          serverJobId: result.modelviewJobId ?? result.id,
          projectId: input.projectId,
          modelviewJobId: result.modelviewJobId,
          modelviewClientId: result.modelviewClientId,
          resultUrls: result.resultUrls,
          output: result.output,
          objectId: input.objectId,
          materialReferenceId: input.materialReferenceId,
          materialReferenceGroupId: input.materialReferenceGroupId,
          materialReferenceName: input.materialReferenceName,
          materialReferenceRole: input.materialReferenceRole,
          singleViewProvider: 'remote',
          serverSubmitted: true,
        },
      };
    },
    async generateSingleViewInpaint(
      input: ModelviewSingleViewInpaintInput,
      options?: { signal?: AbortSignal },
    ): Promise<Generation> {
      const result = await requestJson<{
        id: string;
        resultUrl?: string;
        resultUrls?: string[];
        modelviewJobId?: string;
        modelviewClientId?: string;
        output?: unknown;
      }>('/api/modelview/single-view-inpaint', {
        method: 'POST',
        signal: options?.signal,
        body: JSON.stringify(input),
      });
      return {
        id: input.clientGenerationId,
        mode: 'single',
        prompt: input.prompt ?? '',
        referenceIds: [input.modelViewReferenceId, input.materialReferenceId].filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ),
        captureId: input.captureId,
        resultUrl: result.resultUrl,
        status: result.resultUrl ? 'succeeded' : 'failed',
        metadata: {
          provider: 'modelview-single-view-inpaint',
          workflow: 'texture-map',
          modelviewWorkflow: '2026.08.31-e39ed5f-single-view-inpaint-4input-rseed-steps2-r1',
          clientGenerationId: input.clientGenerationId,
          serverJobId: result.modelviewJobId ?? result.id,
          projectId: input.projectId,
          modelviewJobId: result.modelviewJobId,
          modelviewClientId: result.modelviewClientId,
          resultUrls: result.resultUrls,
          output: result.output,
          objectId: input.objectId,
          materialReferenceId: input.materialReferenceId,
          materialReferenceGroupId: input.materialReferenceGroupId,
          materialReferenceName: input.materialReferenceName,
          materialReferenceRole: input.materialReferenceRole,
          singleViewProvider: 'remote',
          singleViewInputMode: 'existing-texture-completion',
          serverSubmitted: true,
        },
      };
    },
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
          provider: 'modelview-int8',
          workflow: 'local-repaint',
          modelviewWorkflow: '2026.08.28-cd48a78-truev3-gguf-mask-4input-rseed-r1',
          clientGenerationId: input.clientGenerationId,
          serverJobId: result.modelviewJobId ?? result.id,
          projectId: input.projectId,
          modelviewJobId: result.modelviewJobId,
          modelviewClientId: result.modelviewClientId,
          resultUrls: result.resultUrls,
          output: result.output,
          objectId: input.objectId,
          materialReferenceId: input.materialReferenceId,
          materialReferenceGroupId: input.materialReferenceGroupId,
          materialReferenceName: input.materialReferenceName,
          materialReferenceRole: input.materialReferenceRole,
          serverSubmitted: true,
        },
      };
    },
  };
}
