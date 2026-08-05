import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import { validateGpuControlLanCaBytes } from '../certs/gpuControlLanCa.js';
import { serverConfig } from '../config.js';
import { corsHeaders } from '../routes/httpUtils.js';

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

type AssetServiceCapacity = {
  schemaVersion: string;
  advisory: boolean;
  onlineWorkers: number;
  totalSlots: number;
  usedSlots: number;
  availableSlots: number;
  asOf: string;
};

type CaCertificateState = {
  available: boolean;
  integrityValid: boolean;
  sha256?: string;
  bytes?: Buffer;
  error?: string;
};

function assetServiceUrl(upstreamPath: string) {
  const baseUrl = new URL(serverConfig.assetServiceBaseUrl);
  if (baseUrl.protocol !== 'https:') {
    throw new Error('Asset service must use HTTPS.');
  }
  return new URL(upstreamPath, `${baseUrl.origin}/`);
}

function inspectCaCertificate(): CaCertificateState {
  const certificatePath = serverConfig.assetServiceCaCertPath;
  if (!certificatePath) {
    return {
      available: false,
      integrityValid: false,
      error: 'Asset service CA certificate path is not configured.',
    };
  }
  try {
    const resolved = fs.realpathSync(certificatePath);
    if (!fs.statSync(resolved).isFile()) {
      throw new Error(`Asset service CA path is not a file: ${certificatePath}`);
    }
    const bytes = fs.readFileSync(resolved);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    try {
      validateGpuControlLanCaBytes(bytes);
      return { available: true, integrityValid: true, sha256, bytes };
    } catch (error) {
      return {
        available: true,
        integrityValid: false,
        sha256,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } catch (error) {
    return {
      available: false,
      integrityValid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function safeCaCertificate() {
  const state = inspectCaCertificate();
  if (!state.integrityValid || !state.bytes) {
    throw new Error(state.error || 'Asset service CA certificate is unavailable or invalid.');
  }
  return state.bytes;
}

function forwardedResponseHeaders(headers: IncomingHttpHeaders) {
  const allowedHeaders = new Set([
    'cache-control',
    'content-length',
    'content-type',
    'etag',
    'last-modified',
    'x-artifact-sha256',
    'x-request-id',
  ]);
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => (
    value !== undefined &&
    !hopByHopHeaders.has(name.toLowerCase()) &&
    allowedHeaders.has(name.toLowerCase())
  )));
}

function assetProcessingRequestId(request: IncomingMessage) {
  return request.headers['x-request-id']?.toString() || randomUUID();
}

export function sendAssetProcessingError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  summary: string,
  requestId = assetProcessingRequestId(response.req),
) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...corsHeaders(response),
    'x-request-id': requestId,
    'x-li3d-request-id': requestId,
  });
  response.end(JSON.stringify({
    error: { code, summary },
    request_id: requestId,
  }));
}

function allowedUpstreamPath(pathname: string) {
  return (
    pathname === '/api/v1/assets/uv/process' ||
    pathname === '/api/v1/assets/retopology/process' ||
    /^\/api\/v1\/assets\/jobs\/[^/]+(?:\/cancel|\/events)?$/.test(pathname)
  );
}

function upstreamRequestOptions(
  upstreamPath: string,
  method: string,
  headers: Record<string, string | number> = {},
) {
  if (!serverConfig.assetServiceTlsRejectUnauthorized) {
    throw new Error('Asset service requires TLS certificate verification.');
  }
  const upstreamUrl = assetServiceUrl(upstreamPath);
  const options: RequestOptions = {
    protocol: upstreamUrl.protocol,
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || undefined,
    method,
    path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
    headers: {
      accept: 'application/json',
      ...(serverConfig.assetServiceApiToken
        ? { authorization: `Bearer ${serverConfig.assetServiceApiToken}` }
        : {}),
      ...headers,
    },
    rejectUnauthorized: serverConfig.assetServiceTlsRejectUnauthorized,
    allowPartialTrustChain: Boolean(serverConfig.assetServiceCaCertPath),
  };
  if (serverConfig.assetServiceCaCertPath) options.ca = safeCaCertificate();
  return options;
}

