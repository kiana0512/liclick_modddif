import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  cacheDir: 'node_modules/.vite-uv-visibility-fixture',
  resolve: { alias: { '@': root + '/src' } },
  optimizeDeps: {
    noDiscovery: true,
    include: [
      'react/jsx-dev-runtime',
      'react',
      'react-dom/client',
      '@tanstack/react-query',
      'lucide-react',
      'zustand',
      'zustand/middleware',
      'zustand/react/shallow',
      'clsx',
      'tailwind-merge',
      'three',
      'uuid',
      'react-dom',
      '@react-three/fiber',
      '@react-three/drei',
      'fflate',
      'three/examples/jsm/postprocessing/OutputPass.js',
    ],
  },
  plugins: [
    {
      name: 'baseline-scene',
      enforce: 'pre',
      transform(_code, id) {
        if (process.env.UV_REPAINT_BASELINE && id.endsWith('/src/engine/viewport/SceneRoot.tsx'))
          return execFileSync(
            'git',
            [
              'show',
              `${process.env.UV_REPAINT_BASELINE}:apps/web/src/engine/viewport/SceneRoot.tsx`,
            ],
            { cwd: root, encoding: 'utf8' },
          );
      },
    },
  ],
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/__fixture', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>UV preview visibility regression</title>');
});
await server.listen();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  for (const path of ['**/api/local-settings', '**/api/identity/status', '**/__li3d_eraser_perf'])
    await page.route(path, (route) => route.fulfill({ json: {} }));
  await page.goto(server.resolvedUrls.local[0] + '__fixture');
  await page.evaluate(async () => {
    await (await import('/scripts/uv-repaint-viewport-fixture.mjs')).setup({ manual: true });
    const THREE = await import('/node_modules/.vite-uv-visibility-fixture/deps/three.js');
    const { useSceneStore } = await import('/src/stores/sceneStore.ts');
    const { useLayerStore } = await import('/src/stores/layerStore.ts');
    const registry = await import('/src/engine/projection/liveProjectedCanvasTextureRegistry.ts');
    const scene = useSceneStore.getState();
    scene.setPaintTool('none');
    scene.setLocalRepaintProjectionSource(undefined);
    for (let i = 0; i < 12; i++) await new Promise(window.requestAnimationFrame);
    const { camera, gl } = scene.viewport;
    const template = useLayerStore.getState().layers[0];
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const colors = ['#ee2211', '#11dd22', '#2233ee'];
    const offsets = [-100, 0, 100];
    const canvases = [];
    const rows = ids.map((id, order) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1024;
      const ray = new THREE.Raycaster();
      ray.setFromCamera(
        new THREE.Vector2((2 * offsets[order]) / gl.domElement.clientWidth, 0),
        camera,
      );
      const point = ray.ray.intersectPlane(
        new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
        new THREE.Vector3(),
      );
      const x = ((point.x + 1) / 2) * 1024;
      canvas.getContext('2d').fillStyle = colors[order];
      canvas.getContext('2d').fillRect(x - 24, 488, 48, 48);
      canvases.push(canvas);
      return {
        ...template,
        id,
        role: undefined,
        generationId: undefined,
        visible: true,
        opacity: 1,
        order,
        imageUrl: registry.registerLiveProjectedCanvasTexture(id, canvas, THREE.SRGBColorSpace, {
          flipY: true,
        }),
      };
    });
    const base = document.createElement('canvas');
    base.width = base.height = 1024;
    base.getContext('2d').fillStyle = '#887744';
    base.getContext('2d').fillRect(0, 0, 1024, 1024);
    window.setPreviewRows = (count, png = false) => {
      useLayerStore
        .getState()
        .setLayers([
          ...rows
            .slice(0, count)
            .map((row) => ({
              ...row,
              imageUrl: png ? canvases[row.order].toDataURL() : row.imageUrl,
            })),
          {
            ...template,
            id: 'fixture-base',
            name: 'base',
            visible: true,
            opacity: 1,
            order: 4,
            type: 'uv',
            role: 'merged-uv',
            imageUrl: base.toDataURL(),
          },
        ]);
    };
    window.visibilityIds = ids;
    window.setPreviewRows(2);
  });
  const isColor = (pixel, i) =>
    pixel[i] > 140 && pixel[i] > pixel[(i + 1) % 3] * 1.5 && pixel[i] > pixel[(i + 2) % 3] * 1.5;
  const checks = [];
  for (const png of [false, true])
    for (const count of [2, 3]) {
      await page.evaluate(({ count, png }) => window.setPreviewRows(count, png), { count, png });
      for (let cycle = 0; cycle < 2; cycle++)
        for (const mask of [0, 1, 2, (1 << count) - 1, 0, (1 << count) - 1]) {
          await page.evaluate(
            async ({ count, mask }) => {
              const { useLayerStore } = await import('/src/stores/layerStore.ts');
              for (let i = 0; i < count; i++)
                useLayerStore
                  .getState()
                  .setLayerVisibility([window.visibilityIds[i]], Boolean(mask & (1 << i)));
            },
            { count, mask },
          );
          let pixels;
          const deadline = Date.now() + 10000;
          do {
            pixels = await page.evaluate(() => window.uvFixture.pixels([-100, 0, 100]));
            if (
              Array.from(
                { length: count },
                (_, i) => isColor(pixels[i], i) === Boolean(mask & (1 << i)),
              ).every(Boolean)
            )
              break;
          } while (Date.now() < deadline);
          for (let i = 0; i < count; i++)
            assert.equal(
              isColor(pixels[i], i),
              Boolean(mask & (1 << i)),
              `count=${count} png=${png} mask=${mask} row=${i}: ${JSON.stringify(pixels)}`,
            );
        }
      checks.push({ count, png, transitions: 12 });
    }
  assert.deepEqual(
    errors,
    [],
    'No runtime errors, shader errors or invalid live URL image decodes',
  );
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser.close();
  await server.close();
}
