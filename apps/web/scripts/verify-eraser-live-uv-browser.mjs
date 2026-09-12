import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
let fixture = await readFile(root + '/scripts/uv-repaint-viewport-fixture.mjs', 'utf8');
const resolution = process.env.LICLICK_UV_TEST_RESOLUTION ?? '1K';
const layerCount = Number(process.env.LICLICK_ERASER_TEST_LAYERS ?? 2);
assert([2,10,14].includes(layerCount));
assert(['1K', '2K', '4K'].includes(resolution));
fixture = fixture.replace("resolution: '1K'", `resolution: '${resolution}'`);
fixture = fixture.slice(0, fixture.indexOf("  const source = document.createElement('canvas');"))
  .replaceAll("'../src/", "'/src/");
fixture += String.raw`
  const { getEraserUvDraft } = await import('/src/engine/paint/eraserUvDraft.ts');
  const { isResidentUvMaskPresented } = await import('/src/engine/projection/residentUvPresentation.ts');
  const layers = ['#2459cb', '#e99a21'].map((color, index) => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0,0,128,128);
    return { id: 'eraser-test-' + index, objectId: object.id, name: color, type: 'projected',
      imageUrl: c.toDataURL(), camera: serializeCamera(runtime.camera, 1, new THREE.Vector3()),
      order: index, visible: true, opacity: 1, strength: index ? 3 : .2, blendMode: 'normal' };
  });
  for (let index = 2; index < Number(new URL(location.href).searchParams.get('layers')); index++)
    layers.push({ ...layers[0], id: 'eraser-test-'+index, order: -index, opacity: .1 });
  useLayerStore.setState({ layers });
  const mesh = group.children[0];
  await until(() => mesh.material.userData.liclickResidentUvProjectionLayers?.length === layers.length, 'initial UV');
  function pixels(x = 32) {
    const previous = runtime.gl.getRenderTarget(), viewport = runtime.gl.getViewport(new THREE.Vector4());
    const target = new THREE.WebGLRenderTarget(64,64);
    runtime.gl.setRenderTarget(target);
    runtime.gl.render(runtime.scene, runtime.camera);
    const bytes = new Uint8Array(4);
    runtime.gl.readRenderTargetPixels(target,x,32,1,1,bytes);
    runtime.gl.setRenderTarget(previous); runtime.gl.setViewport(viewport); target.dispose(); return [...bytes];
  }
  await until(() => pixels()[0] > 80, 'initial rendered pixels');
  const before = pixels();
  useLayerStore.setState({ activeProjectedLayerId: layers[1].id });
  useSceneStore.getState().setPaintTool('eraser');
  await tick(); await tick(); await new Promise(r => setTimeout(r, 500));
  const rect = runtime.gl.domElement.getBoundingClientRect();
  window.eraserFixture = { before, pixels, point: { x: rect.x+rect.width/2, y:rect.y+rect.height/2 },
    async switchLayer() {
      useLayerStore.setState({ activeProjectedLayerId: layers[0].id });
      await tick(); await tick();
    },
    undo() { return paintHistoryBoundary.run(() => useEditorHistoryStore.getState().undo()); },
    redo() { return paintHistoryBoundary.run(() => useEditorHistoryStore.getState().redo()); },
    state: () => ({ pixel: pixels(), draft: getEraserUvDraft()?.revision,
      drawing: getEraserUvDraft()?.drawing, layers: useLayerStore.getState().layers.map(l => ({id:l.id, mask:l.maskUrl})),
      status: document.body.dataset.residentUvProjectionStatus,
      duration: document.body.dataset.residentUvProjectionDurationMs }),
    async settled() { await until(() => {
      const row = useLayerStore.getState().layers.find(l => l.id === layers[1].id);
      return !getEraserUvDraft() && row.maskUrl && isResidentUvMaskPresented(group, row.id, row.maskUrl);
    }, 'committed UV'); }
  };
}
`;
const server = await createServer({ root, configFile: false, logLevel: 'error',
  resolve: { alias: { '@': root + '/src' } },
  plugins: [{ name: 'eraser-fixture',
    resolveId(id) { if (id === '/__eraser.mjs') return root + '/__eraser.mjs'; },
    load(id) { if (id === root + '/__eraser.mjs') return fixture; },
    configureServer(s) { s.middlewares.use('/__fixture', (_, res) => {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Eraser UV QA</title>');
    }); },
  }],
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/*'] } },
  cacheDir: 'node_modules/.vite-eraser-qa',
  optimizeDeps: { entries: ['scripts/uv-repaint-viewport-fixture.mjs'] } });
server.middlewares.use('/__eraser.mjs', (_, res) => { res.setHeader('Content-Type', 'application/javascript'); res.end(fixture); });
server.middlewares.use('/__fixture', (_, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Eraser UV QA</title>'); });
await server.listen();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.route('**/api/**', route => route.fulfill({ json: {} }));
await page.route('**/__li3d_eraser_perf', route => route.fulfill({ json: {} }));
try {
  await page.goto(server.resolvedUrls.local[0] + '__fixture?layers='+layerCount);
  const draftChecks = await page.evaluate(async () => {
    const { EraserUvDraft } = await import('/src/engine/paint/eraserUvDraft.ts');
    const results = [];
    for (const size of [1024, 2048, 4096]) {
      const source = document.createElement('canvas'); source.width = source.height = size;
      source.getContext('2d').fillStyle = '#b0b0b0'; source.getContext('2d').fillRect(0,0,size,size);
      const owner = { objectId: 'unit', layerId: 'unit', target: 'projected-mask', paintCanvas: source, pendingPaintCommits: 0 };
      const draft = new EraserUvDraft(owner, source); draft.begin();
      const brush = document.createElement('canvas'); brush.width = brush.height = 512;
      const ctx = brush.getContext('2d'); ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.fillRect(200,200,7,9);
      const bounds = { x:198,y:198,width:12,height:14 };
      draft.update(brush,bounds); draft.flush();
      const first = draft.image.getContext('2d').getImageData(0,0,size,size).data;
      draft.update(brush,bounds); draft.flush();
      const second = draft.image.getContext('2d').getImageData(0,0,size,size).data;
      const patch = document.createElement('canvas'); patch.width=12;patch.height=14;
      patch.getContext('2d').drawImage(brush,198,198,12,14,0,0,12,14);
      const expected=source.getContext('2d'); const scale=size/512;
      expected.save();expected.globalCompositeOperation='destination-out';
      expected.drawImage(patch,0,0,12,14,198*scale,198*scale,12*scale,14*scale);expected.restore();
      expected.save();expected.globalCompositeOperation='destination-over';expected.fillStyle='#000';
      expected.fillRect(198*scale,198*scale,12*scale,14*scale);expected.restore();
      const reference=expected.getImageData(0,0,size,size).data;
      if (first.some((v,i)=>v!==reference[i]) || second.some((v,i)=>v!==reference[i]))
        throw Error('Draft/old commit mismatch or feather repeated: '+size);
      const frozen=draft.snapshot();draft.finishStroke();draft.begin();
      ctx.clearRect(0,0,512,512);ctx.fillRect(200,200,7,9);
      draft.update(brush,bounds);draft.finishStroke();
      if (frozen.getContext('2d').getImageData(0,0,size,size).data.some((v,i)=>v!==reference[i]))
        throw Error('An in-flight snapshot changed after later input');
      draft.dispose(); frozen.width=frozen.height=source.width=source.height=1;
      results.push(size);
    }
    return results;
  });
  await page.evaluate(async () => (await import('/__eraser.mjs')).setup());
  const { point, before } = await page.evaluate(() => window.eraserFixture);
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  const start = Date.now();
  await page.waitForFunction(before => {
    const state = window.eraserFixture.state();
    return state.drawing && state.pixel.some((v, i) => v !== before[i]);
  }, before, { timeout: 20000 });
  const live = await page.evaluate(() => window.eraserFixture.state());
  const latencyMs = Date.now() - start;
  assert(live.drawing, 'The visible pixel must change before pointer-up.');
  assert(live.pixel[2] > live.pixel[0], 'Erasing the orange layer must reveal the blue layer, not erase both.');
  assert(live.layers.every(layer => !layer.mask), 'Interactive draft must not publish authored layer masks.');
  await page.mouse.move(point.x + 70, point.y, { steps: 15 });
  await page.waitForFunction(() => {
    const f=window.eraserFixture, p=f.pixels(37);
    return f.state().drawing && f.state().draft > 1 && p[2] > p[0]*2;
  }, undefined, { timeout: 20000 });
  await page.mouse.up();
  await page.evaluate(() => window.eraserFixture.settled());
  const committed = await page.evaluate(() => window.eraserFixture.state());
  assert.deepEqual(committed.pixel, live.pixel, 'Live and committed pixels must agree.');
  await page.evaluate(() => window.eraserFixture.undo());
  await page.waitForFunction(before => window.eraserFixture.pixels().every((v,i)=>v===before[i]), before);
  await page.evaluate(() => window.eraserFixture.redo());
  await page.waitForFunction(pixel => window.eraserFixture.pixels().every((v,i)=>v===pixel[i]), committed.pixel);
  await page.evaluate(() => window.eraserFixture.switchLayer());
  await page.mouse.move(point.x - 60, point.y); await page.mouse.down();
  await page.waitForFunction(() => window.eraserFixture.state().drawing, undefined, { timeout: 10000 });
  await page.mouse.up();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ resolution, layerCount, draftChecks, before, live, committed, latencyMs, errors }));
} catch (error) {
  console.log(JSON.stringify({ errors, state: await page.evaluate(() => window.eraserFixture?.state()) }));
  throw error;
} finally { await browser.close(); await server.close(); }
