import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LICLICK_TEST_PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ root: path.resolve(import.meta.dirname, '..'), server: { host: '127.0.0.1', port: 0, watch: null } });
server.middlewares.use('/__alpha_test', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><body>Repaint alpha regression</body></html>'); });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: process.env.LICLICK_TEST_BROWSER_CHANNEL || 'msedge' });
  const results = [];
  for (const useWorker of [true, false]) {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__alpha_test`);
    results.push(await page.evaluate(async (enabled) => {
      if (!enabled) window.Worker = undefined;
      const { clipRepaintToModelSilhouette } = await import('/src/engine/localRepaint/modelSilhouetteClip.ts');
      const { createProjectionMaskedImage, applyProjectedAlphaMask } = await import('/src/engine/projection/createMaskedProjectedImage.ts');
      const { compositeRgbaUnderInPlace } = await import('/src/engine/layers/mergeUvComposition.ts');
      const { loadImageData } = await import('/src/engine/bake/imageSampler.ts');
      const check = (value, message) => { if (!value) throw Error(message); };
      const size = 2048, source = new ImageData(size, size), depth = new ImageData(size, size), mask = new ImageData(size, size);
      depth.data.fill(255);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const p = (y * size + x) * 4;
        source.data.set([210, 125, 45, 255], p);
        mask.data.set([x < 1024 ? 255 : 128, x < 1024 ? 255 : 128, x < 1024 ? 255 : 128, 255], p);
        if (x > 127 && x < 1920 && y > 127 && y < 1920 && !(x >= 700 && x <= 800 && y >= 700 && y <= 800)) depth.data[p] = 100;
      }
      const clipped = clipRepaintToModelSilhouette(source, depth);
      const encode = (image) => { const c = document.createElement('canvas'); c.width = size; c.height = size; c.getContext('2d').putImageData(image, 0, 0); return c.toDataURL('image/png'); };
      const sourceUrl = encode(clipped), maskUrl = encode(mask);
      const decodedSource = await loadImageData(sourceUrl, 4096), decodedMask = await loadImageData(maskUrl, 4096);
      const hashes = [];
      for (const ignoreSourceAlpha of [false, true, undefined]) {
        const url = await createProjectionMaskedImage(sourceUrl, maskUrl, { ignoreSourceAlpha });
        const actual = await loadImageData(url, 4096);
        const rawExpected = applyProjectedAlphaMask(decodedSource, decodedMask, { ignoreSourceAlpha: ignoreSourceAlpha ?? true });
        // Match the production Canvas PNG roundtrip (premultiplication rounds
        // translucent RGB); coverage must remain exact before encoding too.
        const expected = await loadImageData(encode(rawExpected), 4096);
        for (let i=3;i<actual.data.length;i+=4) check(actual.data[i] === rawExpected.data[i], 'alpha survives PNG unchanged');
        let differences = 0;
        for (let i = 0; i < actual.data.length; i++) if (actual.data[i] !== expected.data[i]) differences++;
        check(differences === 0, `PNG parity: ${differences} different bytes`);
        const alpha = (x,y) => actual.data[(y*size+x)*4+3];
        if (ignoreSourceAlpha === false) {
          check(alpha(129,300) === 0 && alpha(130,300) === 255, 'outer 2px erosion retained');
          check(alpha(699,750) === 0 && alpha(697,750) === 255, 'hole expansion retained');
          check(alpha(1500,300) === 128, 'soft mask applied once');
          const underlay = new Uint8ClampedArray(actual.data.length);
          for (let p=0;p<underlay.length;p+=4) underlay.set([190,110,40,255],p);
          const merged = new Uint8ClampedArray(actual.data);
          compositeRgbaUnderInPlace(merged, underlay);
          check(merged[(300*size+129)*4] === 190, 'clipped edge shows original UV, not black');
        } else check(alpha(129,300) === 255, 'legacy full-frame compatibility retained');
        hashes.push([...new Uint8Array(await crypto.subtle.digest('SHA-256',actual.data))].map(v=>v.toString(16).padStart(2,'0')).join(''));
        URL.revokeObjectURL(url);
      }
      check(decodedSource.data.byteLength === size*size*4, 'shared source remains attached');
      return { useWorker: enabled, size, hashes, byteDifferences: 0 };
    }, useWorker));
    await page.close();
  }
  assert.deepEqual(results[0].hashes, results[1].hashes, 'real Worker and main output exactly match');
  console.log(JSON.stringify(results, null, 2));
} finally { await browser?.close(); await server.close(); }
