import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, configFile: false,
  plugins: [{ name: 'camera-fixture', enforce: 'pre', transform(code, id) {
    if (process.env.CAMERA_PROJECTION_BASELINE && id.endsWith('/viewport/CameraController.tsx')) {
      return execFileSync('git', ['show', `${process.env.CAMERA_PROJECTION_BASELINE}:apps/web/src/engine/viewport/CameraController.tsx`], { cwd: root, encoding: 'utf8' });
    }
    return code;
  }, configureServer(server) {
    server.middlewares.use('/__fixture', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><link rel="icon" href="data:,"><title>Projection switch</title>'); });
  } }], esbuild: { jsx: 'automatic' },
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'three', '@react-three/fiber', '@react-three/drei', 'zustand', 'zustand/middleware'] },
  resolve: { alias: { '@': `${root}/src` } },
  server: { host: '127.0.0.1', port: 0, watch: { ignored: () => true } },
});
let browser;
try {
  await server.listen(); browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + '__fixture');
  const result = await page.evaluate(async () => (await import('/scripts/camera-projection-switch-fixture.tsx')).run());
  assert.deepEqual(errors, []); console.log(JSON.stringify(result));
} finally { await browser?.close(); await server.close(); }
