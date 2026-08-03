import type { GenerateTextureInput, Generation } from '@/types/generation';
import type { ReferenceImage } from '@/types/project';
import { getLocalTextureRuntimeApiBase } from './localTextureRuntimeClient';
import { invalidateCachedPersonalLiclickAccountStatus } from './liclickAccountApiClient';
import { getLocalIdentityProof } from './localIdentityProofApiClient';
import { getUserFacingGenerationError } from './generationErrorMessage';
import {
  prepareReferenceForAtlas,
  type ReferencePreprocessingResult,
} from './referenceImagePreprocessor';
import { mapWithConcurrency } from '@/utils/mapWithConcurrency';

const localLiclickApiBase = getLocalTextureRuntimeApiBase();

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
  onReferencePreprocessed?: (result: ReferencePreprocessingResult) => void;
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
  cancelGenerationJob(jobId: string): Promise<GenerationJobResult>;
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
  workflow?: 'liclick' | 'texture-map';
  model?: string;
  extraParams?: Record<string, unknown>;
  uploadedReferences?: unknown[];
  activeProjectJob?: boolean;
  message?: string;
  error?: string;
  startedAt?: string;
  updatedAt?: string;
};

async function prepareReferences(
  references: ReferenceImage[] = [],
  onReferencePreprocessed?: (result: ReferencePreprocessingResult) => void,
) {
  // Large references are decoded into full RGBA bitmaps. Limiting preparation
  // concurrency prevents several 4K images from freezing or exhausting the UI
  // process while preserving the same reference order and output.
  const prepared = await mapWithConcurrency(references, 2, prepareReferenceForAtlas);
  for (const reference of prepared) {
    if (reference.preprocessing) onReferencePreprocessed?.(reference.preprocessing);
  }
  return prepared;
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  init: RequestInit & { timeoutMs?: number },
) {
  const { timeoutMs = 8 * 60 * 1000, headers, ...fetchInit } = init;
  const requestHeaders = new Headers(headers);
  requestHeaders.set('x-li3d-identity-proof', await getLocalIdentityProof());
  if (fetchInit.body && !requestHeaders.has('content-type'))
    requestHeaders.set('content-type', 'application/json');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...fetchInit,
      signal: controller.signal,
      credentials: 'omit',
      headers: requestHeaders,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('莉刻生图服务响应超时，请稍后重试。');
    }
    throw new Error(`无法连接莉刻生图服务（${baseUrl}），请确认最新版本地贴图组件已启动。`);
  } finally {
    window.clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const errorCode =
      payload && typeof payload === 'object' && 'code' in payload && typeof payload.code === 'string'
        ? payload.code
        : undefined;
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 428 ||
      errorCode === 'LICLICK_ACCOUNT_EMAIL_MISMATCH'
    ) {
      invalidateCachedPersonalLiclickAccountStatus();
    }
    const rawMessage =
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : `Liclick request failed: ${response.status}`;
    throw new Error(getUserFacingGenerationError(rawMessage));
  }
  return payload as T;
}

export function createLiclickApiClient(config: LiclickApiConfig = {}): LiclickApiClient {
  const baseUrl = config.baseUrl ?? localLiclickApiBase;

  return {
    async generateTextureSingleView(input) {
      const preparedReferences = await prepareReferences(
        input.referenceImages,
        config.onReferencePreprocessed,
      );
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
        workflow?: 'liclick' | 'texture-map';
        message?: string;
      }>(baseUrl, '/api/liclick/generate-image', {
        method: 'POST',
        body: JSON.stringify({
          clientGenerationId: input.clientGenerationId,
          projectId: input.projectId,
          workflow: input.workflow,
          prompt: input.prompt,
          model: input.model,
          aspectRatio: input.aspectRatio,
          imageSize: input.imageSize,
          count: input.count,
          references: preparedReferences.map(({ id, name, url }) => ({ id, name, url })),
        }),
      });
      const generationId = input.clientGenerationId ?? result.id;
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
          serverJobId: result.id,
          projectId: input.projectId,
          workflow: input.workflow ?? result.workflow,
          taskId: result.taskId,
          model: result.model ?? input.model,
          resultUrls: result.resultUrls,
          extraParams: result.extraParams,
          uploadedReferences: result.uploadedReferences,
          activeProjectJob: result.activeProjectJob,
          serverMessage: result.message,
          referencePreprocessing: preparedReferences
            .map((reference) => reference.preprocessing)
            .filter((reference): reference is ReferencePreprocessingResult => Boolean(reference)),
          visibleOnly: input.visibleOnly,
          upscale: input.upscale,
          objectId: input.object?.id,
          resolution: input.resolution,
        },
      };
    },
    async getGenerationJob(jobId) {
      return requestJson<GenerationJobResult>(
        baseUrl,
        `/api/liclick/generate-image/${encodeURIComponent(jobId)}`,
        {
          method: 'GET',
          timeoutMs: 30_000,
        },
      );
    },
    async cancelGenerationJob(jobId) {
      return requestJson<GenerationJobResult>(
        baseUrl,
        `/api/liclick/generate-image/${encodeURIComponent(jobId)}`,
        {
          method: 'DELETE',
          timeoutMs: 30_000,
        },
      );
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
