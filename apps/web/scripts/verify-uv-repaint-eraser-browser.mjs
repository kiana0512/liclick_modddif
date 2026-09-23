import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const serveOnly = process.argv.includes('--serve-only');
const chromium = serveOnly
  ? undefined
  : (
      await import(
        process.env.PLAYWRIGHT_MODULE
          ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
          : 'playwright'
      )
    ).chromium;
const root = fileURLToPath(new URL('..', import.meta.url))
  .replaceAll('\\', '/')
  .replace(/\/$/, '');
let fixture = await readFile(root + '/scripts/uv-repaint-viewport-fixture.mjs', 'utf8');
const resolution = process.env.LICLICK_UV_TEST_RESOLUTION ?? '1K';
assert(['1K', '2K', '4K'].includes(resolution));
fixture = fixture.replace("resolution: '1K'", `resolution: '${resolution}'`);
fixture = fixture
  .slice(0, fixture.indexOf("  const source = document.createElement('canvas');"))
  .replaceAll("'../src/", "'/src/");
fixture += String.raw`
  const size = Number(new URL(location.href).searchParams.get('size'));
  const source = document.createElement('canvas'); source.width = source.height = size;
  const ctx = source.getContext('2d'); ctx.fillStyle = '#e99a21'; ctx.fillRect(0,0,size,size);
  const top = { id: 'local-repaint-restored', objectId: object.id, name: '局部重绘',
    type: 'uv', role: 'local-repaint-overlay', imageUrl: source.toDataURL(),
    order: 0, visible: true, opacity: 1, blendMode: 'normal' };
  ctx.fillStyle = '#2459cb'; ctx.fillRect(0,0,size,size);
  useLayerStore.setState({ layers: [top, {...top, id:'base', role:undefined, order:1, imageUrl:source.toDataURL(), ...(new URL(location.href).searchParams.has('projected') ? {type:'projected',camera:serializeCamera(runtime.camera,1,new THREE.Vector3())} : {})}] });
  function pixel() {
    const previous = runtime.gl.getRenderTarget(), viewport = runtime.gl.getViewport(new THREE.Vector4());
    const target = new THREE.WebGLRenderTarget(64,64);
    runtime.gl.setRenderTarget(target); runtime.gl.render(runtime.scene,runtime.camera);
    const bytes = new Uint8Array(4); runtime.gl.readRenderTargetPixels(target,32,32,1,1,bytes);
    runtime.gl.setRenderTarget(previous); runtime.gl.setViewport(viewport); target.dispose(); return [...bytes];
  }
  await until(() => pixel()[0]>180 && pixel()[2]<100, 'initial UV');
  useLayerStore.setState({activeProjectedLayerId:top.id});
  useSceneStore.getState().setPaintTool('eraser');
  const {getLiveSurfacePaintPreview} = await import('/src/engine/paint/liveSurfacePaintPreviewRegistry.ts');
  await until(() => getLiveSurfacePaintPreview()?.target==='uv-image', 'UV preview prewarm');
  await tick(); await tick();
  const rect=runtime.gl.domElement.getBoundingClientRect();
  window.testFixture = {pixel, point:{x:rect.x+rect.width/2,y:rect.y+rect.height/2},
    undo:()=>paintHistoryBoundary.run(()=>useEditorHistoryStore.getState().undo()),
    redo:()=>paintHistoryBoundary.run(()=>useEditorHistoryStore.getState().redo()),
    tool:value=>useSceneStore.getState().setPaintTool(value),
    savedPixel:()=>getLiveProjectedCanvasState(useLayerStore.getState().layers[0].imageUrl)?.canvas.getContext('2d').getImageData(size/2,size/2,1,1).data[3]};
}
`;
const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  resolve: { alias: { '@': root + '/src' } },
  plugins: [
    {
      name: 'eraser-fixture',
      resolveId(id) {
        if (id === '/__eraser.mjs') return root + '/__eraser.mjs';
      },
      load(id) {
        if (id === root + '/__eraser.mjs') return fixture;
      },
      configureServer(s) {
        s.middlewares.use('/__fixture', (_, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><title>Eraser UV QA</title>');
        });
      },
    },
  ],
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/*'] } },
  cacheDir: 'node_modules/.vite-eraser-qa',
  optimizeDeps: { entries: ['scripts/uv-repaint-viewport-fixture.mjs'] },
});
server.middlewares.use('/__eraser.mjs', (_, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.end(fixture);
});
server.middlewares.use('/__fixture', (_, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Eraser UV QA</title>');
});
await server.listen();
if (serveOnly) {
  console.log(
    `ERASER_FIXTURE_URL=${server.resolvedUrls.local[0]}__fixture?size=${parseInt(resolution) * 1024}`,
  );
  const close = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  await new Promise(() => {});
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(
    server.resolvedUrls.local[0] +
      '__fixture?size=' +
      parseInt(resolution) * 1024 +
      (process.env.LICLICK_ERASER_PROJECTED_BASE === '1' ? '&projected=1' : ''),
  );
  await page.evaluate(async () => (await import('/__eraser.mjs')).setup());
  const before = await page.evaluate(() => globalThis.testFixture.pixel());
  const point = await page.evaluate(() => globalThis.testFixture.point);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.waitForFunction(
    () => globalThis.testFixture.pixel()[2] > 150 && globalThis.testFixture.pixel()[0] < 100,
    {},
    { timeout: 3000 },
  );
  const during = await page.evaluate(() => globalThis.testFixture.pixel());
  await page.mouse.move(point.x + 8, point.y, { steps: 5 });
  assert((await page.evaluate(() => globalThis.testFixture.pixel()))[2] > 150);
  await page.mouse.up();
  await page.waitForFunction(
    () => globalThis.testFixture.savedPixel() === 0,
    {},
    { timeout: 20000 },
  );
  await page.evaluate(() => globalThis.testFixture.undo());
  await page.waitForFunction(() => globalThis.testFixture.pixel()[0] > 180);
  await page.evaluate(() => globalThis.testFixture.redo());
  await page.waitForFunction(
    () => globalThis.testFixture.pixel()[2] > 150 && globalThis.testFixture.pixel()[0] < 100,
  );
  await page.evaluate(() => globalThis.testFixture.tool('none'));
  await page.waitForTimeout(500);
  assert((await page.evaluate(() => globalThis.testFixture.pixel()))[2] > 150);
  await page.evaluate(() => globalThis.testFixture.tool('eraser'));
  await page.waitForTimeout(300);
  await page.mouse.down();
  assert(
    (await page.evaluate(() => globalThis.testFixture.pixel()))[2] > 150,
    'previous erasure must survive next stroke',
  );
  await page.mouse.up();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      resolution,
      before,
      during,
      pointerDownRealtime: true,
      undoRedo: true,
      committed: true,
    }),
  );
} finally {
  await browser.close();
  await server.close();
}