async function requestBuffer(
  method: string,
  upstreamPath: string,
  options: {
    headers?: Record<string, string | number>;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
) {
  const requestId = options.headers?.['x-request-id']?.toString() || randomUUID();
  const requestOptions = upstreamRequestOptions(upstreamPath, method, {
    'x-request-id': requestId,
    ...options.headers,
  });
  const timeoutMs = options.timeoutMs ?? Math.min(serverConfig.assetServiceRequestTimeoutMs, 15_000);
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;

  return new Promise<{
    statusCode: number;
    headers: IncomingHttpHeaders;
    body: Buffer;
    requestId: string;
  }>((resolve, reject) => {
    const upstreamRequest = https.request(requestOptions, (upstreamResponse) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      upstreamResponse.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.byteLength;
        if (totalBytes > maxBytes) {
          upstreamResponse.destroy(new Error('Asset service response is too large.'));
          return;
        }
        chunks.push(buffer);
      });
      upstreamResponse.on('end', () => {
        resolve({
          statusCode: upstreamResponse.statusCode ?? 502,
          headers: upstreamResponse.headers,
          body: Buffer.concat(chunks, totalBytes),
          requestId,
        });
      });
      upstreamResponse.on('error', reject);
    });
    upstreamRequest.setTimeout(timeoutMs, () => {
      upstreamRequest.destroy(new Error('Asset service request timed out.'));
    });
    upstreamRequest.on('error', reject);
    upstreamRequest.end();
  });
}

export async function fetchAssetJobSnapshot(jobId: string, timeoutMs = 10_000) {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId || normalizedJobId.length > 200) {
    throw new Error('Asset job id is invalid.');
  }
  const result = await requestBuffer(
    'GET',
    `/api/v1/assets/jobs/${encodeURIComponent(normalizedJobId)}`,
    { timeoutMs: Math.min(10_000, Math.max(1_000, timeoutMs)), maxBytes: 2 * 1024 * 1024 },
  );
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`Asset job is unavailable (${result.statusCode}).`);
  }
  const payload = JSON.parse(result.body.toString('utf8')) as unknown;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Asset service returned an invalid job snapshot.');
  }
  const record = payload as Record<string, unknown>;
  if (record.job_id !== normalizedJobId || typeof record.status !== 'string') {
    throw new Error('Asset service job snapshot is missing required fields.');
  }
  return record;
}

function capacityInteger(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`Asset V4 capacity field ${key} must be a non-negative integer.`);
  }
  return value as number;
}

