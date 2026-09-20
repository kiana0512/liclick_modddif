import type { GenerateTextureInput, Generation } from '@/types/generation';
import type { GenerationFraming } from '@liclick/contracts';
import type { ReferenceImage } from '@/types/project';
import type { ProviderStatus } from './authApiClient';
import { resolveLiclickTransport, type LiclickTransport } from './liclickTransport';
import { getUserFacingGenerationError } from './generationErrorMessage';
import {
  prepareReferenceForAtlas,
  type ReferencePreprocessingResult,
} from './referenceImagePreprocessor';
import { mapWithConcurrency } from '@/utils/mapWithConcurrency';
import { interactionSafeJsonResponse } from '@/engine/viewport/input';

export class LiclickApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly rawMessage: string;

  constructor(input: { status: number; code?: string; rawMessage: string; message: string }) {
    super(input.message);
    this.name = 'LiclickApiError';
    this.status = input.status;
    this.code = input.code;
    this.rawMessage = input.rawMessage;
  }
}

export type LiclickImageModel =
  | 'gpt-image-2.5-sunburst'
  | 'gpt-image-2.5-flare'
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
  providerStatus?: ProviderStatus;
  getAccessToken?: () => Promise<string | undefined>;
  onReferencePreprocessed?: (result: ReferencePreprocessingResult) => void;
};

export type PromptPolishInput = {
  prompt: string;
  context: 'general' | 'local-repaint';
  modelName?: string;
  objectName?: string;
  referenceNames?: string[];
  hasMask?: boolean;
  currentEffectImage?: PromptPolishImageInput;
  maskImage?: PromptPolishImageInput;
  referenceImage?: PromptPolishImageInput;
};

export type PromptPolishImageInput = {
  name: string;
  dataUrl: string;
};

export type LiclickGenerateTextureSingleViewInput = GenerateTextureInput & {
  /** Local preparation only: aligned geometry guides must not be resampled. */
  pixelExactReferenceIds?: string[];
  signal?: AbortSignal;
  referencePipeline?: 'six-view-delight-v1' | 'delight-only-v1';
  clientGenerationId?: string;
  projectId?: string;
  prompt: string;
  mode: 'single';
  model?: LiclickImageModel;
  aspectRatio?: LiclickAspectRatio;
  imageSize?: LiclickImageSize;
  quality?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  count?: number;
};

export type LiclickApiClient = {
  polishPrompt(input: PromptPolishInput): Promise<string>;
  generateTextureSingleView(input: LiclickGenerateTextureSingleViewInput): Promise<Generation>;
  getGenerationJob(
    jobId: string,
    options?: { signal?: AbortSignal },
  ): Promise<GenerationJobResult>;
  listGenerationJobs(projectId: string): Promise<GenerationJobListItem[]>;
  cancelGenerationJob(jobId: string): Promise<GenerationJobResult>;
  inpaint(input: GenerateTextureInput): Promise<Generation>;
  generateNormal(input: GenerateTextureInput): Promise<Generation>;
  generateMultiview(input: GenerateTextureInput): Promise<Generation>;
};

export type GenerationJobResult = {
  framing?: GenerationFraming;
  framingRestored?: boolean;
  id: string;
  taskId?: string;
  status: Generation['status'];
  resultUrl?: string;
  resultUrls?: string[];
  workflow?: 'liclick' | 'texture-map' | 'local-repaint';
  model?: string;
  extraParams?: Record<string, unknown>;
  uploadedReferences?: unknown[];
  activeProjectJob?: boolean;
  message?: string;
  error?: string;
  startedAt?: string;
  updatedAt?: string;
};

export type GenerationJobListItem = GenerationJobResult & {
  projectId: string;
  clientGenerationId?: string;
  prompt: string;
  referenceIds: string[];
  params?: {
    aspectRatio?: LiclickAspectRatio;
    imageSize?: LiclickImageSize;
    quality?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    count?: number;
  };
};

async function prepareReferences(
  references: ReferenceImage[] = [],
  onReferencePreprocessed?: (result: ReferencePreprocessingResult) => void,
  pixelExactReferenceIds: string[] = [],
) {
  // Large references are decoded into full RGBA bitmaps. Limiting preparation
  // concurrency prevents several 4K images from freezing or exhausting the UI
  // process while preserving the same reference order and output.
  const prepared = await mapWithConcurrency(references, 2, (reference) =>
    prepareReferenceForAtlas(reference, { preservePixels: pixelExactReferenceIds.includes(reference.id) }),
  );
  for (const reference of prepared) {
    if (reference.preprocessing) onReferencePreprocessed?.(reference.preprocessing);
  }
  return prepared;
}

