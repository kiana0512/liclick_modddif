import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');
const webDist = path.join(repoRoot, 'apps', 'web', 'dist');
const host = process.env.LICLICK_WEB_HOST ?? '127.0.0.1';
const port = Number(process.env.LICLICK_WEB_PORT ?? 5673);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

function send(response, status, body, headers = {}) {
  response.writeHead(status, headers);
  response.end(body);
}

function resolveRequestPath(url) {
  const pathname = decodeURIComponent(url.pathname);
  const cleaned = pathname.replace(/^\/+/, '');
  const candidate = path.resolve(webDist, cleaned || 'index.html');
  if (!candidate.startsWith(webDist)) return undefined;
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  return path.join(webDist, 'index.html');
}

if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  console.error(`Liclick web dist was not found: ${webDist}`);
  process.exit(1);
}

const server = http.createServer((request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);
    const filePath = resolveRequestPath(url);
    if (!filePath) {
      send(response, 403, 'Forbidden', { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      'content-type': mimeTypes[extension] ?? 'application/octet-stream',
      'cache-control': extension === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(filePath).pipe(response);
  } catch (error) {
    console.error('[Liclick Web Server]', error);
    send(response, 500, 'Internal server error', { 'content-type': 'text/plain; charset=utf-8' });
  }
});

server.listen(port, host, () => {
  console.log(`Liclick web server running at http://${host}:${port}`);
  console.log(`Serving: ${webDist}`);
});
