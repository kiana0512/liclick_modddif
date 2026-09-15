import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const server = await createServer({ root, configFile: false,
  resolve: { alias: { '@': root + '/src' } },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/*'] } },
  optimizeDeps: { noDiscovery: true },
  plugins: [{ name: 'underlay-reuse-qa', configureServer(s) {
    s.middlewares.use('/__fixture', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>LI3D underlay reuse QA</title><body>Isolated synthetic 4K test</body>');
    });
  } }],
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + '__fixture?perfLab=1&perfWebGpuAb=1');
  const result = await page.evaluate(async () => {
    const { compositeRgbaUrlUnderWithWebGpu: composite, releaseWebGpuRgbaCompositeResources: release } =
      await import('/src/engine/performance/webGpuRgbaComposite.ts');
    const size = 4096, source = new Uint8ClampedArray(size * size * 4), front = source.slice();
    for (let i = 0; i < source.length; i += 4) {
      source[i] = (i / 4) % 251; source[i + 1] = (i / size / 4) % 241;
      source[i + 2] = 90; source[i + 3] = i % 12 ? 128 : 255;
      front[i] = 130; front[i + 1] = 75; front[i + 2] = 43; front[i + 3] = i % 16 ? 96 : 0;
    }
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    canvas.getContext('2d').putImageData(new ImageData(source, size, size), 0, 0);
    const url = URL.createObjectURL(await new Promise(resolve => canvas.toBlob(resolve)));
    canvas.width = canvas.height = 0;
    const rows = [];
    try {
      for (const interactive of [false, true]) {
        document.body.dataset.perfSimulatedViewportInteraction = interactive ? '1' : '0';
        release();
        const run = async key => {
          const input = front.slice(), start = performance.now();
          const result = await composite(input, url, size, size, 0.7, undefined, false, key);
          return { ...result, ms: performance.now() - start };
        };
        const cold = await run('synthetic:1');
        for (let round = 0; round < 3; round++) {
          // Warm the byte-verified identity explicitly; a missing revision now
          // also supports verified decode reuse on the integrated branch.
          const uncached = await run('fresh:' + round);
          await run('synthetic:1');
          const cached = await run('synthetic:1');
          let byteDifferences = 0;
          for (let i = 0; i < cached.data.length; i++) byteDifferences += Number(cached.data[i] !== uncached.data[i]);
          if (byteDifferences) throw Error('Cached 4K pixels differ');
          rows.push({ interactive, round, coldMs: cold.ms, uncachedMs: uncached.ms, cachedMs: cached.ms,
            backend: cached.metrics.backend, byteDifferences,
            gpuByteMismatches: cached.verification?.byteMismatches ?? null });
        }
      }
    } finally { delete document.body.dataset.perfSimulatedViewportInteraction; release(); URL.revokeObjectURL(url); }
    return { resolution: size, rows };
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); await server.close(); }
