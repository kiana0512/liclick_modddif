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
  promptPolishEnabled?: boolean;
  mask: {
    path: string;
    dataUrl: string;
  };
};

export type ModelviewSingleViewInput = ModelviewGenerationInput;
export type ModelviewSingleViewInpaintInput = ModelviewInpaintInput;

type ModelviewResponse = {
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
        '2026.09.17-li3d4500-single-view-4step-r1',
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
        '2026.09.17-li3d4500-single-view-inpaint-2step-r1',
      );
    },
    async generateInpaint(
      input: ModelviewInpaintInput,
      options?: { signal?: AbortSignal },
    ): Promise<Generation> {
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
        '2026.09.17-li3d4500-defaultprompt-steps2-r1',
        'inpaint',
      );
    },
  };
}
