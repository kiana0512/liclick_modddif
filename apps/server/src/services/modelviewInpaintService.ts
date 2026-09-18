import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createModelviewIdempotencyKey } from './modelviewIdempotency.js';
import { serverConfig } from '../config.js';
import { gpuControlLanCa } from '../certs/gpuControlLanCa.js';
import { maxLocalAssetBytes, saveBinaryAsset, saveUserRecoveryAsset } from './assetFileService.js';

type ModelviewControlFile = {
  path: string;
  dataUrl: string;
};

type ModelviewGenerationInput = {
  clientGenerationId?: string;
  projectId?: string;
  prompt?: string;
  image: ModelviewControlFile;
  materialImage: ModelviewControlFile;
};

export type ModelviewSingleViewInpaintInput = ModelviewGenerationInput & {
  promptPolishEnabled?: boolean;
  mask: ModelviewControlFile;
  normalImage: ModelviewControlFile;
};

export type ModelviewInpaintInput = ModelviewSingleViewInpaintInput;
type ModelviewNormalInput = { normalImage: ModelviewControlFile };
export type ModelviewSingleViewInput = ModelviewGenerationInput & ModelviewNormalInput;

type ModelviewServiceKind = 'inpaint' | 'single-view' | 'single-view-inpaint';

type ModelviewServiceDefinition = {
  kind: ModelviewServiceKind;
  label: string;
  url: string;
  caPath: string;
  apiKey: string;
  timeoutMs: number;
  jobPrefix: string;
  idempotencySuffix: string;
  filenameSuffix: string;
  source: string;
  workflow: string;
  finalNode: string;
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

function serviceDefinition(kind: ModelviewServiceKind): ModelviewServiceDefinition {
  if (kind === 'single-view-inpaint') {
    return {
      kind,
      label: 'ModelView 单视图贴图补全',
      url: serverConfig.modelviewSingleViewInpaintUrl,
      caPath: serverConfig.modelviewSingleViewInpaintCaPath,
      apiKey: serverConfig.modelviewSingleViewInpaintApiKey,
      timeoutMs: serverConfig.modelviewSingleViewInpaintTimeoutMs,
      jobPrefix: 'modelview-single-view-inpaint',
      idempotencySuffix: 'single-view-inpaint:refcontrol-normal-2step-r1',
      filenameSuffix: 'modelview-single-view-inpaint',
      source: 'modelview-single-view-inpaint',
      workflow: '2026.09.18-refcontrol-normal-single-view-inpaint-2step-r1',
      finalNode: 'SaveImage #29',
    };
  }
  if (kind === 'single-view') {
    return {
      kind,
      label: 'ModelView 单视图生成',
      url: serverConfig.modelviewSingleViewUrl,
      caPath: serverConfig.modelviewSingleViewCaPath,
      apiKey: serverConfig.modelviewSingleViewApiKey,
      timeoutMs: serverConfig.modelviewSingleViewTimeoutMs,
      jobPrefix: 'modelview-single-view',
      idempotencySuffix: 'single-view:refcontrol-normal-4step-r1',
      filenameSuffix: 'modelview-single-view',
      source: 'modelview-single-view',
      workflow: '2026.09.18-refcontrol-normal-single-view-4step-r1',
      finalNode: 'SaveImage #29',
    };
  }
  return {
    kind,
    label: 'ModelView 局部重绘',
    url: serverConfig.modelviewInpaintUrl,
    caPath: serverConfig.modelviewInpaintCaPath,
    apiKey: serverConfig.modelviewInpaintApiKey,
    timeoutMs: serverConfig.modelviewInpaintTimeoutMs,
    jobPrefix: 'modelview-inpaint',
    idempotencySuffix: 'inpaint:refcontrol-normal-4step-r1',
    filenameSuffix: 'modelview-int8',
    source: 'modelview-inpaint',
    workflow: '2026.09.18-refcontrol-normal-4step-r1',
    finalNode: 'SaveImage #29',
  };
}

function serviceUrl(service: ModelviewServiceDefinition) {
  const url = new URL(service.url);
  const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new ModelviewInpaintError(`${service.label}接口必须使用 HTTPS。`, 500);
  }
  return url;
}