function parseAssetServiceCapacity(body: Buffer): AssetServiceCapacity {
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch (error) {
    throw new Error(
      `Asset V4 capacity response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Asset V4 capacity response must be a JSON object.');
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.schema_version !== 'string' || !record.schema_version.trim()) {
    throw new Error('Asset V4 capacity field schema_version must be a non-empty string.');
  }
  if (typeof record.advisory !== 'boolean') {
    throw new Error('Asset V4 capacity field advisory must be a boolean.');
  }
  if (typeof record.as_of !== 'string' || !record.as_of.trim()) {
    throw new Error('Asset V4 capacity field as_of must be a non-empty string.');
  }
  if (Number.isNaN(Date.parse(record.as_of))) {
    throw new Error('Asset V4 capacity field as_of must be a valid timestamp.');
  }

  const capacity = {
    schemaVersion: record.schema_version,
    advisory: record.advisory,
    onlineWorkers: capacityInteger(record, 'online_workers'),
    totalSlots: capacityInteger(record, 'total_slots'),
    usedSlots: capacityInteger(record, 'used_slots'),
    availableSlots: capacityInteger(record, 'available_slots'),
    asOf: record.as_of,
  };
  if (capacity.usedSlots > capacity.totalSlots) {
    throw new Error('Asset V4 capacity used_slots cannot exceed total_slots.');
  }
  if (capacity.availableSlots > capacity.totalSlots) {
    throw new Error('Asset V4 capacity available_slots cannot exceed total_slots.');
  }
  return capacity;
}

async function probeAssetService() {
  try {
    const result = await requestBuffer(
      'GET',
      '/api/v1/assets/capacity',
      { timeoutMs: 6_000, maxBytes: 256 * 1024 },
    );
    const successful = result.statusCode >= 200 && result.statusCode < 300;
    if (result.statusCode === 401 || result.statusCode === 403) {
      return {
        reachable: true,
        authorized: false,
        capacityCheckPassed: false,
        errorKind: 'authorization' as const,
        httpStatus: result.statusCode,
        message:
          result.statusCode === 401
            ? '资产服务 Bearer Token 鉴权未通过。'
            : '本机 IP 尚未获得资产服务访问权限。',
      };
    }
    if (!successful) {
      return {
        reachable: true,
        authorized: true,
        capacityCheckPassed: false,
        errorKind: 'http' as const,
        httpStatus: result.statusCode,
        message: `Asset V4 容量检查失败：HTTP ${result.statusCode}。`,
      };
    }
    try {
      const capacity = parseAssetServiceCapacity(result.body);
      return {
        reachable: true,
        authorized: true,
        capacityCheckPassed: true,
        capacity,
        message: `Asset V4 已连接：${capacity.onlineWorkers} 个 Worker，${capacity.availableSlots}/${capacity.totalSlots} 个槽位可用。`,
      };
    } catch (error) {
      return {
        reachable: true,
        authorized: true,
        capacityCheckPassed: false,
        errorKind: 'schema' as const,
        httpStatus: result.statusCode,
        message: `Asset V4 容量响应格式无效：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Asset V4 is unreachable.';
    const certificateFailure =
      /certificate|cert_|unable to verify|self[- ]signed|unknown ca|altname|ERR_TLS/i.test(message);
    return {
      reachable: false,
      authorized: false,
      capacityCheckPassed: false,
      errorKind: certificateFailure ? 'tls' as const : 'connection' as const,
      message: certificateFailure
        ? `资产服务 TLS 校验失败：${message}`
        : `资产服务无法连接：${message}`,
    };
  }
}

export async function assetProcessingProxyStatus() {
  const caState = inspectCaCertificate();
  const endpoint = (() => {
    try {
      return new URL(serverConfig.assetServiceBaseUrl).origin;
    } catch {
      return '';
    }
  })();
  const configured = Boolean(
    endpoint.startsWith('https://') &&
    serverConfig.assetServiceTlsRejectUnauthorized &&
    caState.integrityValid,
  );
  const configurationMessage = !endpoint.startsWith('https://')
    ? 'Asset V4 服务地址必须使用 HTTPS。'
    : !serverConfig.assetServiceTlsRejectUnauthorized
      ? 'Asset V4 要求启用严格 TLS 证书校验。'
      : !caState.integrityValid
        ? `Asset V4 CA 校验失败：${caState.error || '证书不可用。'}`
        : '资产服务配置不完整。';
  const probe = configured
    ? await probeAssetService()
    : {
        reachable: false,
        authorized: false,
        capacityCheckPassed: false,
        errorKind: 'configuration' as const,
        message: configurationMessage,
      };

  return {
    configured,
    available: configured && probe.capacityCheckPassed,
    capacityCheckPassed: configured && probe.capacityCheckPassed,
    ...('capacity' in probe ? { capacity: probe.capacity } : {}),
    reachable: probe.reachable,
    authorized: probe.authorized,
    message: probe.message,
    errorKind: 'errorKind' in probe ? probe.errorKind : undefined,
    httpStatus: 'httpStatus' in probe ? probe.httpStatus : undefined,
    endpoint,
    tokenConfigured: Boolean(serverConfig.assetServiceApiToken),
    authorizationMode: serverConfig.assetServiceApiToken ? 'bearer' : 'client-ip',
    tls: {
      rejectUnauthorized: serverConfig.assetServiceTlsRejectUnauthorized,
      customCaConfigured: Boolean(serverConfig.assetServiceCaCertPath),
      customCaAvailable: caState.available,
      customCaIntegrityValid: caState.integrityValid,
      customCaSha256: caState.sha256,
      expectedCaSha256: serverConfig.assetServiceCaCertExpectedSha256,
      customCaManaged: serverConfig.assetServiceCaCertManaged,
      customCaError: caState.error,
    },
    capabilities: {
      uv: true,
      retopology: true,
      polling: true,
      events: true,
      cancellation: true,
      artifacts: true,
      verifiedArtifacts: true,
    },
  };
}

class UploadLimitTransform extends Transform {
  private totalBytes = 0;

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer | string) => void,
  ) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.totalBytes += buffer.byteLength;
    if (this.totalBytes > serverConfig.assetServiceMaxUploadBytes) {
      callback(new Error('Asset upload exceeds the configured size limit.'));
      return;
    }
    callback(null, buffer);
  }
}

