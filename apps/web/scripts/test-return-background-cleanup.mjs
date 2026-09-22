import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as contracts from '../../../packages/contracts/dist/index.js';
function load(name, deps) {
  const module = { exports: {} };
  new Function('module', 'exports', 'require', ts.transpileModule(readFileSync(new URL(`../src/engine/generation/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(module, module.exports, key => { assert.ok(key in deps, key); return deps[key]; });
  return module.exports;
}
const framing = load('contentFraming', { '@liclick/contracts': contracts });
const { cleanReturnBackground } = load('returnBackgroundCleanup', { './contentFraming': framing });
const { validateFramedSilhouette } = load('contentFramingSilhouette', { './contentFraming': framing });
function rect(image, x, y, w, h, alpha = 255) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) image.data.set([0, 0, 0, alpha], (j * image.width + i) * 4);
}
const source = { width: 256, height: 256, data: new Uint8ClampedArray(256 * 256 * 4) };
rect(source, 88, 28, 80, 200);
const frame = framing.findContentFraming(source, true, '1K');
const size = frame.width;
function fixture() {
  const image = { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) };
  rect(image, 88 - frame.left, 28 - frame.top, 80, 200);
  return image;
}
const checkpoint = async () => {};
const clean = fixture(), dirty = fixture();
rect(dirty, 0, 0, 8, 30);
rect(dirty, size - 8, size - 20, 8, 20, 180);
await assert.rejects(() => validateFramedSilhouette(frame, dirty));
assert.equal(await cleanReturnBackground(frame, dirty, checkpoint), true);
await validateFramedSilhouette(frame, dirty);
assert.deepEqual(dirty.data, clean.data, 'Only border alpha changes; black subject survives exactly');
assert.equal(await cleanReturnBackground(frame, clean, checkpoint), false);
// Nearby disconnected detail remains, including its faint-alpha antialiasing.
const detail = fixture(); rect(detail, 40, 70, 3, 3, 100);
const detailBefore = detail.data.slice();
assert.equal(await cleanReturnBackground(frame, detail, checkpoint), false);
assert.deepEqual(detail.data, detailBefore);
// Attached/faint bridges, opaque backgrounds, shifted/empty/half subjects cannot be rescued.
for (const kind of ['bridge', 'opaque', 'shift', 'empty', 'half']) {
  const image = fixture();
  if (kind === 'bridge') { rect(image, 0, 0, 8, 30); rect(image, 7, 15, 88 - frame.left - 6, 1, 1); }
  if (kind === 'opaque') rect(image, 0, 0, size, size);
  if (kind === 'shift' || kind === 'empty' || kind === 'half') {
    image.data.fill(0);
    if (kind !== 'empty') rect(image, kind === 'shift' ? 10 : 88 - frame.left, 28 - frame.top, 80, kind === 'half' ? 90 : 200);
    rect(image, size - 5, 0, 5, 10);
  }
  const before = image.data.slice();
  assert.equal(await cleanReturnBackground(frame, image, checkpoint), false, kind);
  assert.deepEqual(image.data, before, kind);
  await assert.rejects(() => validateFramedSilhouette(frame, image));
}
const cancelled = fixture(); rect(cancelled, 0, 0, 8, 30);
const before = cancelled.data.slice(); let checkpoints = 0;
await assert.rejects(() => cleanReturnBackground(frame, cancelled, async () => { if (++checkpoints === 3) throw new Error('cancel'); }), /cancel/);
assert.deepEqual(cancelled.data, before);
const restoreSource = readFileSync(new URL('../src/engine/generation/contentFramingRestore.ts', import.meta.url), 'utf8');
assert.match(restoreSource, /GPT_RETURN_SILHOUETTE_MISMATCH/);
assert.match(restoreSource, /await cleanReturnBackground[\s\S]*?await validateFramedSilhouette/);
assert.match(restoreSource, /ctx\.putImageData\(cleanedPixels, layout.left, layout.top\)/);
console.log('Conservative return background cleanup: alpha, retained details, mismatch, cancellation and output wiring passed.');
