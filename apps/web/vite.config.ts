import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

function normalizeBase(value?: string) {
  const normalized = `/${(value ?? '/').split('/').filter(Boolean).join('/')}`;
  return normalized === '/' ? '/' : `${normalized}/`;
}

const cloudForbiddenPublicExtensions = new Set([
  '.bat',
  '.bin',
  '.cmd',
  '.dll',
  '.exe',
  '.msi',
  '.ps1',
]);

function cloudPublicAssetsPlugin(): Plugin {
  const publicRoot = path.resolve(rootDir, 'public');
  return {
    name: 'li3d-cloud-public-assets',
    apply: 'build',
    buildStart() {
      const visit = (directory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const candidate = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            visit(candidate);
            continue;
          }
          const relative = path.relative(publicRoot, candidate).replaceAll('\\', '/');
          const lowerRelative = relative.toLowerCase();
          if (
            lowerRelative.startsWith('downloads/local-component/') ||
            (lowerRelative.startsWith('toolbox/') &&
              lowerRelative !== 'toolbox/modeling-toolbox-icon.png') ||
            cloudForbiddenPublicExtensions.has(path.extname(lowerRelative))
          ) {
            continue;
          }
          this.emitFile({
            type: 'asset',
            fileName: relative,
            source: fs.readFileSync(candidate),
          });
        }
      };
      visit(publicRoot);
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
  plugins: [cloudPublicAssetsPlugin(), eraserPerformanceDiagnosticsPlugin(publicBase), react()],
  publicDir: false,
  base: publicBase,
  resolve: {
    alias: [
      ...[
        {
          find: /^\.\/workspaceApiBase$/,
          replacement: path.resolve(rootDir, 'src/services/workspaceApiBase.cloud.ts'),
        },
        {
          find: /^@\/platform\/projectApiBase$/,
          replacement: path.resolve(rootDir, 'src/platform/projectApiBase.cloud.ts'),
        },
        {
          find: /^\.\/liclickTransport$/,
          replacement: path.resolve(rootDir, 'src/services/liclickTransport.cloud.ts'),
        },
        {
          find: /^@\/services\/nativePerformanceClient$/,
          replacement: path.resolve(rootDir, 'src/services/nativePerformanceClient.cloud.ts'),
        },
        {
          find: /^@\/features\/photoshop\/photoshopBridgeClient$/,
          replacement: path.resolve(
            rootDir,
            'src/features/photoshop/photoshopBridgeClient.cloud.ts',
          ),
        },
      ],
      { find: '@', replacement: path.resolve(rootDir, 'src') },
    ],
  },
  server: { proxy: {} },
});
