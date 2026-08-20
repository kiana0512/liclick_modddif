import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, logLevel: 'silent', server: { middlewareMode: true } });

try {
  const { harmonizeLocalRepaintPixels } = await server.ssrLoadModule(
    '/src/engine/localRepaint/seamHarmonizationCore.ts',
  );
  const { getLocalRepaintSeamMode } = await server.ssrLoadModule(
    '/src/engine/localRepaint/seamHarmonizationMode.ts',
  );
  const previousWindow = globalThis.window;
  globalThis.window = {
    location: { search: '?localRepaintSeamMode=legacy' },
    localStorage: { getItem: () => 'enhanced' },
  };
  assert.equal(getLocalRepaintSeamMode(), 'legacy', 'query switch must bypass enhancements');
  globalThis.window = {
    location: { search: '' },
    localStorage: { getItem: () => 'legacy' },
  };
  assert.equal(getLocalRepaintSeamMode(), 'legacy', 'stored switch must bypass enhancements');
  globalThis.window = {
    location: { search: '' },
    localStorage: { getItem: () => null },
  };
  assert.equal(getLocalRepaintSeamMode(), 'legacy', 'legacy mode must be the default');
  globalThis.window = previousWindow;
  const width = 64;
  const height = 64;
  const generated = new Uint8ClampedArray(width * height * 4);
  const reference = new Uint8ClampedArray(width * height * 4);
  const mask = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      generated.set([220, 80, 35, 173], offset);
      reference.set([35, 90, 210, 255], offset);
      const inside = x >= 12 && x < 52 && y >= 12 && y < 52;
      mask.set(inside ? [255, 255, 255, 255] : [0, 0, 0, 255], offset);
    }
  }

  const result = harmonizeLocalRepaintPixels({ generated, reference, mask, width, height });
  assert.equal(result.report.applied, true);
  assert.ok(result.report.blendWidth >= 2 && result.report.blendWidth < 8);
  const centerOffset = (32 * width + 32) * 4;
  assert.deepEqual(
    Array.from(result.pixels.slice(centerOffset, centerOffset + 4)),
    Array.from(generated.slice(centerOffset, centerOffset + 4)),
    'pixels outside the boundary band must remain byte-identical',
  );
  const boundaryOffset = (12 * width + 24) * 4;
  assert.notDeepEqual(
    Array.from(result.pixels.slice(boundaryOffset, boundaryOffset + 3)),
    Array.from(generated.slice(boundaryOffset, boundaryOffset + 3)),
    'the boundary band should receive multiscale blending',
  );
  assert.equal(
    result.pixels[boundaryOffset + 3],
    generated[boundaryOffset + 3],
    'seam blending must leave authored alpha untouched',
  );
  const outsideOffset = (4 * width + 4) * 4;
  assert.deepEqual(
    Array.from(result.pixels.slice(outsideOffset, outsideOffset + 4)),
    Array.from(generated.slice(outsideOffset, outsideOffset + 4)),
    'pixels outside the authored mask must remain byte-identical',
  );

  const thinMask = new Uint8ClampedArray(mask.length);
  for (let y = 20; y < 26; y += 1) {
    for (let x = 8; x < 56; x += 1) {
      thinMask.set([255, 255, 255, 255], (y * width + x) * 4);
    }
  }
  const thinResult = harmonizeLocalRepaintPixels({
    generated,
    reference,
    mask: thinMask,
    width,
    height,
  });
  assert.equal(thinResult.report.blendWidth, 2, 'thin masks should use a narrow edge ring');
  const thinCoreOffset = (22 * width + 24) * 4;
  assert.deepEqual(
    Array.from(thinResult.pixels.slice(thinCoreOffset, thinCoreOffset + 4)),
    Array.from(generated.slice(thinCoreOffset, thinCoreOffset + 4)),
    'the core of a thin mask must remain the exact generated result',
  );

  const fullMask = new Uint8ClampedArray(mask.length).fill(255);
  const fullFrameResult = harmonizeLocalRepaintPixels({
    generated,
    reference,
    mask: fullMask,
    width,
    height,
  });
  assert.equal(fullFrameResult.report.reason, 'full-frame-mask');
  assert.deepEqual(Array.from(fullFrameResult.pixels), Array.from(generated));
  console.log('Local repaint seam harmonization invariants passed.');
} finally {
  await server.close();
}
