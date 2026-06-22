import type { GenerateTextureInput, Generation } from '@/types/generation';
import type { ReferenceImage } from '@/types/project';
import { getWorkspaceApiBase } from './workspaceApiBase';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

export type LiclickImageModel =
  | 'gpt-image-2'
  | 'nano_banana_2'
  | 'nano_banana_pro'
  | 'gpt-image-1.5'
  | 'doubao-seedream-4-5-251128'
  | 'midjourney-7';

export type LiclickAspectRatio = 'auto' | '1:1' | '4:3' | '3:4' | '3:2' | '2:3' | '16:9' | '9:16';
export type LiclickImageSize = 'auto' | '1K' | '2K' | '4K';

export type LiclickApiConfig = {
  baseUrl?: string;
  getAccessToken?: () => Promise<string | undefined>;
};

export type LiclickGenerateTextureSingleViewInput = GenerateTextureInput & {
  clientGenerationId?: string;
  projectId?: string;
  prompt: string;
  mode: 'single';
  model?: LiclickImageModel;
  aspectRatio?: LiclickAspectRatio;
  imageSize?: LiclickImageSize;
  count?: number;
};

export type LiclickApiClient = {
  generateTextureSingleView(input: LiclickGenerateTextureSingleViewInput): Promise<Generation>;
  getGenerationJob(jobId: string): Promise<GenerationJobResult>;
  inpaint(input: GenerateTextureInput): Promise<Generation>;
  generateNormal(input: GenerateTextureInput): Promise<Generation>;
  generateMultiview(input: GenerateTextureInput): Promise<Generation>;
};

export type GenerationJobResult = {
  id: string;
  taskId?: string;
  status: Generation['status'];
  resultUrl?: string;
  resultUrls?: string[];
  model?: string;
  extraParams?: Record<string, unknown>;
  uploadedReferences?: unknown[];
  activeProjectJob?: boolean;
  message?: string;
  error?: string;
  startedAt?: string;
  updatedAt?: string;
};

async function urlToDataUrl(url: string) {
  if (url.startsWith('data:')) return url;
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`Could not read reference image: ${response.status}`);
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read reference image.'));
    reader.readAsDataURL(blob);
  });
}

async function prepareReferences(references: ReferenceImage[] = []) {
  return Promise.all(
    references.map(async (reference) => ({
      id: reference.id,
      name: reference.name,
      url: await urlToDataUrl(reference.url),
    })),
  );
}

async function requestJson<T>(baseUrl: string, path: string, init: RequestInit & { timeoutMs?: number }) {
  const { timeoutMs = 8 * 60 * 1000, headers, ...fetchInit } = init;
  const requestHeaders = new Headers(headers);
  if (fetchInit.body && !requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(`${baseUrl}${path}`, {
    ...fetchInit,
    signal: controller.signal,
    credentials: 'include',
    headers: requestHeaders,
  }).finally(() => window.clearTimeout(timeout));
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `Liclick request failed: ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export function createLiclickApiClient(config: LiclickApiConfig = {}): LiclickApiClient {
  const baseUrl = config.baseUrl ?? workspaceApiBase;

  return {
    async generateTextureSingleView(input) {
      const result = await requestJson<{
        id: string;
        taskId?: string;
        status: Generation['status'];
        resultUrl?: string;
        resultUrls?: string[];
        model?: string;
        extraParams?: Record<string, unknown>;
        uploadedReferences?: unknown[];
        activeProjectJob?: boolean;
        message?: string;
      }>(baseUrl, '/api/liclick/generate-image', {
        method: 'POST',
        body: JSON.stringify({
          clientGenerationId: input.clientGenerationId,
          projectId: input.projectId,
          prompt: input.prompt,
          model: input.model,
          aspectRatio: input.aspectRatio,
          imageSize: input.imageSize,
          count: input.count,
          references: await prepareReferences(input.referenceImages),
        }),
      });
      const generationId = result.activeProjectJob ? result.id : (input.clientGenerationId ?? result.id);
      return {
        id: generationId,
        mode: 'single',
        prompt: input.prompt,
        referenceIds: input.referenceIds,
        captureId: input.capture?.id,
        resultUrl: result.resultUrl,
        status: result.resultUrl ? 'succeeded' : result.status,
        metadata: {
          provider: 'liclick-atlas',
          clientGenerationId: input.clientGenerationId,
          projectId: input.projectId,
          taskId: result.taskId,
          model: result.model ?? input.model,
          resultUrls: result.resultUrls,
          extraParams: result.extraParams,
          uploadedReferences: result.uploadedReferences,
          activeProjectJob: result.activeProjectJob,
          serverMessage: result.message,
          visibleOnly: input.visibleOnly,
          upscale: input.upscale,
          objectId: input.object?.id,
          resolution: input.resolution,
        },
      };
    },
    async getGenerationJob(jobId) {
      return requestJson<GenerationJobResult>(baseUrl, `/api/liclick/generate-image/${encodeURIComponent(jobId)}`, {
        method: 'GET',
        timeoutMs: 30_000,
      });
    },
    async inpaint() {
      throw new Error('Liclick inpaint is not wired yet.');
    },
    async generateNormal() {
      throw new Error('Liclick normal generation is not wired yet.');
    },
    async generateMultiview() {
      throw new Error('Liclick multiview generation is not wired yet.');
    },
  };
}