function serviceTrust(service: ModelviewServiceDefinition) {
  const configuredPath = service.caPath || process.env.NODE_EXTRA_CA_CERTS?.trim() || '';
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
      new Set([...getCACertificates('default'), ...getCACertificates('system'), gpuControlLanCa]),
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

function createIdempotencyKey(jobId: string, service: ModelviewServiceDefinition) {
  return createModelviewIdempotencyKey(jobId, service.idempotencySuffix);
}

function multipartBody(input: {
  boundary: string;
  files: Array<{
    field: 'image' | 'material_image' | 'mask' | 'normal_image';
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

async function validateInpaintImageAndMask(image: { buffer: Buffer }, mask: { buffer: Buffer }, normal?: { buffer: Buffer }) {
  try {
    const [imageMetadata, maskMetadata, maskStats, normalMetadata] = await Promise.all([
      sharp(image.buffer, { failOn: 'error' }).metadata(),
      sharp(mask.buffer, { failOn: 'error' }).metadata(),
      sharp(mask.buffer, { failOn: 'error' }).stats(),
      normal ? sharp(normal.buffer, { failOn: 'error' }).metadata() : undefined,
    ]);
    if (
      !imageMetadata.width ||
      !imageMetadata.height ||
      !maskMetadata.width ||
      !maskMetadata.height
    ) {
      throw new ModelviewInpaintError('当前效果图或蒙版缺少有效尺寸。', 422);
    }
    if (
      imageMetadata.width !== maskMetadata.width ||
      imageMetadata.height !== maskMetadata.height
    ) {
      throw new ModelviewInpaintError(
        `蒙版尺寸 ${maskMetadata.width}×${maskMetadata.height} 必须与当前效果图 ${imageMetadata.width}×${imageMetadata.height} 完全一致。`,
        422,
      );
    }
    if (normalMetadata && (normalMetadata.width !== imageMetadata.width || normalMetadata.height !== imageMetadata.height)) {
      throw new ModelviewInpaintError('法线图尺寸必须与当前效果图、蒙版完全一致。', 422);
    }
    // Decode to reject corrupt payloads without re-encoding submitted bytes.
    if (normal) await sharp(normal.buffer, { failOn: 'error' }).stats();
    if ((maskStats.channels[0]?.max ?? 0) <= 0) {
      throw new ModelviewInpaintError('蒙版红色通道为全黑，请先绘制局部重绘区域。', 422);
    }
  } catch (error) {
    if (error instanceof ModelviewInpaintError) throw error;
    throw new ModelviewInpaintError(
      error instanceof Error
        ? `无法校验当前效果图、蒙版${normal ? '与法线图' : ''}：${error.message}`
        : '无法校验当前效果图与蒙版。',
      422,
    );
  }
}

async function validateNormalImage(image: { buffer: Buffer }, normal: { buffer: Buffer }) {
  try {
    const [imageMetadata, normalMetadata] = await Promise.all([
      sharp(image.buffer, { failOn: 'error' }).metadata(),
      sharp(normal.buffer, { failOn: 'error' }).metadata(),
    ]);
    if (
      !imageMetadata.width || !imageMetadata.height ||
      !normalMetadata.width || !normalMetadata.height
    ) {
      throw new ModelviewInpaintError('主图或法线图缺少有效尺寸。', 422);
    }
    if (
      imageMetadata.width !== normalMetadata.width ||
      imageMetadata.height !== normalMetadata.height
    ) {
      throw new ModelviewInpaintError(
        `法线图尺寸 ${normalMetadata.width}×${normalMetadata.height} 必须与主图 ${imageMetadata.width}×${imageMetadata.height} 完全一致。`,
        422,
      );
    }
    await sharp(normal.buffer, { failOn: 'error' }).stats();
  } catch (error) {
    if (error instanceof ModelviewInpaintError) throw error;
    throw new ModelviewInpaintError('主图或法线图不是可读取的有效图片。', 422);
  }
}

function requestModelview(
  body: Buffer,
  boundary: string,
  idempotencyKey: string,
  service: ModelviewServiceDefinition,
  signal?: AbortSignal,
) {
  const url = serviceUrl(service);
  const timeoutMs = service.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ModelviewInpaintError(`${service.label}超时配置无效。`, 500);
  }
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise<RemoteResponse>((resolve, reject) => {
    let settled = false;
    let clearConnectionWatch: (() => void) | undefined;
    const totalTimer = setTimeout(() => {
      request.destroy(new Error(`${service.label}等待超过 ${Math.round(timeoutMs / 1000)} 秒。`));
    }, timeoutMs);
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearConnectionWatch?.();
      signal?.removeEventListener('abort', abortRequest);
      callback();
    };
    const abortRequest = () => request.destroy(new Error(`${service.label}请求已取消。`));
    const headers: Record<string, string | number> = {
      accept: 'image/png',
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': body.byteLength,
      'idempotency-key': idempotencyKey,
      ...(service.apiKey ? { 'x-api-key': service.apiKey } : {}),
    };
    const request = transport.request(
      url,
      {
        method: 'POST',
        headers,
        ...(url.protocol === 'https:'
          ? { ca: serviceTrust(service), rejectUnauthorized: true }
          : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on('data', (chunk: Buffer) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.byteLength;
          if (totalBytes > maxLocalAssetBytes) {
            response.destroy(new Error(`${service.label}响应图片过大。`));
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
      // Agent keep-alive sockets have already connected and will not emit a
      // second connect/secureConnect. Their generation still has totalTimer.
      if (settled || request.reusedSocket) return;
      const connectedEvent = url.protocol === 'https:' ? 'secureConnect' : 'connect';
      const connectTimer = setTimeout(() => {
        request.destroy(new Error(`连接${service.label}服务超过 10 秒。`));
      }, 10_000);
      const onConnected = () => {
        clearTimeout(connectTimer);
        socket.removeListener(connectedEvent, onConnected);
        clearConnectionWatch = undefined;
      };
      clearConnectionWatch = onConnected;
      socket.once(connectedEvent, onConnected);
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

function responseErrorMessage(response: RemoteResponse, service: ModelviewServiceDefinition) {
  const text = response.body.toString('utf8').trim();
  if (!text) return `${service.label}请求失败：HTTP ${response.statusCode}`;
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

function checkModelviewServiceStatus(kind: ModelviewServiceKind) {
  const service = serviceDefinition(kind);
  const url = serviceUrl(service);
  return {
    statusCode: 200,
    serviceUrl: url.toString(),
    timeoutSeconds: Math.round(service.timeoutMs / 1000),
  };
}

export function checkModelviewInpaintServiceStatus() {
  return checkModelviewServiceStatus('inpaint');
}

export function checkModelviewSingleViewServiceStatus() {
  return checkModelviewServiceStatus('single-view');
}

export function checkModelviewSingleViewInpaintServiceStatus() {
  return checkModelviewServiceStatus('single-view-inpaint');
}

async function generateModelviewImage(
  input: ModelviewInpaintInput | ModelviewSingleViewInput | ModelviewSingleViewInpaintInput,
  userId: string,
  kind: ModelviewServiceKind,
  options: { signal?: AbortSignal },
) {
  const service = serviceDefinition(kind);
  const operationLabel =
    kind === 'inpaint'
      ? '局部重绘'
      : kind === 'single-view-inpaint'
        ? '单视图贴图补全'
        : '单视图生成';
  const projectId = input.projectId;
  if (!projectId) throw new ModelviewInpaintError(`${operationLabel}需要当前项目 ID。`, 400);
  const imageLabel = kind === 'single-view' ? '白模主图' : '当前效果图';
  if (!input.image?.dataUrl) {
    throw new ModelviewInpaintError(`${operationLabel}${imageLabel}不能为空。`, 422);
  }
  if (!input.materialImage?.dataUrl) {
    throw new ModelviewInpaintError(`${operationLabel}多视图材质参考图不能为空。`, 422);
  }
  const inpaintInput = kind === 'single-view' ? undefined : (input as ModelviewSingleViewInpaintInput);
  if (inpaintInput && !inpaintInput.mask?.dataUrl) {
    throw new ModelviewInpaintError(`${operationLabel}蒙版不能为空。`, 422);
  }
  const normalInput = input.normalImage;
  if (!normalInput?.dataUrl) {
    throw new ModelviewInpaintError(`${operationLabel}需要同一视角的法线图。`, 422);
  }
  // ModelView's new workflow owns the default prompt. Never let a stale client
  // or saved prompt override it unless the user explicitly enabled polishing.
  const prompt = kind === 'inpaint' && inpaintInput?.promptPolishEnabled === true
    ? input.prompt?.trim() ?? '' : '';
  if (kind === 'inpaint' && inpaintInput?.promptPolishEnabled === true && !prompt) {
    throw new ModelviewInpaintError('智能润色已开启，但没有可提交的提示词。', 422);
  }
  if (Array.from(prompt).length > 4096) {
    throw new ModelviewInpaintError(`${operationLabel}提示词不能超过 4096 个字符。`, 400);
  }

  const jobId = input.clientGenerationId || `${service.jobPrefix}-${randomUUID()}`;
  const idempotencyKey = createIdempotencyKey(jobId, service);
  const image = dataUrlToBuffer(input.image.dataUrl, `${operationLabel}${imageLabel}`);
  const materialImage = dataUrlToBuffer(
    input.materialImage.dataUrl,
    `${operationLabel}多视图材质参考图`,
  );
  const mask = inpaintInput
    ? dataUrlToBuffer(inpaintInput.mask.dataUrl, `${operationLabel}蒙版`)
    : undefined;
  const normal = dataUrlToBuffer(normalInput.dataUrl, `${operationLabel}法线图`);
  if (mask) await validateInpaintImageAndMask(image, mask, normal);
  else await validateNormalImage(image, normal);
  const boundaryHash = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
  const boundary = `----Li3DModelview${boundaryHash}`;
  const body = multipartBody({
    boundary,
    files: [
      {
        field: 'image',
        filename: safeFilename(
          input.image.path,
          kind === 'single-view' ? 'white-model.png' : 'current-effect.png',
        ),
        mime: image.mime,
        image: image.buffer,
      },
      {
        field: 'material_image',
        filename: safeFilename(input.materialImage.path, 'multiview-material-reference.png'),
        mime: materialImage.mime,
        image: materialImage.buffer,
      },
      ...(mask && inpaintInput
        ? [
            {
              field: 'mask' as const,
              filename: safeFilename(inpaintInput.mask.path, 'mask.png'),
              mime: mask.mime,
              image: mask.buffer,
            },
          ]
        : []),
      ...(normal && normalInput ? [{
        field: 'normal_image' as const,
        filename: safeFilename(normalInput.path, 'normal.png'),
        mime: normal.mime,
        image: normal.buffer,
      }] : []),
    ],
    prompt: prompt || undefined,
  });
  const response = await requestModelview(body, boundary, idempotencyKey, service, options.signal);
  const remoteJobId =
    typeof response.headers['x-job-id'] === 'string' ? response.headers['x-job-id'] : undefined;
  const remoteClientId =
    typeof response.headers['x-client-id'] === 'string'
      ? response.headers['x-client-id']
      : undefined;
  if (response.statusCode !== 200) {
    const status =
      response.statusCode >= 400 && response.statusCode <= 599 ? response.statusCode : 502;
    throw new ModelviewInpaintError(responseErrorMessage(response, service), status, remoteJobId);
  }
  const contentType = String(response.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new ModelviewInpaintError(
      `${service.label}返回了非图片内容：${contentType || 'unknown'}`,
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
    filename: `${jobId}-${service.filenameSuffix}.png`,
  });
  const saved =
    projectAsset ??
    (await saveUserRecoveryAsset({
      userId,
      mime: contentType,
      buffer: response.body,
      filename: `${jobId}-${service.filenameSuffix}.png`,
    }));
  if (!projectAsset) {
    console.warn(
      `[${service.label}] project missing after remote completion; saved recovery asset`,
      {
        userId,
        projectId,
        jobId: remoteJobId ?? '(missing X-Job-ID)',
        resultUrl: saved.url,
      },
    );
  }
  console.info(`[${service.label}] completed`, {
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
      source: service.source,
      storage: projectAsset ? 'project' : 'user-recovery',
      workflow: service.workflow,
      finalNode: service.finalNode,
    },
  };
}

export function generateModelviewInpaint(
  input: ModelviewInpaintInput,
  userId: string,
  options: { signal?: AbortSignal } = {},
) {
  return generateModelviewImage(input, userId, 'inpaint', options);
}

export function generateModelviewSingleView(
  input: ModelviewSingleViewInput,
  userId: string,
  options: { signal?: AbortSignal } = {},
) {
  return generateModelviewImage(input, userId, 'single-view', options);
}

export function generateModelviewSingleViewInpaint(
  input: ModelviewSingleViewInpaintInput,
  userId: string,
  options: { signal?: AbortSignal } = {},
) {
  return generateModelviewImage(input, userId, 'single-view-inpaint', options);
}
