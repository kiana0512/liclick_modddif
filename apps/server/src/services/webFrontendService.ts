import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serverConfig } from '../config.js';

const installerRoute = '/downloads/LIclick-3D-Texture-Local-Component-Setup.exe';

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

type InstallerManifest = {
  filename: string;
  contentType: string;
  bytes: number;
  sha256: string;
  parts: Array<{ file: string; bytes: number; sha256: string }>;
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

function readInstallerManifest() {
  const manifestPath = path.join(
    serverConfig.webDistDir,
    'downloads',
    'local-component',
    'manifest.json',
  );
  if (!fs.existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as InstallerManifest;
  if (
    !manifest.filename ||
    !manifest.contentType ||
    !Number.isFinite(manifest.bytes) ||
    !manifest.sha256 ||
    !Array.isArray(manifest.parts) ||
    manifest.parts.length === 0
  ) {
    throw new Error('Local component installer manifest is invalid.');
  }
  return manifest;
}

async function pipeFile(filePath: string, response: ServerResponse) {
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.once('error', reject);
    stream.once('end', resolve);
    stream.pipe(response, { end: false });
  });
}

async function serveInstaller(request: IncomingMessage, response: ServerResponse) {
  const manifest = readInstallerManifest();
  if (!manifest) {
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'Local component installer is not available.' }));
    return;
  }

  const partsRoot = path.resolve(serverConfig.webDistDir, 'downloads', 'local-component');
  const partPaths = manifest.parts.map((part) => {
    const candidate = path.resolve(partsRoot, part.file);
    if (!isWithinDirectory(partsRoot, candidate) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      throw new Error(`Local component installer part is unavailable: ${part.file}`);
    }
    return candidate;
  });

  response.writeHead(200, {
    'content-type': manifest.contentType,
    'content-disposition': `attachment; filename="LIclick-3D-Texture-Local-Component-Setup.exe"; filename*=UTF-8''${encodeURIComponent(manifest.filename)}`,
    'content-length': String(manifest.bytes),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-li3d-installer-sha256': manifest.sha256,
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  try {
    for (const partPath of partPaths) await pipeFile(partPath, response);
    response.end();
  } catch (error) {
    response.destroy(error instanceof Error ? error : new Error('Installer stream failed.'));
  }
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
  if (url.pathname === installerRoute) {
    await serveInstaller(request, response);
    return true;
  }

  const filePath = resolveStaticFile(url);
  if (!filePath) {
    sendUnavailable(response);
    return true;
  }
  const stat = fs.statSync(filePath);
  const isIndex = path.basename(filePath).toLowerCase() === 'index.html';
  response.writeHead(200, {
    ...responseHeaders(filePath, isIndex ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600'),
    'content-length': String(stat.size),
  });
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(filePath).pipe(response);
  return true;
}
