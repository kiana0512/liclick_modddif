/* global createImageBitmap, fetch, OffscreenCanvas */
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, configFile: false,
  optimizeDeps: { noDiscovery: true, entries: [], include: ['three', 'react', 'zustand'] },
  plugins: [{ name: 'normal-background-fixture', configureServer(server) {
    server.middlewares.use('/__fixture', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Normal background regression</title>');
    });
  } }],
  resolve: { alias: { '@': `${root}/src` } },
  server: { host: '127.0.0.1', port: 0, watch: { ignored: () => true } },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto(server.resolvedUrls.local[0] + '__fixture');
  const result = await page.evaluate(async () => {
    const THREE = await import('/scripts/normal-background-three-fixture.mjs');
    const { captureNormal } = await import('/src/engine/capture/captureNormal.ts');
    const gl = new THREE.WebGLRenderer({ alpha: true });
    gl.setSize(64, 64);
    const originalClear = new THREE.Color('#3a6722');
    gl.setClearColor(originalClear, 0.4);
    const scene = new THREE.Scene();
    const originalBackground = new THREE.Color('red');
    scene.background = originalBackground;
    const material = new THREE.MeshStandardMaterial({ color: 'green' });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.65, 32, 24), material);
    mesh.userData.liclickObjectId = 'normal-target';
    scene.add(mesh);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
    camera.position.z = 2.5;
    camera.updateMatrixWorld();
    async function pixels(url) {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      bitmap.close(); URL.revokeObjectURL(url);
      return data;
    }
    const results = [];
    for (const geometryGuide of [false, true]) for (const size of [128, 2048]) {
      const request = { gl, scene, camera, objectId: 'normal-target', width: size, height: size };
      const captures = [];
      for (const background of ['black', 'blue', 'black']) {
        captures.push(await pixels((await captureNormal(request, { geometryGuide, background })).url));
        if (scene.background !== originalBackground || mesh.material !== material ||
          !gl.getClearColor(new THREE.Color()).equals(originalClear) || gl.getClearAlpha() !== 0.4)
          throw new Error('Capture leaked renderer/scene state');
      }
      const [black, blue, again] = captures;
      const expectedBlue = [128, 128, 255, 255];
      if (black.slice(0, 4).join() !== '0,0,0,255' || blue.slice(0, 4).join() !== expectedBlue.join())
        throw new Error(`Wrong backdrop ${geometryGuide}: ${black.slice(0, 4)} / ${blue.slice(0, 4)}`);
      let corePixels = 0;
      // Compare an interior rectangle, well inside the silhouette at all sizes.
      for (let y = Math.ceil(size * 0.4); y < size * 0.6; y++)
        for (let x = Math.ceil(size * 0.4); x < size * 0.6; x++) {
          const offset = (y * size + x) * 4;
          for (let c = 0; c < 4; c++) if (black[offset + c] !== blue[offset + c])
            throw new Error(`Background changed a surface normal: guide=${geometryGuide} size=${size} at=${x},${y} ${black.slice(offset, offset + 4)} / ${blue.slice(offset, offset + 4)}`);
          corePixels++;
        }
      for (let i = 0; i < black.length; i++) if (black[i] !== again[i])
        throw new Error('Repeated toggle changed pixels');
      results.push({ geometryGuide, size, corePixels, surfaceDifference: 0, repeatDifference: 0 });
    }
    mesh.geometry.dispose(); material.dispose(); gl.dispose();
    return results;
  });
  assert.equal(result.length, 4);
  console.log(JSON.stringify(result));
} finally { await browser?.close(); await server.close(); }
