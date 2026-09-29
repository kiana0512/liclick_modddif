import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { functionTimingPlugin } from './scripts/function-timing.mjs';
import react from '@vitejs/plugin-react';
import { shaderTemplateFormatPlugin } from './scripts/shader-template-format.mjs';
import { shaderChunkPackPlugin } from './scripts/shader-chunk-pack.mjs';
import { stringPoolPlugin } from './scripts/string-pool.mjs';

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

const cloudAllowedToolboxAssets = new Set([
  'toolbox/manual_max.html',
  'toolbox/modeling-toolbox-icon.png',
  'toolbox/modeling-toolbox-v2.0.1.exe',
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
          const isAllowedToolboxAsset = cloudAllowedToolboxAssets.has(lowerRelative);
          if (
            lowerRelative.startsWith('downloads/local-component/') ||
            (lowerRelative.startsWith('toolbox/') && !isAllowedToolboxAsset) ||
            (cloudForbiddenPublicExtensions.has(path.extname(lowerRelative)) &&
              !isAllowedToolboxAsset)
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
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, 'VITE_');
  const traceEnabled = process.env.LI3D_DEBUG_BUILD === 'true' && !env.VITE_LICLICK_RELEASE_ID;
  return {
  // Explicit defaults let Rollup remove probes before cross-chunk exports form.
  define: {
    'import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED': JSON.stringify(String(traceEnabled)),
  },
  plugins: [functionTimingPlugin(traceEnabled), { name: 'trace-build-identity', generateBundle() { this.emitFile({ type: 'asset', fileName: 'trace-build.json', source: JSON.stringify({ enabled: traceEnabled }) }); } }, shaderTemplateFormatPlugin(), shaderChunkPackPlugin(), stringPoolPlugin(), cloudPublicAssetsPlugin(), eraserPerformanceDiagnosticsPlugin(publicBase), react()],
  publicDir: false,
  base: publicBase,
  // THIRD_PARTY_NOTICES.txt is shipped with every cloud artifact. Avoid
  // repeating the same dependency license banners inside multiple lazy JS
  // chunks; this keeps route budgets focused on executable payload bytes.
  esbuild: { legalComments: 'none' },
  build: {
    // Production-only compression: preserve diagnostics and public property
    // names while removing more redundant expressions than the fast dev tool.
    minify: 'terser',
    terserOptions: {
      ecma: 2020,
      compress: { passes: 4, drop_console: false, unsafe: false },
      mangle: { properties: false },
      // Licenses remain available in the shipped THIRD_PARTY_NOTICES.txt.
      format: { comments: false },
    },
    // The zero-install client already requires modern browser primitives such as
    // Web Workers, WebGL2 and the File System APIs. Avoid transpiling the same
    // code back to legacy syntax that those supported browsers do not need.
    target: 'es2022',
    rollupOptions: {
      output: {
        // Keep the presentation-only selection kernel independently cacheable;
        // do not pull its shared Three dependency out of the shared 3D chunk.
        onlyExplicitManualChunks: true,
        // Zod is stable vendor code shared by editor and bake routes. Keep it
        // cacheable outside the large viewport snapshot instead of reparsing it
        // as part of that feature chunk on every release.
        manualChunks(id) {
          // Pure color kernels are shared by resident preview, merge and export.
          // Keep one cacheable module rather than embedding them in the snapshot route.
          if (id.endsWith('/engine/bake/qualityBlendCpuPixel.ts') || id.endsWith('/engine/layers/linearUnderComposite.ts')) return 'uv-color-math';
          if (id.endsWith('/engine/localRepaint/projectedSelectionDisplay.ts')) return 'projected-selection-display';
          // Shared image I/O must not make the lazy silhouette clip import the editor route.
          if (id.endsWith('/engine/localRepaint/imageUtils.ts')) return 'local-repaint-image-utils';
          if (id.includes('/node_modules/.pnpm/zod@')) return 'vendor-zod';
          return undefined;
        },
      },
    },
  },
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
  };
});
