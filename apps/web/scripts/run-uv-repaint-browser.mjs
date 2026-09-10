import { createServer } from 'vite';
import { fileURLToPath, pathToFileURL } from 'node:url';
const playwright = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  root,
  cacheDir: 'node_modules/.vite-uv-repaint-fixture',
  configFile: false,
  optimizeDeps: {
    entries: ['scripts/uv-repaint-viewport-fixture.mjs', 'scripts/uv-repaint-browser-fixture.mjs'],
  },
  resolve: { alias: { '@': `${root}/src` } },
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/__fixture', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>UV repaint regression</title>');
});
for (const path of ['/api/local-settings', '/api/identity/status'])
  server.middlewares.use(path, (_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end('{}');
  });
await server.listen();
const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
const errors = [];
try {
  const page = await browser.newPage();
  for (const path of ['**/api/local-settings', '**/api/identity/status', '**/__li3d_eraser_perf'])
    await page.route(path, (route) => route.fulfill({ json: {} }));
  page.on('response', (response) => {
    if (response.status() >= 400) console.log('HTTP', response.status(), response.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`${server.resolvedUrls.local[0]}__fixture`);
  const result = await page.evaluate(async () =>
    (await import('/scripts/uv-repaint-browser-fixture.mjs')).run(),
  );
  if (process.argv.includes('--perf'))
    console.log(
      JSON.stringify(
        await page.evaluate(async () =>
          (await import('/scripts/uv-repaint-performance-fixture.mjs')).run(),
        ),
      ),
    );
  if (process.argv.includes('--viewport')) {
    await page.evaluate(async () =>
      (await import('/scripts/uv-repaint-viewport-fixture.mjs')).setup(),
    );
    const box = await page.locator('canvas').first().boundingBox();
    const click = () => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await click();
    await page.mouse.move(20, 20);
    await page.waitForFunction(async () => (await window.uvFixture.state()).painted > 0);
    const painted = await page.evaluate(() => window.uvFixture.state());
    await page.evaluate(() => window.uvFixture.erase());
    await page.waitForTimeout(150);
    await click();
    await page.waitForFunction(async () => (await window.uvFixture.state()).center[3] === 0);
    await page.evaluate(() => window.uvFixture.undo());
    await page.waitForFunction(async () => (await window.uvFixture.state()).center[3] > 0);
    const restored = await page.evaluate(() => window.uvFixture.state());
    if (restored.painted !== painted.painted)
      throw Error('Viewport undo did not restore exact coverage');
    const fbxColor = await page.evaluate(() => window.uvFixture.fbxTexture());
    if (fbxColor.some((value, i) => value !== restored.center[i]))
      throw Error(`FBX color differs from native UV ${fbxColor} vs ${restored.center}`);
    await page.evaluate(() => window.uvFixture.reopen());
    const reopened = await page.evaluate(() => window.uvFixture.state());
    if (reopened.painted !== restored.painted || reopened.layer.id !== restored.layer.id)
      throw Error('Reopen lost coverage or duplicated layer');
    await click();
    if (process.env.UV_REPAINT_SCREENSHOT)
      await page.screenshot({ path: process.env.UV_REPAINT_SCREENSHOT });
    console.log(
      JSON.stringify({
        viewport: 'paint/eraser/undo/PNG/FBX/reopen',
        painted: painted.painted,
        fbxColor,
        png: await page.evaluate(() => window.uvFixture.png()),
      }),
    );
    await page.evaluate(() => window.uvFixture.close());
  }
  if (errors.length) throw Error(errors.join('\n'));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(errors.join('\n'));
  throw error;
} finally {
  await browser.close();
  await server.close();
}
