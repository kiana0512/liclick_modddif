import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  root, configFile: false, cacheDir: 'node_modules/.vite-manual-repaint-fixture',
  resolve: { alias: { '@': root + '/src' } },
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/__fixture', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Manual UV repaint</title>');
});
await server.listen();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const path of ['**/api/local-settings', '**/api/identity/status', '**/__li3d_eraser_perf'])
    await page.route(path, route => route.fulfill({ json: {} }));
  await page.goto(server.resolvedUrls.local[0] + '__fixture');
  // Test the production warning notice without a blocking dialog/backdrop.
  const showDialog = () => page.evaluate(async () =>
    (await import('/scripts/uv-repaint-viewport-fixture.mjs')).showLayerDialog());
  await page.evaluate(async () => (await import('/scripts/uv-repaint-viewport-fixture.mjs')).setup({ manual: true }));
  await showDialog();
  await page.getByRole('status').waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.match(await page.getByRole('status').getAttribute('class'), /border-amber/);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  assert.equal(await page.evaluate(() => window.dialogResult), 'cancel');
  await showDialog();
  await page.getByRole('status').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.dialogResult), undefined);
  await page.getByRole('button', { name: '新建图层', exact: true }).click();
  assert.equal(await page.evaluate(() => window.dialogResult), 'create');
  const box = await page.locator('canvas').first().boundingBox();
  const click = async offset => {
    await page.mouse.click(box.x + box.width / 2 + offset, box.y + box.height / 2);
    await page.mouse.move(20, 20);
  };
  const state = () => page.evaluate(() => window.uvFixture.manualState());
  await click(0);
  await page.waitForFunction(async () => (await window.uvFixture.manualState())[0].red > 0);
  const first = (await state())[0];
  await page.evaluate(() => window.uvFixture.nextLayer());
  assert.deepEqual(await state(), [first], 'preparing second source must preserve exact old pixels and row');
  await click(100);
  await page.waitForFunction(async () => (await window.uvFixture.manualState())[0].green > 0);
  const second = (await state())[0];
  const visible = await page.evaluate(() => window.uvFixture.pixels([0, 100]));
  assert.ok(visible[0][0] > 180 && visible[1][1] > 150, 'both generations must be visible on the same UV layer');
  assert.equal(second.id, first.id);
  assert.equal(second.red, first.red, 'second generation recoloured old brushwork');
  await page.evaluate(() => window.uvFixture.roundTripManual());
  assert.deepEqual(await state(), [second], 'PNG save/reopen must restore exact colors and row identity');
  await page.evaluate(() => window.uvFixture.undo());
  await page.waitForFunction(async hash => (await window.uvFixture.manualState())[0].hash === hash, first.hash);
  await page.evaluate(() => window.uvFixture.redo());
  await page.waitForFunction(async hash => (await window.uvFixture.manualState())[0].hash === hash, second.hash);
  const idB = await page.evaluate(() => window.uvFixture.addManualLayer());
  await page.waitForFunction(id => document.body.dataset.localRepaintGpuReadyTarget === id, idB);
  await click(-100);
  await page.waitForFunction(async id => (await window.uvFixture.manualState()).find(row => row.id === id).green > 0, idB);
  let rows = await state();
  assert.deepEqual(rows.find(row => row.id === first.id), second, 'B stroke changed A');
  const rowB = rows.find(row => row.id === idB);
  await page.evaluate(id => window.uvFixture.selectManual(id), first.id);
  await page.waitForFunction(id => document.body.dataset.localRepaintGpuReadyTarget === id, first.id);
  rows = await state();
  assert.deepEqual(rows.find(row => row.id === first.id), second, 'reopening A lost pixels');
  assert.deepEqual(rows.find(row => row.id === idB), rowB);
  // Undo B even while A owns the active source; history must still address B.
  await page.evaluate(() => window.uvFixture.undo());
  await page.waitForFunction(async id => (await window.uvFixture.manualState()).find(row => row.id === id).green === 0, idB);
  assert.deepEqual((await state()).find(row => row.id === first.id), second);
  await page.evaluate(() => window.uvFixture.redo());
  await page.waitForFunction(async ({ id, hash }) => (await window.uvFixture.manualState()).find(row => row.id === id).hash === hash,
    { id: idB, hash: rowB.hash });
  // Begin a stroke on A, switch to B before pointer-up: the draft stays on A.
  await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(id => window.uvFixture.selectManual(id), idB);
  await page.mouse.up();
  await page.waitForFunction(id => document.body.dataset.localRepaintGpuReadyTarget === id, idB);
  assert.deepEqual((await state()).find(row => row.id === idB), rowB, 'midstroke switch leaked to B');
  await page.evaluate(id => window.uvFixture.removeManual(id), idB);
  await page.waitForFunction(async id => !(await window.uvFixture.manualState()).some(row => row.id === id), idB);
  await click(0);
  assert.equal((await state()).length, 1, 'deleted target was recreated');
  const beforeHide = await state();
  await page.evaluate(id => window.uvFixture.visibility(id, false), first.id);
  await click(0);
  assert.deepEqual(await state(), beforeHide, 'hidden target must not receive new pixels');
  await page.evaluate(async () => (await import('/scripts/uv-repaint-viewport-fixture.mjs')).setupLayerCreationCheck());
  const panel = page.locator('#layer-creation-check');
  await panel.getByText('此前手动创建', { exact: true }).waitFor();
  assert.equal(await panel.getByText('内部草稿', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '新建图层', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.createdLayerId));
  const createdId = await page.evaluate(() => window.createdLayerId);
  await panel.locator(`[data-layer-id="${createdId}"]`).waitFor();
  assert.equal(await panel.locator('[data-layer-id]').count(), 2);
  await page.evaluate(() => window.reloadCreatedLayers());
  await panel.locator(`[data-layer-id="${createdId}"]`).waitFor();
  assert.equal(await panel.locator('[data-layer-id]').count(), 2);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['nonblocking warning dismiss/reopen/create', 'created layer visible in production panel after save/reload', 'standalone old draft visible, internal draft hidden', 'same-layer multi-generation', 'exact pixel retention', 'visible GPU colors', 'PNG roundtrip', 'undo/redo', 'selected A/B', 'midstroke handoff', 'deleted/hidden target'], first, second, visible }));
} finally {
  await browser.close();
  await server.close();
}
