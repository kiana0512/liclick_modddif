import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { createHash, randomUUID } from 'node:crypto';
import { serverConfig } from '../config.js';
import { gpuControlLanCa } from '../certs/gpuControlLanCa.js';
import {
  maxLocalAssetBytes,
  saveBinaryAsset,
  saveUserRecoveryAsset,
} from './assetFileService.js';

type ModelviewControlFile = {
  path: string;
  dataUrl: string;
};

export type ModelviewInpaintInput = {
  clientGenerationId?: string;
  projectId?: string;
  prompt?: string;
  image: ModelviewControlFile;
  materialImage: ModelviewControlFile;
  viewportReference: ModelviewControlFile;
};

type RemoteResponse = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

export class ModelviewInpaintError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 500,
    readonly remoteJobId?: string,
  ) {
    super(message);
  }
}

function inpaintUrl() {
  const url = new URL(serverConfig.modelviewInpaintUrl);
  const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new ModelviewInpaintError('ModelView 局部重绘接口必须使用 HTTPS。', 500);
  }
  return url;
}

function inpaintTrust() {
  const configuredPath =
    serverConfig.modelviewInpaintCaPath || process.env.NODE_EXTRA_CA_CERTS?.trim() || '';
  const candidates = configuredPath
    ? [path.resolve(configuredPath)]
    : [
        path.join(serverConfig.workspaceDir, 'config', 'GPU_CONTROL_LAN_CA.crt'),
        path.join(serverConfig.repoRoot, 'config', 'GPU_CONTROL_LAN_CA.crt'),
        path.join(serverConfig.repoRoot, 'secrets', 'GPU_CONTROL_LAN_CA.crt'),
        path.join(serverConfig.repoRoot, 'GPU_CONTROL_LAN_CA.crt'),
        ...(process.env.USERPROFILE
          ? [path.join(process.env.USERPROFILE, 'Downloads', 'GPU_CONTROL_LAN_CA.crt')]
          : []),
      ];
  const caPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (configuredPath && !caPath) {
    throw new ModelviewInpaintError(`ModelView 局域网 CA 不存在：${candidates[0]}`, 500);
  }
  if (caPath) {
    return [...tls.rootCertificates, fs.readFileSync(caPath, 'utf8')];
  }

  const getCACertificates = (
    tls as typeof tls & {
      getCACertificates?: (type?: 'default' | 'system' | 'bundled' | 'extra') => string[];
    }
  ).getCACertificates;
  if (getCACertificates) {
    return Array.from(
      new Set([
        ...getCACertificates('default'),
        ...getCACertificates('system'),
        gpuControlLanCa,
      ]),
    );
  }
  return [...tls.rootCertificates, gpuControlLanCa];
}

const maxModelviewImageBytes = 50 * 1024 * 1024;
const supportedModelviewImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

function dataUrlToBuffer(dataUrl: string, label: string) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new ModelviewInpaintError(`${label}不是有效的图片 data URL。`, 422);
  const mime = (match[1] || 'image/png').toLowerCase();
  if (!supportedModelviewImageTypes.has(mime)) {
    throw new ModelviewInpaintError(`${label}必须是 PNG、JPG、JPEG 或 WEBP 图片。`, 422);
  }
  const payload = match[3] ?? '';
  const buffer = match[2]
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  if (!buffer.byteLength) throw new ModelviewInpaintError(`${label}不能为空。`, 422);
  if (buffer.byteLength > maxModelviewImageBytes) {
    throw new ModelviewInpaintError(`${label}不能超过 50 MiB。`, 413);
  }
  return { mime, buffer };
}

function safeFilename(value: string, fallback: string) {
  const filename = path.basename(value.replaceAll('\\', '/'));
  const safe = filename.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '');
  return safe || fallback;
}

function createIdempotencyKey(jobId: string) {
  const stableId = jobId.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 160) || randomUUID();
  return `${stableId}:inpaint:3input-r2:attempt-1`;
}