class ArtifactSizeLimitError extends Error {
  constructor() {
    super('Asset artifact exceeds the configured size limit.');
    this.name = 'ArtifactSizeLimitError';
  }
}

class ArtifactLimitTransform extends Transform {
  private totalBytes = 0;

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer | string) => void,
  ) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.totalBytes += buffer.byteLength;
    if (this.totalBytes > serverConfig.assetServiceMaxArtifactBytes) {
      callback(new ArtifactSizeLimitError());
      return;
    }
    callback(null, buffer);
  }
}

export async function proxyAssetProcessingRequest(
  request: IncomingMessage,
  response: ServerResponse,
  upstreamPath: string,
  onJsonResponse?: (payload: unknown, statusCode: number) => Promise<void>,
) {
  const requestId = assetProcessingRequestId(request);
  if (!allowedUpstreamPath(upstreamPath)) {
    sendAssetProcessingError(
      response,
      404,
      'ASSET_ROUTE_NOT_FOUND',
      'Asset processing route not found.',
      requestId,
    );
    return;
  }

  const contentLength = Number(request.headers['content-length'] ?? 0);
  const isSubmission = request.method === 'POST' && upstreamPath.endsWith('/process');
  const suppliedIdempotencyKey = request.headers['idempotency-key']?.toString().trim();
  if (isSubmission && !suppliedIdempotencyKey) {
    request.resume();
    sendAssetProcessingError(
      response,
      400,
      'ASSET_IDEMPOTENCY_REQUIRED',
      '提交资产处理任务时必须提供稳定的 Idempotency-Key。',
      requestId,
    );
    return;
  }
  if (
    isSubmission &&
    Number.isFinite(contentLength) &&
    contentLength > serverConfig.assetServiceMaxUploadBytes
  ) {
    request.resume();
    sendAssetProcessingError(
      response,
      413,
      'ASSET_UPLOAD_TOO_LARGE',
      'Asset upload exceeds the configured size limit.',
      requestId,
    );
    return;
  }

  const idempotencyKey = suppliedIdempotencyKey;
  const headers: Record<string, string | number> = {
    accept: request.headers.accept?.toString() || 'application/json',
    'x-request-id': requestId,
  };
  if (request.headers['content-type']) headers['content-type'] = request.headers['content-type'].toString();
  if (request.headers['content-length']) headers['content-length'] = request.headers['content-length'].toString();
  if (request.headers['last-event-id']) headers['last-event-id'] = request.headers['last-event-id'].toString();
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  let options: RequestOptions;
  try {
    options = upstreamRequestOptions(upstreamPath, request.method ?? 'GET', headers);
  } catch {
    sendAssetProcessingError(
      response,
      503,
      'ASSET_TLS_CONFIGURATION_INVALID',
      'Asset service configuration is invalid.',
      requestId,
    );
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let localErrorHandled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const upstreamRequest = https.request(options, (upstreamResponse) => {
      const statusCode = upstreamResponse.statusCode ?? 502;
      if (statusCode >= 300 && statusCode < 400) {
        upstreamResponse.resume();
        sendAssetProcessingError(
          response,
          502,
          'ASSET_UPSTREAM_REDIRECT_REJECTED',
          'Asset service redirect was rejected.',
          requestId,
        );
        settle();
        return;
      }
      const responseHeaders = {
        ...forwardedResponseHeaders(upstreamResponse.headers),
        ...corsHeaders(response),
        'x-li3d-request-id': requestId,
      };
      if (onJsonResponse) {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        upstreamResponse.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.byteLength;
          if (totalBytes > 2 * 1024 * 1024) {
            upstreamResponse.destroy(new Error('Asset service submission response is too large.'));
            return;
          }
          chunks.push(buffer);
        });
        upstreamResponse.on('end', () => {
          void (async () => {
            const body = Buffer.concat(chunks, totalBytes);
            if (statusCode >= 200 && statusCode < 300) {
              await onJsonResponse(JSON.parse(body.toString('utf8')) as unknown, statusCode);
            }
            response.writeHead(statusCode, responseHeaders);
            response.end(body);
            settle();
          })().catch(() => {
            if (!response.headersSent) {
              sendAssetProcessingError(
                response,
                502,
                'ASSET_PROTOCOL_INVALID',
                'Asset service returned an invalid submission response.',
                requestId,
              );
            }
            settle();
          });
        });
      } else {
        response.writeHead(statusCode, responseHeaders);
        upstreamResponse.pipe(response);
        upstreamResponse.on('end', settle);
      }
      upstreamResponse.on('error', (error) => {
        if (response.headersSent) response.destroy(error);
        else {
          sendAssetProcessingError(
            response,
            502,
            'ASSET_UPSTREAM_RESPONSE_ERROR',
            'Asset service response was interrupted.',
            requestId,
          );
        }
        settle();
      });
    });

    if (!upstreamPath.endsWith('/events')) {
      upstreamRequest.setTimeout(serverConfig.assetServiceRequestTimeoutMs, () => {
        upstreamRequest.destroy(new Error('Asset service request timed out.'));
      });
    }
    upstreamRequest.on('error', (error) => {
      if (!response.headersSent && !localErrorHandled) {
        sendAssetProcessingError(
          response,
          502,
          'ASSET_PROXY_UNAVAILABLE',
          'Asset service is unavailable.',
          requestId,
        );
      } else if (response.headersSent) {
        response.destroy(error);
      }
      settle();
    });

    request.on('aborted', () => upstreamRequest.destroy());
    response.once('close', () => {
      if (!settled && !response.writableEnded) upstreamRequest.destroy();
    });
    if (isSubmission) {
      const limiter = new UploadLimitTransform();
      limiter.on('error', () => {
        localErrorHandled = true;
        upstreamRequest.destroy();
        if (!response.headersSent) {
          sendAssetProcessingError(
            response,
            413,
            'ASSET_UPLOAD_TOO_LARGE',
            'Asset upload exceeds the configured size limit.',
            requestId,
          );
        }
        settle();
      });
      request.pipe(limiter).pipe(upstreamRequest);
    } else {
      request.pipe(upstreamRequest);
    }
  });
}

