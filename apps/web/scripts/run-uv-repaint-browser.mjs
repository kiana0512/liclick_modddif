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
    const beforeSecond = await page.evaluate(() => window.uvFixture.pixels());
    await page.evaluate(() => window.uvFixture.nextLayer());
    const preparedSecond = await page.evaluate(() => window.uvFixture.pixels());
    if (preparedSecond[0].some((value, i) => value !== beforeSecond[0][i]))
      throw Error('Activating a new repaint brush hid the previous layer');
    await page.mouse.click(box.x + box.width / 2 + 100, box.y + box.height / 2);
    await page.mouse.move(20, 20);
    await page.waitForFunction(async (oldId) => {
      const state = await window.uvFixture.state();
      return state.layer?.id !== oldId && state.painted > 0;
    }, restored.layer.id);
    const second = await page.evaluate(() => window.uvFixture.state());
    const both = await page.evaluate(() => window.uvFixture.pixels());
    const same = (a, b) => a.every((value, i) => Math.abs(value - b[i]) <= 1);
    if (!same(beforeSecond[0], both[0]) || both[1][1] <= both[1][0] * 1.5)
      throw Error(`Two UV layers must coexist: ${JSON.stringify({ beforeSecond, both })}`);
    await click();
    await page.mouse.move(20, 20);
    const overlap = await page.evaluate(() => window.uvFixture.pixels());
    if (!same(overlap[0], both[1])) throw Error('Top repaint did not cover the lower layer');
    await page.evaluate(() => window.uvFixture.undo());
    const unoverlapped = await page.evaluate(() => window.uvFixture.pixels());
    if (!unoverlapped.every((pixel, i) => same(pixel, both[i])))
      throw Error('Undo of overlapping stroke did not reveal the lower layer');
    await page.evaluate(() => window.uvFixture.erase());
    await page.waitForTimeout(150);
    await page.mouse.click(box.x + box.width / 2 + 100, box.y + box.height / 2);
    await page.mouse.move(20, 20);
    const erasedSecond = await page.evaluate(() => window.uvFixture.pixels());
    if (!same(erasedSecond[0], both[0]) || same(erasedSecond[1], both[1]))
      throw Error('Erasing new layer damaged old layer or failed to erase');
    await page.evaluate(() => window.uvFixture.undo());
    const undoSecond = await page.evaluate(() => window.uvFixture.pixels());
    if (!undoSecond.every((pixel, i) => same(pixel, both[i])))
      throw Error('Undo on second layer did not restore both layers');
    await page.evaluate((id) => window.uvFixture.visibility(id, false), second.layer.id);
    const oldOnly = await page.evaluate(() => window.uvFixture.pixels());
    if (!same(beforeSecond[0], oldOnly[0]) || !same(beforeSecond[1], oldOnly[1]))
      throw Error(`Hiding new layer changed old layer: ${JSON.stringify(oldOnly)}`);
    await page.evaluate((id) => window.uvFixture.visibility(id, true), second.layer.id);
    await page.evaluate((id) => window.uvFixture.visibility(id, false), restored.layer.id);
    const newOnly = await page.evaluate(() => window.uvFixture.pixels());
    if (same(both[0], newOnly[0]) || !same(both[1], newOnly[1]))
      throw Error(`Layer visibility is not independent: ${JSON.stringify(newOnly)}`);
    await page.evaluate((id) => window.uvFixture.visibility(id, true), restored.layer.id);
    const restoredBoth = await page.evaluate(() => window.uvFixture.pixels());
    if (!restoredBoth.every((pixel, i) => same(pixel, both[i])))
      throw Error('Restoring visibility did not restore both layers');
    console.log(JSON.stringify({ coexistence: 'two native UV layers / independent visibility', both, oldOnly, newOnly }));
    await page.evaluate(() => window.uvFixture.nextLayer('fixture-gen-third', '#2244dd'));
    await page.mouse.click(box.x + box.width / 2 - 100, box.y + box.height / 2);
    await page.mouse.move(20, 20);
    await page.waitForFunction(async () => {
      const pixels = await window.uvFixture.pixels([0, 100, -100]);
      return pixels[0][0] > 180 && pixels[1][1] > 160 && pixels[2][2] > 180;
    });
    const three = await page.evaluate(() => window.uvFixture.pixels([0, 100, -100]));
    if (!same(three[0], both[0]) || !same(three[1], both[1]))
      throw Error(`Three-layer compositor changed earlier patches: ${JSON.stringify(three)}`);
    console.log(JSON.stringify({ coexistence: 'three native UV layers / lower-layer composite', three }));
    await page.evaluate(() => window.uvFixture.addBase());
    await page.waitForFunction(async () => {
      const pixels = await window.uvFixture.pixels([0, 100, -100, 50]);
      return pixels[0][0] > 180 && pixels[1][1] > 160 && pixels[2][2] > 180 && pixels[3][0] > 100;
    });
    const mixed = await page.evaluate(() => window.uvFixture.pixels([0, 100, -100]));
    if (!mixed.every((pixel, i) => same(pixel, three[i])))
      throw Error(`Ordinary UV base suppressed lower repaint layers: ${JSON.stringify(mixed)}`);
    await page.evaluate(() => window.uvFixture.visibility('fixture-base', false));
    await page.waitForFunction(async () => (await window.uvFixture.pixels([50]))[0][0] < 100);
    console.log(JSON.stringify({ coexistence: 'merged UV base / hide base without losing repaint', mixed }));
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
