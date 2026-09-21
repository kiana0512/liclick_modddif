import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, configFile: false,
  plugins: [{ name: 'uv-alpha-test-page', configureServer(server) {
    server.middlewares.use('/__fixture', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><link rel="icon" href="data:,"><title>UV alpha edge regression</title>');
    });
  } }],
  cacheDir: 'node_modules/.vite-uv-alpha-edge-fixture',
  optimizeDeps: { noDiscovery: true, include: ['three', 'fflate', 'zustand', 'zustand/middleware', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
  resolve: { alias: { '@': `${root}/src` } },
  server: { host: '127.0.0.1', port: 0, watch: { ignored: () => true } },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  for (const path of ['**/api/local-settings', '**/api/identity/status', '**/__li3d_eraser_perf'])
    await page.route(path, route => route.fulfill({ json: {} }));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(server.resolvedUrls.local[0] + '__fixture');
  const result = await page.evaluate(async () => {
    const { run } = await import('/scripts/uv-repaint-alpha-edge-fixture.mjs');
    const { run: topology } = await import('/scripts/uv-gutter-raster-fixture.mjs');
    const { run: islands } = await import('/scripts/uv-repaint-island-edge-fixture.mjs');
    const { run: inward } = await import('/scripts/uv-repaint-inward-stroke-fixture.mjs');
    return [await topology(), await run(0), await run(0.7),
      await islands(64), await islands(512), await islands(2048, 0.4), await islands(4096, 0.4),
      await inward(2048), await inward(2048, .45), await inward(4096)];
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(result));
} finally { await browser?.close(); await server.close(); }
