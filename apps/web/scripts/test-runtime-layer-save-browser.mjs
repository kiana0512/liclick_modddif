/* global location, fetch, Image */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const assets = new Map();
const server = await createServer({ root, configFile: false,
  resolve: { alias: { '@': `${root}/src` } },
  plugins: [{ name: 'isolated-uv-assets', configureServer(server) {
    server.middlewares.use('/__uv-save', handleAssetRequest);
  } }],
  server: { host: '127.0.0.1', port: 0 },
});
async function handleAssetRequest(request, response) {
  if (request.url === '/page') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Isolated UV persistence regression</title>');
  } else if (request.method === 'POST') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assets.set(request.url, Buffer.concat(chunks));
    response.end('ok');
  } else if (assets.has(request.url)) {
    response.setHeader('Content-Type', 'image/png');
    response.end(assets.get(request.url));
  } else { response.statusCode = 404; response.end(); }
}
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}__uv-save/page`);
  const saved = await page.evaluate(async () => {
    const registry = await import('/src/engine/projection/liveProjectedCanvasTextureRegistry.ts');
    const { persistRuntimeLayerAssets } = await import('/src/services/runtimeLayerAssetPersistence.ts');
    const layers = [0, 1].map((index) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d');
      context.fillStyle = index ? '#20a0e0' : '#e06020';
      context.fillRect(8 + index * 16, 8, 16, 16);
      const texture = {};
      const imageUrl = registry.registerLiveUvRenderTarget(`browser-${index}`, canvas, texture);
      // Same transition as ViewportCanvas cleanup: release GPU, retain committed CPU bytes.
      registry.unregisterLiveUvRenderTarget(imageUrl, texture);
      return { id: `uv-${index}`, type: 'uv', role: 'local-repaint-overlay',
        imageUrl, visible: true, objectId: 'synthetic-model', localRepaintSourceUrl: 'original-source' };
    });
    const project = { id: 'synthetic-project', layers };
    const result = await persistRuntimeLayerAssets(project, async (blob, filename) => {
      const url = `${location.origin}/__uv-save/${filename}`;
      const response = await fetch(url, { method: 'POST', body: blob });
      if (!response.ok) throw Error(`Test upload failed: ${response.status}`);
      return url;
    });
    return { result, runtimeUrls: layers.map((layer) => layer.imageUrl) };
  });
  await page.reload();
  const restored = await page.evaluate(async ({ result, runtimeUrls }) => {
    const registry = await import('/src/engine/projection/liveProjectedCanvasTextureRegistry.ts');
    if (runtimeUrls.some((url) => registry.getLiveProjectedTextureSourceState(url)))
      throw Error('Reload did not clear the synthetic registry');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d');
    for (const layer of result.layers) {
      const image = new Image();
      image.src = layer.imageUrl;
      await image.decode();
      if (image.width !== 64 || image.height !== 64) throw Error('Resolution changed');
      context.drawImage(image, 0, 0);
    }
    return [0, 8, 24].map((x) => [...context.getImageData(x, 8, 1, 1).data]);
  }, saved);
  assert.deepEqual(restored, [[0, 0, 0, 0], [224, 96, 32, 255], [32, 160, 224, 255]]);
  assert.deepEqual(errors, []);
  console.log('Real browser: GPU release -> two UV PNG uploads -> full reload -> both layers/alpha/colors preserved.');
} finally {
  await browser?.close();
  await server.close();
}
