import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, configFile: false,
  resolve: { alias: { '@': `${root}/src` } },
  server: { host: '127.0.0.1', port: 0, watch: { ignored: () => true } },
});
server.middlewares.use('/__fixture', (_req, res) => res.end('<!doctype html><title>UV alpha edge regression</title>'));
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
    return [await topology(), await run(0), await run(0.7)];
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(result));
} finally { await browser?.close(); await server.close(); }