export type PreparedMultipartFile = {
  fieldName: 'project' | 'reference_images';
  filePath: string;
  filename: string;
  size: number;
  contentType?: string;
};

type LocalMultipartSection = {
  prefix: Buffer;
  file?: PreparedMultipartFile;
  suffix: Buffer;
};

export function safePreparedMultipartFilename(value: string, fallback: string) {
  const token = path.basename(value)
    .replace(/[\r\n"]/g, '_')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .slice(0, 180);
  return token || fallback;
}

function multipartSections(
  boundary: string,
  metadata: string,
  files: PreparedMultipartFile[],
) {
  const newline = Buffer.from('\r\n');
  const sections: LocalMultipartSection[] = files.map((file) => {
    const fallbackName = file.fieldName === 'project' ? 'retopology-project.blend' : 'reference.png';
    const filename = safePreparedMultipartFilename(file.filename, fallbackName);
    const contentType = file.contentType?.match(/^[\w.+-]+\/[\w.+-]+$/)?.[0]
      ?? 'application/octet-stream';
    return {
      prefix: Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${file.fieldName}"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
      ),
      file,
      suffix: newline,
    };
  });
  sections.push({
    prefix: Buffer.from(
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="metadata"\r\n' +
      'Content-Type: application/json; charset=utf-8\r\n\r\n' +
      metadata,
    ),
    suffix: newline,
  });
  return {
    sections,
    closing: Buffer.from(`--${boundary}--\r\n`),
  };
}

async function* multipartBody(
  sections: LocalMultipartSection[],
  closing: Buffer,
) {
  for (const section of sections) {
    yield section.prefix;
    if (section.file) {
      for await (const chunk of fs.createReadStream(section.file.filePath)) {
        yield chunk;
      }
    }
    yield section.suffix;
  }
  yield closing;
}

/**
 * Streams a locally prepared BLEND and optional reference images directly to
 * Asset V4. Only the small JSON response is buffered so large projects never
 * make a second trip through the browser.
 */
export async function proxyPreparedRetopologySubmission(
  request: IncomingMessage,
  response: ServerResponse,
  input: {
    project: PreparedMultipartFile;
    referenceImages: PreparedMultipartFile[];
    metadata: string;
  },
  onJsonResponse: (payload: unknown, statusCode: number) => Promise<void>,
) {
  const requestId = assetProcessingRequestId(request);
  const idempotencyKey = request.headers['idempotency-key']?.toString().trim();
  if (!idempotencyKey) {
    sendAssetProcessingError(
      response,
      400,
      'ASSET_IDEMPOTENCY_REQUIRED',
      '提交 Asset V4 任务时必须提供稳定的 Idempotency-Key。',
      requestId,
    );
    return;
  }
  const boundary = `----li3d-retopology-${randomUUID()}`;
  const { sections, closing } = multipartSections(
    boundary,
    input.metadata,
    [input.project, ...input.referenceImages],
  );
  const contentLength = sections.reduce(
    (total, section) => total + section.prefix.byteLength +
      (section.file?.size ?? 0) + section.suffix.byteLength,
    closing.byteLength,
  );
  if (contentLength > serverConfig.assetServiceMaxUploadBytes) {
    sendAssetProcessingError(
      response,
      413,
      'ASSET_UPLOAD_TOO_LARGE',
      'Prepared retopology upload exceeds the configured size limit.',
      requestId,
    );
    return;
  }

  const options = upstreamRequestOptions(
    '/api/v1/assets/retopology/process',
    'POST',
    {
      accept: 'application/json',
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': contentLength,
      'x-request-id': requestId,
      'idempotency-key': idempotencyKey,
    },
  );

  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const upstreamRequest = https.request(options, (upstreamResponse) => {
      const statusCode = upstreamResponse.statusCode ?? 502;
      if (statusCode >= 300 && statusCode < 400) {
        upstreamResponse.resume();
        sendAssetProcessingError(
          response,
          502,
          'ASSET_UPSTREAM_REDIRECT_REJECTED',
          'Asset service redirect was rejected.',
          requestId,
        );
        settle();
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      upstreamResponse.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.byteLength;
        if (totalBytes > 2 * 1024 * 1024) {
          upstreamResponse.destroy(new Error('Asset service submission response is too large.'));
          return;
        }
        chunks.push(buffer);
      });
      upstreamResponse.on('end', () => {
        void (async () => {
          const body = Buffer.concat(chunks, totalBytes);
          if (statusCode >= 200 && statusCode < 300) {
            const payload = JSON.parse(body.toString('utf8')) as unknown;
            await onJsonResponse(payload, statusCode);
          }
          response.writeHead(statusCode, {
            ...forwardedResponseHeaders(upstreamResponse.headers),
            ...corsHeaders(response),
            'x-li3d-request-id': requestId,
          });
          response.end(body);
          settle();
        })().catch(() => {
          if (!response.headersSent) {
            sendAssetProcessingError(
              response,
              502,
              'ASSET_PROTOCOL_INVALID',
              'Asset V4 returned an invalid submission response.',
              requestId,
            );
          }
          settle();
        });
      });
      upstreamResponse.on('error', (error) => {
        if (response.headersSent) response.destroy(error);
        else {
          sendAssetProcessingError(
            response,
            502,
            'ASSET_UPSTREAM_RESPONSE_ERROR',
            'Asset service response was interrupted.',
            requestId,
          );
        }
        settle();
      });
    });

    upstreamRequest.setTimeout(serverConfig.assetServiceRequestTimeoutMs, () => {
      upstreamRequest.destroy(new Error('Asset service request timed out.'));
    });
    upstreamRequest.on('error', (error) => {
      if (!response.headersSent) {
        sendAssetProcessingError(
          response,
          502,
          'ASSET_PROXY_UNAVAILABLE',
          'Asset service is unavailable.',
          requestId,
        );
      } else {
        response.destroy(error);
      }
      settle();
    });
    response.once('close', () => {
      if (!settled && !response.writableEnded) upstreamRequest.destroy();
    });

    const source = Readable.from(multipartBody(sections, closing));
    void pipeline(source, upstreamRequest).catch((error) => {
      upstreamRequest.destroy(error instanceof Error ? error : undefined);
    });
  });
}

