import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serverConfig } from '../config.js';
import { streamFileResponse } from './fileResponseService.js';

const mimeTypes: Record<string, string> = {
  '.avif': 'image/avif',
  '.bin': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function isWithinDirectory(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function responseHeaders(filePath: string, cacheControl = 'no-cache') {
  return {
    'content-type': mimeTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  };
}

function sendUnavailable(response: ServerResponse) {
  response.writeHead(503, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end('LI3D Web 前端尚未构建，请先运行 Web build。');
}

function sendStaticNotFound(response: ServerResponse) {
  response.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end('Not found.');
}

function resolveStaticFile(url: URL) {
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(url.pathname).replaceAll('\\', '/').replace(/^\/+/, '');
  } catch {
    return undefined;
  }
  const webRoot = path.resolve(serverConfig.webDistDir);
  const candidate = path.resolve(webRoot, relativePath || 'index.html');
  if (!isWithinDirectory(webRoot, candidate)) return undefined;
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  // Only extensionless application routes may fall back to the SPA shell.
  // Returning index.html for a missing hashed JS/CSS asset produces a misleading
  // HTTP 200 and makes dynamic imports fail later with a MIME/module error.
  if (path.posix.extname(url.pathname) !== '') return undefined;
  const indexPath = path.resolve(webRoot, 'index.html');
  return fs.existsSync(indexPath) && fs.statSync(indexPath).isFile() ? indexPath : undefined;
}

export async function serveWebFrontend(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  if (!serverConfig.serveWeb) return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const filePath = resolveStaticFile(url);
  if (!filePath) {
    const indexPath = path.resolve(serverConfig.webDistDir, 'index.html');
    if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) sendStaticNotFound(response);
    else sendUnavailable(response);
    return true;
  }
  const stat = fs.statSync(filePath);
  const isIndex = path.basename(filePath).toLowerCase() === 'index.html';
  response.writeHead(200, {
    ...responseHeaders(filePath, isIndex ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600'),
    'content-length': String(stat.size),
  });
  if (request.method === 'HEAD') response.end();
  else streamFileResponse(filePath, response);
  return true;
}
