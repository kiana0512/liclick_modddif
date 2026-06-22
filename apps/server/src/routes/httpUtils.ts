import type { IncomingMessage, ServerResponse } from 'node:http';
import { serverConfig } from '../config.js';

const allowedOrigins = new Set([
  serverConfig.frontendUrl,
  'http://127.0.0.1:5173',
  'http://localhost:5173',
]);

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

export function sendJson(response: ServerResponse, statusCode: number, data: unknown) {
  const requestOrigin = response.req.headers.origin;
  const allowOrigin = requestOrigin && allowedOrigins.has(requestOrigin) ? requestOrigin : serverConfig.frontendUrl;
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
  const allowOrigin = requestOrigin && allowedOrigins.has(requestOrigin) ? requestOrigin : serverConfig.frontendUrl;
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
