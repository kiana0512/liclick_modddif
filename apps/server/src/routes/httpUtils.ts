import type { IncomingMessage, ServerResponse } from 'node:http';
import { serverConfig } from '../config.js';

const allowedOrigins = new Set(serverConfig.allowedOrigins);
const defaultJsonBodyLimitBytes = 8 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body is too large.');
    this.name = 'RequestBodyTooLargeError';
  }
}

export function isAllowedRequestOrigin(request: IncomingMessage) {
  const origin = request.headers.origin;
  return !origin || allowedOrigins.has(origin);
}

export function corsHeaders(response: ServerResponse) {
  const requestOrigin = response.req.headers.origin;
  const allowOrigin =
    requestOrigin && allowedOrigins.has(requestOrigin)
      ? requestOrigin
      : serverConfig.frontendOrigin;
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-private-network': 'true',
    'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers':
      'content-type,x-liclick-session-token,x-li3d-feishu-email,x-li3d-identity-proof,x-li3d-history-source-name,x-li3d-history-metadata,x-li3d-history-batch-id,x-li3d-history-batch-index,x-li3d-history-batch-size,x-request-id,idempotency-key,last-event-id',
    'access-control-expose-headers':
      'content-disposition,x-job-id,x-request-id,x-li3d-request-id,x-artifact-sha256,x-li3d-artifact-verified',
    vary: 'Origin',
  };
}

export async function readJsonBody<T>(
  request: IncomingMessage,
  maxBytes = defaultJsonBodyLimitBytes,
): Promise<T> {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestBodyTooLargeError();
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      request.pause();
      throw new RequestBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

export async function readBinaryBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

export function sendJson(response: ServerResponse, statusCode: number, data: unknown) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...corsHeaders(response),
  });
  response.end(JSON.stringify(data));
}

export function sendNoContent(response: ServerResponse) {
  response.writeHead(204, corsHeaders(response));
  response.end();
}

export function sendRequestFailure(response: ServerResponse, error: unknown) {
  if (response.destroyed || response.writableEnded) return;
  // Once a file/stream has started, a JSON response would corrupt its body and
  // writeHead would throw outside the request handler's catch block.
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof RequestBodyTooLargeError) {
    response.setHeader('connection', 'close');
    sendJson(response, 413, { error: error.message });
    return;
  }
  sendJson(response, 500, { error: 'Internal server error.' });
}

export function getPathSegments(url: URL) {
  return url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
}