function multipartBody(input: {
  boundary: string;
  files: Array<{
    field: 'image' | 'material_image' | 'viewport_reference';
    filename: string;
    mime: string;
    image: Buffer;
  }>;
  prompt?: string;
}) {
  const chunks: Buffer[] = [];
  input.files.forEach((file) => {
    chunks.push(
      Buffer.from(
        `--${input.boundary}\r\n` +
          `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.mime}\r\n\r\n`,
        'utf8',
      ),
      file.image,
      Buffer.from('\r\n', 'utf8'),
    );
  });
  if (input.prompt) {
    chunks.push(
      Buffer.from(
        `--${input.boundary}\r\n` +
          'Content-Disposition: form-data; name="prompt"\r\n' +
          'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
          `${input.prompt}\r\n`,
        'utf8',
      ),
    );
  }
  chunks.push(Buffer.from(`--${input.boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function requestInpaint(body: Buffer, boundary: string, idempotencyKey: string, signal?: AbortSignal) {
  const url = inpaintUrl();
  const timeoutMs = serverConfig.modelviewInpaintTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ModelviewInpaintError('ModelView 局部重绘超时配置无效。', 500);
  }
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise<RemoteResponse>((resolve, reject) => {
    let settled = false;
    let connectTimer: NodeJS.Timeout | undefined;
    const totalTimer = setTimeout(() => {
      request.destroy(new Error(`ModelView 局部重绘等待超过 ${Math.round(timeoutMs / 1000)} 秒。`));
    }, timeoutMs);
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      if (connectTimer) clearTimeout(connectTimer);
      signal?.removeEventListener('abort', abortRequest);
      callback();
    };
    const abortRequest = () => request.destroy(new Error('ModelView 局部重绘请求已取消。'));
    const headers: Record<string, string | number> = {
      accept: 'image/png',
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': body.byteLength,
      'idempotency-key': idempotencyKey,
      ...(serverConfig.modelviewInpaintApiKey
        ? { 'x-api-key': serverConfig.modelviewInpaintApiKey }
        : {}),
    };
    const request = transport.request(
      url,
      {
        method: 'POST',
        headers,
        ...(url.protocol === 'https:'
          ? { ca: inpaintTrust(), rejectUnauthorized: true }
          : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on('data', (chunk: Buffer) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.byteLength;
          if (totalBytes > maxLocalAssetBytes) {
            response.destroy(new Error('ModelView 局部重绘响应图片过大。'));
            return;
          }
          chunks.push(buffer);
        });
        response.once('error', (error) => settle(() => reject(error)));
        response.once('end', () =>
          settle(() =>
            resolve({
              statusCode: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks, totalBytes),
            }),
          ),
        );
      },
    );
    request.once('socket', (socket) => {
      connectTimer = setTimeout(() => {
        request.destroy(new Error('连接 ModelView 局部重绘服务超过 10 秒。'));
      }, 10_000);
      socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = undefined;
      });
    });
    request.once('error', (error) => settle(() => reject(error)));
    if (signal?.aborted) {
      abortRequest();
      return;
    }
    signal?.addEventListener('abort', abortRequest, { once: true });
    request.end(body);
  });
}

function responseErrorMessage(response: RemoteResponse) {
  const text = response.body.toString('utf8').trim();
  if (!text) return `ModelView 局部重绘请求失败：HTTP ${response.statusCode}`;
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const detail = payload.detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const message = (detail as Record<string, unknown>).message;
      if (typeof message === 'string' && message) return message;
    }
    if (Array.isArray(detail)) {
      const messages = detail
        .map((item) =>
          item &&
          typeof item === 'object' &&
          typeof (item as Record<string, unknown>).msg === 'string'
            ? String((item as Record<string, unknown>).msg)
            : '',
        )
        .filter(Boolean);
      if (messages.length) return messages.join('；');
    }
    for (const key of ['detail', 'error', 'message']) {
      if (typeof payload[key] === 'string' && payload[key]) return payload[key];
    }
  } catch {
    // The service may return a short plain-text error body.
  }
  return text.slice(0, 1000);
}

export function checkModelviewInpaintServiceStatus() {
  const url = inpaintUrl();
  return {
    statusCode: 200,
    serviceUrl: url.toString(),
    timeoutSeconds: Math.round(serverConfig.modelviewInpaintTimeoutMs / 1000),
  };
}

export async function generateModelviewInpaint(
  input: ModelviewInpaintInput,
  userId: string,
  options: { signal?: AbortSignal } = {},
) {
  const projectId = input.projectId;
  if (!projectId) throw new ModelviewInpaintError('局部重绘需要当前项目 ID。', 400);
  if (!input.image?.dataUrl) throw new ModelviewInpaintError('局部重绘白模主图不能为空。', 422);
  if (!input.materialImage?.dataUrl) {
    throw new ModelviewInpaintError('局部重绘多视图材质参考图不能为空。', 422);
  }
  if (!input.viewportReference?.dataUrl) {
    throw new ModelviewInpaintError('局部重绘当前视角预览图不能为空。', 422);
  }
  const prompt = input.prompt?.trim() ?? '';
  if (Array.from(prompt).length > 4096) {
    throw new ModelviewInpaintError('局部重绘提示词不能超过 4096 个字符。', 400);
  }

  const jobId = input.clientGenerationId || `modelview-inpaint-${randomUUID()}`;
  const idempotencyKey = createIdempotencyKey(jobId);
  const image = dataUrlToBuffer(input.image.dataUrl, '局部重绘白模主图');
  const materialImage = dataUrlToBuffer(
    input.materialImage.dataUrl,
    '局部重绘多视图材质参考图',
  );
  const viewportReference = dataUrlToBuffer(
    input.viewportReference.dataUrl,
    '局部重绘当前视角预览图',
  );
  const boundaryHash = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
  const boundary = `----Li3DModelview${boundaryHash}`;
  const body = multipartBody({
    boundary,
    files: [
      {
        field: 'image',
        filename: safeFilename(input.image.path, 'white-model.png'),
        mime: image.mime,
        image: image.buffer,
      },
      {
        field: 'material_image',
        filename: safeFilename(input.materialImage.path, 'multiview-material-reference.png'),
        mime: materialImage.mime,
        image: materialImage.buffer,
      },
      {
        field: 'viewport_reference',
        filename: safeFilename(input.viewportReference.path, 'viewport-reference.png'),
        mime: viewportReference.mime,
        image: viewportReference.buffer,
      },
    ],
    prompt: prompt || undefined,
  });
  const response = await requestInpaint(body, boundary, idempotencyKey, options.signal);
  const remoteJobId =
    typeof response.headers['x-job-id'] === 'string' ? response.headers['x-job-id'] : undefined;
  const remoteClientId =
    typeof response.headers['x-client-id'] === 'string'
      ? response.headers['x-client-id']
      : undefined;
  if (response.statusCode !== 200) {
    const status =
      response.statusCode >= 400 && response.statusCode <= 599 ? response.statusCode : 502;
    throw new ModelviewInpaintError(responseErrorMessage(response), status, remoteJobId);
  }
  const contentType = String(response.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new ModelviewInpaintError(
      `ModelView 局部重绘返回了非图片内容：${contentType || 'unknown'}`,
      502,
      remoteJobId,
    );
  }

  const sha256 = createHash('sha256').update(response.body).digest('hex');
  const projectAsset = await saveBinaryAsset({
    userId,
    projectId,
    category: 'generations',
    mime: contentType,
    buffer: response.body,
    filename: `${jobId}-modelview-int8.png`,
  });
  const saved =
    projectAsset ??
    (await saveUserRecoveryAsset({
      userId,
      mime: contentType,
      buffer: response.body,
      filename: `${jobId}-modelview-int8.png`,
    }));
  if (!projectAsset) {
    console.warn('[ModelView Inpaint] project missing after remote completion; saved recovery asset', {
      userId,
      projectId,
      jobId: remoteJobId ?? '(missing X-Job-ID)',
      resultUrl: saved.url,
    });
  }
  console.info('[ModelView Inpaint] completed', {
    jobId: remoteJobId ?? '(missing X-Job-ID)',
    clientId: remoteClientId,
    idempotencyKey,
    bytes: response.body.byteLength,
    sha256,
  });
  return {
    id: jobId,
    resultUrl: saved.url,
    resultUrls: [saved.url],
    modelviewJobId: remoteJobId,
    modelviewClientId: remoteClientId,
    output: {
      contentType,
      bytes: response.body.byteLength,
      sha256,
      source: 'modelview-inpaint',
      storage: projectAsset ? 'project' : 'user-recovery',
      workflow: '2026.08.17-a9dbbca-flux2-klein-truev3-3input-r2',
      finalNode: 'SaveImage #32',
    },
  };
}
