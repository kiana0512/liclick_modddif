import type { ProviderStatus } from './authApiClient';
import { invalidateCachedPersonalLiclickAccountStatus } from './liclickAccountApiClient';
import { getLocalIdentityProof } from './localIdentityProofApiClient';
import { resolveLiclickTransport, type LiclickTransport } from './liclickTransport';

export interface ImageEditProvider {
  startEditImage(params: ImageEditParams): Promise<ImageEditJobResult>;
  getEditImageJob(jobId: string): Promise<ImageEditJobResult>;
  cancelEditImageJob(jobId: string): Promise<ImageEditJobResult>;
  editImage(params: ImageEditParams): Promise<{
    outputImage: Blob;
    raw?: unknown;
  }>;
}

export type ImageEditParams = {
  clientEditId?: string;
  projectId?: string;
    image: Blob | File;
    mask: Blob | File;
    prompt: string;
    references?: (Blob | File)[];
    mode?: 'local_repaint' | 'image_edit';
    strength?: number;
    seed?: number;
    extra?: Record<string, unknown>;
    signal?: AbortSignal;
};

export type ImageEditJobResult = {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  taskId?: string;
  outputImage?: Blob;
  outputImageDataUrl?: string;
  resultUrl?: string;
  resultUrls?: string[];
  raw?: unknown;
  error?: string;
  startedAt?: string;
  updatedAt?: string;
  activeProjectJob?: boolean;
  message?: string;
};

type JsonRecord = Record<string, unknown>;

async function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image edit blob.'));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl: string) {
  const [header, encoded] = dataUrl.split(',');
  const mime = header?.match(/^data:([^;]+)/)?.[1] ?? 'image/png';
  const binary = atob(encoded ?? '');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

function readErrorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === 'object') {
    const error = (payload as JsonRecord).error;
    const message = (payload as JsonRecord).message;
    if (typeof error === 'string' && error.trim()) return error;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

function describeNetworkFailure(error: unknown, transport: LiclickTransport) {
  const serviceLabel = transport.kind === 'workspace' ? '本地登录服务' : '本地贴图组件';
  if (error instanceof DOMException && error.name === 'AbortError') {
    return `连接莉刻服务超时：${transport.baseUrl}`;
  }
  if (error instanceof TypeError) {
    return `无法连接莉刻服务：${transport.baseUrl}。请确认${serviceLabel}已启动。`;
  }
  return error instanceof Error ? error.message : '无法连接本地莉刻服务。';
}

async function requestJson<T>(
  transport: LiclickTransport,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
) {
  const { timeoutMs = 30_000, headers, signal, ...fetchInit } = init;
  const requestHeaders = new Headers(headers);
  if (transport.requiresIdentityProof) {
    requestHeaders.set('x-li3d-identity-proof', await getLocalIdentityProof());
  }
  const controller = new AbortController();
  const abortFromSignal = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abortFromSignal, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${transport.baseUrl}${path}`, {
      ...fetchInit,
      signal: controller.signal,
      credentials: transport.credentials,
      headers: requestHeaders,
    });
    const payload = (await response.json().catch(() => undefined)) as T | undefined;
    if (!response.ok) {
      const errorCode =
        payload && typeof payload === 'object' && 'code' in payload && typeof payload.code === 'string'
          ? payload.code
          : undefined;
      if (
        transport.kind === 'local-component' &&
        (response.status === 401 ||
          response.status === 403 ||
          response.status === 428 ||
          errorCode === 'LICLICK_ACCOUNT_EMAIL_MISMATCH')
      ) {
        invalidateCachedPersonalLiclickAccountStatus();
        throw new Error('请先在此电脑绑定你自己的莉刻账号，然后再使用局部重绘。');
      }
      if (transport.kind === 'workspace' && response.status === 401) {
        throw new Error('本地飞书/Atlas 登录已失效，请重新登录后再使用局部重绘。');
      }
      throw new Error(readErrorMessage(payload, `莉刻请求失败：${response.status}`));
    }
    return payload as T;
  } catch (error) {
    if (
      !(error instanceof TypeError) &&
      !(error instanceof DOMException && error.name === 'AbortError') &&
      !(error instanceof Error && /^Failed to fetch$/i.test(error.message))
    ) {
      throw error;
    }
    throw new Error(describeNetworkFailure(error, transport));
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromSignal);
  }
}

export class LiClickImageEditProvider implements ImageEditProvider {
  constructor(
    private readonly baseUrl?: string,
    private readonly providerStatus?: ProviderStatus,
  ) {}

  private resolveTransport() {
    return resolveLiclickTransport(this.providerStatus, this.baseUrl);
  }

  async startEditImage(params: ImageEditParams) {
    const transport = await this.resolveTransport();
    await requestJson(transport, '/api/health', { method: 'GET', timeoutMs: 8_000, signal: params.signal });
    const status = await requestJson<{ ok?: boolean; message?: string; tools?: string[] }>(
      transport,
      '/api/liclick/status',
      { method: 'GET', timeoutMs: 45_000, signal: params.signal },
    );
    if (!status?.ok) {
      throw new Error(status?.message || '莉刻 API 当前不可用，请重新登录或检查 Atlas gateway。');
    }
    if (status.tools && !status.tools.includes('generate_image')) {
      throw new Error('当前莉刻账号没有可用的 generate_image 工具，无法执行局部重绘。');
    }

    const payload = await requestJson<{
      id: string;
      status: ImageEditJobResult['status'];
      taskId?: string;
      outputImage?: string;
      resultUrl?: string;
      resultUrls?: string[];
      raw?: unknown;
      error?: string;
      startedAt?: string;
      updatedAt?: string;
      activeProjectJob?: boolean;
      message?: string;
    }>(
      transport,
      '/api/liclick/edit-image',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientEditId: params.clientEditId,
          projectId: params.projectId,
          image: await blobToDataUrl(params.image),
          mask: await blobToDataUrl(params.mask),
          prompt: params.prompt,
          references: await Promise.all((params.references ?? []).map(blobToDataUrl)),
          mode: params.mode ?? 'local_repaint',
          strength: params.strength,
          seed: params.seed,
          extra: params.extra,
        }),
        timeoutMs: 11 * 60 * 1000,
        signal: params.signal,
      },
    );
    if (payload.status === 'failed') throw new Error(payload.error ?? '莉刻局部重绘任务失败。');
    return {
      ...payload,
      outputImage: payload.outputImage ? dataUrlToBlob(payload.outputImage) : undefined,
      outputImageDataUrl: payload.outputImage,
    };
  }

  async getEditImageJob(jobId: string) {
    const transport = await this.resolveTransport();
    const payload = await requestJson<{
      id: string;
      status: ImageEditJobResult['status'];
      taskId?: string;
      outputImage?: string;
      resultUrl?: string;
      resultUrls?: string[];
      raw?: unknown;
      error?: string;
      startedAt?: string;
      updatedAt?: string;
    }>(transport, `/api/liclick/edit-image/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      timeoutMs: 30_000,
    });
    return {
      ...payload,
      outputImage: payload.outputImage ? dataUrlToBlob(payload.outputImage) : undefined,
      outputImageDataUrl: payload.outputImage,
    };
  }

  async cancelEditImageJob(jobId: string) {
    const transport = await this.resolveTransport();
    const payload = await requestJson<{
      id: string;
      status: ImageEditJobResult['status'];
      taskId?: string;
      outputImage?: string;
      error?: string;
      startedAt?: string;
      updatedAt?: string;
    }>(transport, `/api/liclick/edit-image/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
      timeoutMs: 30_000,
    });
    return {
      ...payload,
      outputImage: payload.outputImage ? dataUrlToBlob(payload.outputImage) : undefined,
      outputImageDataUrl: payload.outputImage,
    };
  }

  async editImage(params: ImageEditParams) {
    const job = await this.startEditImage(params);
    const jobId = job.taskId ?? job.id;
    if (job.status === 'succeeded' && job.outputImage) {
      return {
        outputImage: job.outputImage,
        raw: job.raw,
      };
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < 11 * 60 * 1000) {
      if (params.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
      const result = await this.getEditImageJob(jobId);
      if (result.status === 'failed') throw new Error(result.error ?? '莉刻局部重绘任务失败。');
      if (result.status === 'succeeded' && result.outputImage) {
        return {
          outputImage: result.outputImage,
          raw: result.raw,
        };
      }
    }
    throw new Error('等待莉刻局部重绘超时。');
  }
}

export const liclickImageEditProvider = new LiClickImageEditProvider();