async function requestJson<T>(
  transport: LiclickTransport,
  path: string,
  init: RequestInit & { timeoutMs?: number },
) {
  const {
    timeoutMs = 8 * 60 * 1000,
    headers,
    signal: callerSignal,
    ...fetchInit
  } = init;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const requestHeaders = new Headers(headers);
  let response: Response;
  try {
    if (fetchInit.body && !requestHeaders.has('content-type'))
      requestHeaders.set('content-type', 'application/json');
    const requestUrl = `${transport.baseUrl}${path}`;
    const requestInit = {
      ...fetchInit,
      signal: controller.signal,
      credentials: transport.credentials,
      headers: requestHeaders,
    } satisfies RequestInit;
    response = await fetch(requestUrl, requestInit);
  } catch (error) {
    if (callerSignal?.aborted) throw error;
    if (timedOut || (error instanceof DOMException && error.name === 'AbortError')) {
      throw new Error('莉刻生图服务响应超时，请稍后重试。');
    }
    if (error instanceof Error && !(error instanceof TypeError)) throw error;
    throw new Error(`无法连接云端莉刻生图服务（${transport.baseUrl}），请检查网络或服务状态。`);
  } finally {
    window.clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
  const payload = await interactionSafeJsonResponse<unknown>(response);
  if (!response.ok) {
    const errorCode =
      payload && typeof payload === 'object' && 'code' in payload && typeof payload.code === 'string'
        ? payload.code
        : undefined;
    const rawMessage =
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : `Liclick request failed: ${response.status}`;
    throw new LiclickApiError({
      status: response.status,
      code: errorCode,
      rawMessage,
      message: getUserFacingGenerationError(rawMessage),
    });
  }
  return payload as T;
}

export async function restoreFramedJobResult<T extends { resultUrl?: string; resultUrls?: string[]; framing?: GenerationFraming; framingRestored?: boolean; workflow?: 'liclick' | 'texture-map' | 'local-repaint' }>(result: T, signal?: AbortSignal, workflow = result.workflow): Promise<T> {
  if (!result.resultUrl || !result.framing || result.framingRestored) return result;
  const { restoreContentFraming } = await import('@/engine/generation/contentFramingRestore');
  const urls = [...new Set([result.resultUrl, ...(result.resultUrls ?? [])])];
  const policy = workflow === 'texture-map' ? 'capture-mask' : 'strict';
  const restored = await mapWithConcurrency(urls, 1, url => restoreContentFraming(url, result.framing!, signal, policy));
  signal?.throwIfAborted();
  return { ...result, resultUrl: restored[0], resultUrls: restored, framingRestored: true };
}

export function createLiclickApiClient(config: LiclickApiConfig = {}): LiclickApiClient {
  const getTransport = () => resolveLiclickTransport(config.providerStatus, config.baseUrl);

  return {
    async polishPrompt(input) {
      const result = await requestJson<{ polishedPrompt: string }>(
        await getTransport(),
        '/api/liclick/prompt-polish',
        {
          method: 'POST',
          body: JSON.stringify(input),
          timeoutMs: 80_000,
        },
      );
      if (!result.polishedPrompt?.trim()) throw new Error('智能润色没有返回可用结果。');
      return result.polishedPrompt.trim();
    },
    async generateTextureSingleView(input) {
      input.signal?.throwIfAborted();
      const adaptive = input.capture && !input.referencePipeline &&
        ['texture-map', 'local-repaint'].includes(input.workflow ?? '') &&
        ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'].includes(input.model ?? '');
      const framed = adaptive ? await (await import('@/engine/generation/contentFramingImages')).prepareContentFraming(input) : undefined;
      const preparedReferences = await prepareReferences(
        framed?.references ?? input.referenceImages,
        config.onReferencePreprocessed,
        framed?.exactIds ?? input.pixelExactReferenceIds,
      );
      input.signal?.throwIfAborted();
      const response = await requestJson<{
        framing?: GenerationFraming;
        framingRestored?: boolean;
        id: string;
        taskId?: string;
        status: Generation['status'];
        resultUrl?: string;
        resultUrls?: string[];
        model?: string;
        extraParams?: Record<string, unknown>;
        uploadedReferences?: unknown[];
        activeProjectJob?: boolean;
        workflow?: 'liclick' | 'texture-map' | 'local-repaint';
        message?: string;
        startedAt?: string;
      }>(await getTransport(), '/api/liclick/generate-image', {
        method: 'POST',
        signal: input.signal,
        body: JSON.stringify({
          clientGenerationId: input.clientGenerationId,
          projectId: input.projectId,
          workflow: input.workflow,
          prompt: input.prompt,
          model: input.model,
          aspectRatio: input.aspectRatio,
          framing: framed?.framing,
          imageSize: input.imageSize,
          quality: input.quality,
          referencePipeline: input.referencePipeline,
          count: input.count,
          references: preparedReferences.map(({ id, name, url }) => ({ id, name, url })),
        }),
      });
      const result = await restoreFramedJobResult(response, input.signal, input.workflow);
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
          generationFraming: result.framing,
          framingRestored: result.framingRestored,
          projectId: input.projectId,
          workflow: input.workflow ?? result.workflow,
          taskId: result.taskId,
          model: result.model ?? input.model,
          resultUrls: result.resultUrls,
          extraParams: result.extraParams,
          uploadedReferences: result.uploadedReferences,
          activeProjectJob: result.activeProjectJob,
          serverMessage: result.message,
          startedAt: result.startedAt,
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
    async getGenerationJob(jobId, options = {}) {
      const result = await requestJson<GenerationJobResult>(
        await getTransport(),
        `/api/liclick/generate-image/${encodeURIComponent(jobId)}`,
        {
          method: 'GET',
          cache: 'no-store',
          signal: options.signal,
          timeoutMs: 12_000,
        },
      );
      return restoreFramedJobResult(result, options.signal);
    },
    async listGenerationJobs(projectId) {
      const result = await requestJson<{ jobs: GenerationJobListItem[] }>(
        await getTransport(),
        `/api/liclick/generate-image?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'GET',
          cache: 'no-store',
          timeoutMs: 30_000,
        },
      );
      return Array.isArray(result.jobs) ? result.jobs : [];
    },
    async cancelGenerationJob(jobId) {
      return requestJson<GenerationJobResult>(
        await getTransport(),
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
