import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

type LocalInstallerManifest = {
  filename: string;
  contentType: string;
  bytes: number;
  parts: Array<{ file: string; bytes: number }>;
};

function normalizeBase(value?: string) {
  const normalized = `/${(value ?? '/').split('/').filter(Boolean).join('/')}`;
  return normalized === '/' ? '/' : `${normalized}/`;
}

function isWithinDirectory(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function pipeFile(filePath: string, response: ServerResponse) {
  return new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.once('error', reject);
    stream.once('end', resolve);
    stream.pipe(response, { end: false });
  });
}

async function serveLocalInstaller(response: ServerResponse, method: string) {
  const partsRoot = path.resolve(rootDir, 'public', 'downloads', 'local-component');
  const manifestPath = path.join(partsRoot, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as LocalInstallerManifest;
  if (
    !manifest.filename ||
    !manifest.contentType ||
    !Number.isFinite(manifest.bytes) ||
    manifest.bytes <= 0 ||
    !Array.isArray(manifest.parts) ||
    manifest.parts.length === 0
  ) {
    throw new Error('Local component installer manifest is invalid.');
  }

  const partPaths = manifest.parts.map((part) => {
    const candidate = path.resolve(partsRoot, part.file);
    if (!isWithinDirectory(partsRoot, candidate)) {
      throw new Error(`Local component installer part escapes its directory: ${part.file}`);
    }
    const stat = fs.statSync(candidate);
    if (!stat.isFile() || stat.size !== part.bytes) {
      throw new Error(`Local component installer part is invalid: ${part.file}`);
    }
    return candidate;
  });
  const combinedBytes = manifest.parts.reduce((total, part) => total + part.bytes, 0);
  if (combinedBytes !== manifest.bytes) {
    throw new Error('Local component installer size does not match its manifest.');
  }

  response.writeHead(200, {
    'content-type': manifest.contentType,
    'content-disposition': `attachment; filename="LIclick-3D-Texture-Local-Component-Setup.exe"; filename*=UTF-8''${encodeURIComponent(manifest.filename)}`,
    'content-length': String(manifest.bytes),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (method === 'HEAD') {
    response.end();
    return;
  }
  for (const partPath of partPaths) await pipeFile(partPath, response);
  response.end();
}

function localInstallerPlugin(base: string): Plugin {
  const basePrefix = base === '/' ? '' : base.slice(0, -1);
  const installerRoute = `${basePrefix}/downloads/LIclick-3D-Texture-Local-Component-Setup.exe`;
  return {
    name: 'li3d-local-installer',
    configureServer(server) {
      server.middlewares.use((request: IncomingMessage, response: ServerResponse, next) => {
        const method = request.method?.toUpperCase() ?? 'GET';
        const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        if (pathname !== installerRoute || (method !== 'GET' && method !== 'HEAD')) {
          next();
          return;
        }
        void serveLocalInstaller(response, method).catch((error) => {
          if (response.headersSent) {
            response.destroy(error instanceof Error ? error : undefined);
            return;
          }
          response.writeHead(500, {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
          });
          response.end(error instanceof Error ? error.message : 'Local installer is unavailable.');
        });
      });
    },
  };
}

function eraserPerformanceDiagnosticsPlugin(base: string): Plugin {
  const basePrefix = base === '/' ? '' : base.slice(0, -1);
  const diagnosticsRoute = `${basePrefix}/__li3d_eraser_perf`;
  const diagnosticsPath = path.resolve(
    rootDir,
    '..',
    '..',
    '.codex-tmp',
    'eraser-performance.ndjson',
  );
  return {
    name: 'li3d-eraser-performance-diagnostics',
    configureServer(server) {
      server.middlewares.use((request: IncomingMessage, response: ServerResponse, next) => {
        const method = request.method?.toUpperCase() ?? 'GET';
        const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        if (pathname !== diagnosticsRoute || method !== 'POST') {
          next();
          return;
        }
        let body = '';
        let rejected = false;
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          if (rejected) return;
          body += chunk;
          if (body.length > 1_000_000) {
            rejected = true;
            response.writeHead(413, { 'cache-control': 'no-store' });
            response.end();
          }
        });
        request.on('end', () => {
          if (rejected) return;
          fs.mkdir(path.dirname(diagnosticsPath), { recursive: true }, (directoryError) => {
            if (directoryError) {
              response.writeHead(500, { 'cache-control': 'no-store' });
              response.end();
              return;
            }
            fs.appendFile(diagnosticsPath, `${body}\n`, 'utf8', (writeError) => {
              response.writeHead(writeError ? 500 : 204, { 'cache-control': 'no-store' });
              response.end();
            });
          });
        });
      });
    },
  };
}

const publicBase = normalizeBase(process.env.VITE_PUBLIC_PATH ?? process.env.VITE_BASE_PATH);

export default defineConfig({
  plugins: [
    localInstallerPlugin(publicBase),
    eraserPerformanceDiagnosticsPlugin(publicBase),
    react(),
  ],
  base: publicBase,
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
});
