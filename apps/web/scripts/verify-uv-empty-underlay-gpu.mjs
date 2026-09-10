import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import legacyShader from './fixtures/uv-overlay-before-empty-fallback.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LICLICK_TEST_PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ root: path.resolve(import.meta.dirname, '..'), logLevel: 'error',
  appType: 'custom', server: { host: '127.0.0.1', port: 0, watch: { ignored: () => true } } });
server.middlewares.use('/__uv_empty', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<html><head><link rel="icon" href="data:,"></head><body></body></html>');
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__uv_empty`);
  const report = await page.evaluate(async legacyShader => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { createUvOverlayPreviewMaterial } = await import('/src/engine/projection/ProjectedLayerMaterial.ts');
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setSize(64, 64);
    const target = new THREE.WebGLRenderTarget(64, 64);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 1;
    const scene = new THREE.Scene();
    const geometry = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(geometry); scene.add(mesh);
    const read = material => {
      mesh.material = material; renderer.setRenderTarget(target); renderer.render(scene, camera);
      const bytes = new Uint8Array(64 * 64 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 64, 64, bytes); return bytes;
    };
    const rows = [];
    for (const baseAlpha of [0, 1, 127, 255]) for (const overlayAlpha of [0, 1, 127, 255]) {
      for (const hatch of [0, 1, 2]) for (const checker of [false, true]) {
        const base = new THREE.DataTexture(new Uint8Array([130, 60, 30, baseAlpha]), 1, 1);
        const overlay = new THREE.DataTexture(new Uint8Array([30, 130, 60, overlayAlpha]), 1, 1);
        base.needsUpdate = overlay.needsUpdate = true;
        const material = createUvOverlayPreviewMaterial({ displayMode: 'flat', selected: false,
          baseTexture: base, uvOverlayTexture: overlay, showEmptyUvChecker: checker });
        material.uniforms.showEmptyProjectionHatch.value = hatch;
        const legacy = material.clone(); legacy.fragmentShader = legacyShader;
        const before = read(legacy), after = read(material);
        let differences = 0, oldMax = 0, newMax = 0;
        for (let index = 0; index < before.length; index++) {
          if (before[index] !== after[index]) differences++;
          if (index % 4 !== 3) { oldMax = Math.max(oldMax, before[index]); newMax = Math.max(newMax, after[index]); }
        }
        rows.push({ baseAlpha, overlayAlpha, hatch, checker, differences, oldMax, newMax });
        legacy.dispose(); material.dispose(); base.dispose(); overlay.dispose();
      }
    }
    target.dispose(); geometry.dispose(); renderer.dispose();
    return rows;
  }, legacyShader);
  assert.deepEqual(errors, [], 'production shaders compile and run without errors');
  for (const row of report) {
    if (!row.checker && row.hatch === 1 && row.baseAlpha === 0 && row.overlayAlpha === 0) {
      // The render target stores linear bytes: lit clay is 150 here, while
      // the hatch peaks at 15. Compare the diagnostic contrast in that space.
      assert(row.oldMax > 100 && row.newMax < 32 && row.differences === 64 * 64 * 3,
        `reproduce white holes; restore dark diagnostic: ${JSON.stringify(row)}`);
    } else assert.equal(row.differences, 0, JSON.stringify(row));
  }
  console.log(`UV sparse-underlay WebGL: ${report.length} cases; empty display fixed, all covered pixels and capture modes byte-identical.`);
} finally { await browser?.close(); await server.close(); }
