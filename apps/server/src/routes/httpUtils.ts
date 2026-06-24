import type { IncomingMessage, ServerResponse } from 'node:http';
import { serverConfig } from '../config.js';

const allowedOrigins = new Set(serverConfig.allowedOrigins);

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
  const requestOrigin = response.req.headers.origin;
  const allowOrigin = requestOrigin && allowedOrigins.has(requestOrigin) ? requestOrigin : serverConfig.frontendOrigin;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  response.end(JSON.stringify(data));
}

export function sendNoContent(response: ServerResponse) {
  const requestOrigin = response.req.headers.origin;
  const allowOrigin = requestOrigin && allowedOrigins.has(requestOrigin) ? requestOrigin : serverConfig.frontendOrigin;
  response.writeHead(204, {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  response.end();
}

export function getPathSegments(url: URL) {
  return url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
}