function jobArtifacts(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  if ('artifacts' in payload && Array.isArray(payload.artifacts)) return payload.artifacts;
  if (
    'result' in payload &&
    payload.result &&
    typeof payload.result === 'object' &&
    'artifacts' in payload.result &&
    Array.isArray(payload.result.artifacts)
  ) {
    return payload.result.artifacts;
  }
  return [];
}

function safeArtifactFileName(value: unknown) {
  const candidate = typeof value === 'string' ? path.basename(value) : 'asset-artifact.bin';
  return candidate.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 180) || 'asset-artifact.bin';
}

export async function downloadVerifiedAssetArtifact(
  request: IncomingMessage,
  response: ServerResponse,
  jobId: string,
  artifactId: string,
) {
  const requestId = assetProcessingRequestId(request);
  try {
    const jobResponse = await requestBuffer(
      'GET',
      `/api/v1/assets/jobs/${encodeURIComponent(jobId)}`,
      { headers: { 'x-request-id': requestId } },
    );
    if (jobResponse.statusCode < 200 || jobResponse.statusCode >= 300) {
      sendAssetProcessingError(
        response,
        jobResponse.statusCode,
        'ASSET_ARTIFACT_METADATA_UNAVAILABLE',
        'Unable to load artifact metadata from the asset service.',
        requestId,
      );
      return;
    }
    const payload = JSON.parse(jobResponse.body.toString('utf8')) as unknown;
    const artifact = jobArtifacts(payload).find((item) => {
      if (!item || typeof item !== 'object') return false;
      const id =
        ('artifact_id' in item && item.artifact_id) ||
        ('id' in item && item.id);
      if (id === artifactId) return true;
      if (!('download_url' in item) || typeof item.download_url !== 'string') {
        return false;
      }
      try {
        const downloadPath = new URL(item.download_url, serverConfig.assetServiceBaseUrl).pathname;
        const match = /\/artifacts\/([^/]+)\/?$/.exec(downloadPath);
        return match ? decodeURIComponent(match[1]) === artifactId : false;
      } catch {
        return false;
      }
    }) as
      | {
          artifact_id?: string;
          id?: string;
          filename?: string;
          name?: string;
          sha256?: string;
          download_url?: string;
          content_type?: string;
          size_bytes?: number | string;
        }
      | undefined;
    const expectedSha = artifact?.sha256?.toLowerCase();
    if (!artifact || !expectedSha) {
      sendAssetProcessingError(
        response,
        502,
        'ASSET_ARTIFACT_SHA_MISSING',
        'Artifact SHA-256 metadata is missing; download was blocked.',
        requestId,
      );
      return;
    }
    const declaredArtifactSize = Number(artifact.size_bytes);
    if (
      Number.isFinite(declaredArtifactSize) &&
      declaredArtifactSize >= 0 &&
      declaredArtifactSize > serverConfig.assetServiceMaxArtifactBytes
    ) {
      sendAssetProcessingError(
        response,
        413,
        'ASSET_ARTIFACT_TOO_LARGE',
        'Asset artifact exceeds the configured size limit.',
        requestId,
      );
      return;
    }

    const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'li3d-asset-'));
    const tempFile = path.join(tempDirectory, 'artifact.bin');
    try {
      const artifactResponse = await new Promise<{
        statusCode: number;
        headers: IncomingHttpHeaders;
        localSha: string;
      }>((resolve, reject) => {
        const options = upstreamRequestOptions(
          `/api/v1/assets/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactId)}`,
          'GET',
          {
            accept: 'application/octet-stream',
            'x-request-id': requestId,
          },
        );
        const upstreamRequest = https.request(options, async (upstreamResponse) => {
          const statusCode = upstreamResponse.statusCode ?? 502;
          if (statusCode < 200 || statusCode >= 300) {
            upstreamResponse.resume();
            resolve({ statusCode, headers: upstreamResponse.headers, localSha: '' });
            return;
          }
          const declaredContentLength = Number(upstreamResponse.headers['content-length']);
          if (
            Number.isFinite(declaredContentLength) &&
            declaredContentLength >= 0 &&
            declaredContentLength > serverConfig.assetServiceMaxArtifactBytes
          ) {
            upstreamResponse.resume();
            reject(new ArtifactSizeLimitError());
            return;
          }
          const hash = createHash('sha256');
          const hashStream = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              hash.update(chunk);
              callback(null, chunk);
            },
          });
          const sizeLimiter = new ArtifactLimitTransform();
          try {
            await pipeline(
              upstreamResponse,
              sizeLimiter,
              hashStream,
              fs.createWriteStream(tempFile),
            );
            resolve({
              statusCode,
              headers: upstreamResponse.headers,
              localSha: hash.digest('hex').toLowerCase(),
            });
          } catch (error) {
            reject(error);
          }
        });
        upstreamRequest.setTimeout(Math.max(serverConfig.assetServiceRequestTimeoutMs, 5 * 60_000), () => {
          upstreamRequest.destroy(new Error('Artifact download timed out.'));
        });
        upstreamRequest.on('error', reject);
        upstreamRequest.end();
      });
      if (artifactResponse.statusCode < 200 || artifactResponse.statusCode >= 300) {
        sendAssetProcessingError(
          response,
          artifactResponse.statusCode,
          'ASSET_ARTIFACT_DOWNLOAD_FAILED',
          'Asset service artifact download failed.',
          requestId,
        );
        return;
      }
      const headerSha = Array.isArray(artifactResponse.headers['x-artifact-sha256'])
        ? artifactResponse.headers['x-artifact-sha256'][0]?.toLowerCase()
        : artifactResponse.headers['x-artifact-sha256']?.toLowerCase();
      if (!headerSha || expectedSha !== headerSha || expectedSha !== artifactResponse.localSha) {
        sendAssetProcessingError(
          response,
          502,
          'ASSET_ARTIFACT_SHA_MISMATCH',
          'Artifact SHA-256 verification failed; download was blocked.',
          requestId,
        );
        return;
      }

      const fileName = safeArtifactFileName(artifact.filename ?? artifact.name);
      const stat = await fs.promises.stat(tempFile);
      response.writeHead(200, {
        ...corsHeaders(response),
        'content-type': artifact.content_type || 'application/octet-stream',
        'content-length': stat.size,
        'content-disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
        'cache-control': 'no-store',
        'x-artifact-sha256': artifactResponse.localSha,
        'x-li3d-artifact-verified': 'true',
        'x-li3d-request-id': requestId,
      });
      await pipeline(fs.createReadStream(tempFile), response);
    } finally {
      await fs.promises.rm(tempDirectory, { recursive: true, force: true });
    }
  } catch (error) {
    if (!response.headersSent) {
      const sizeLimitExceeded = error instanceof ArtifactSizeLimitError;
      sendAssetProcessingError(
        response,
        sizeLimitExceeded ? 413 : 502,
        sizeLimitExceeded ? 'ASSET_ARTIFACT_TOO_LARGE' : 'ASSET_ARTIFACT_DOWNLOAD_FAILED',
        sizeLimitExceeded
          ? 'Asset artifact exceeds the configured size limit.'
          : 'Verified artifact download failed.',
        requestId,
      );
    } else {
      response.destroy(error instanceof Error ? error : undefined);
    }
  }
}
