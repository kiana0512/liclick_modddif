/* global queueMicrotask, AbortController */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as contracts from '../../../packages/contracts/dist/index.js';

const source = readFileSync(new URL('../src/engine/generation/contentFraming.ts', import.meta.url), 'utf8');
const silhouetteSource = readFileSync(new URL('../src/engine/generation/contentFramingSilhouette.ts', import.meta.url), 'utf8');
function load(clock = performance) {
  const module = { exports: {} };
  new Function('module', 'exports', 'require', 'performance', ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(module, module.exports, name => {
    assert.equal(name, '@liclick/contracts'); return contracts;
  }, clock);
  return module.exports;
}
const current = load();
const silhouetteModule = { exports: {} };
new Function('module', 'exports', 'require', ts.transpileModule(silhouetteSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(silhouetteModule, silhouetteModule.exports, name => {
  assert.equal(name, './contentFraming'); return current;
});
const { validateFramedSilhouette } = silhouetteModule.exports;
let seed = 17;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
for (let fixture = 0; fixture < 120; fixture++) {
  const width = 1 + random() % 129, height = 1 + random() % 97;
  const image = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = random() % 3 ? 255 : 0;
    image.data[i + 3] = [0, 1, 127, 128, 255][random() % 5];
  }
  if (fixture % 10 === 0) image.data.fill(0);
  if (fixture % 10 === 1) {
    image.data.fill(0); image.data.set([0, 0, 255, 1], (random() % (width * height)) * 4);
  }
  for (const normal of [false, true]) {
    // Frozen exhaustive predicate reference; the optimized scan skips interiors.
    let left = width, top = height, right = -1, bottom = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (image.data[i + 3] > 0 && (normal || image.data[i] > 0)) {
        left = Math.min(left, x); top = Math.min(top, y);
        right = Math.max(right, x); bottom = Math.max(bottom, y);
      }
    }
    if (right < left) {
      assert.throws(() => current.findContentFraming(image, normal), /未找到模型轮廓/);
      await assert.rejects(() => current.findContentFramingCooperatively(image, normal, '2K', async () => {}), /未找到模型轮廓/);
    } else {
      const frame = current.findContentFraming(image, normal);
      assert.deepEqual(frame.subject, { left, top, width: right - left + 1, height: bottom - top + 1 });
      assert.deepEqual(await current.findContentFramingCooperatively(image, normal, '2K', async () => {}), frame);
    }
  }
}
// Checkpoints include empty rows, abort before publishing a crop, and preserve
// genuine provider size/transparent-silhouette errors instead of loosening QA.
let time = 0, checkpoints = 0;
const timed = load({ now: () => time += 3 });
const empty = { width: 1024, height: 1024, data: new Uint8ClampedArray(1024 * 1024 * 4) };
const cancelled = new Error('author-cancel');
await assert.rejects(() => timed.findContentFramingCooperatively(empty, false, '1K', async () => {
  if (++checkpoints === 2) throw cancelled;
}), error => error === cancelled);
assert.equal(checkpoints, 2);
const frame = current.findContentFraming({ width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) });
assert.throws(() => current.restoredFrameLayout(frame, frame.outputWidth - 1, frame.outputHeight), /远端回图比例异常/);
await assert.rejects(() => validateFramedSilhouette(frame, { width: frame.outputWidth, height: frame.outputHeight,
  data: new Uint8ClampedArray(frame.outputWidth * frame.outputHeight * 4) }), /透明轮廓不对齐/);
await assert.rejects(() => validateFramedSilhouette(frame, { width: frame.outputWidth, height: frame.outputHeight,
  data: new Uint8ClampedArray(frame.outputWidth * frame.outputHeight * 4) }, undefined, 'capture-mask'), /透明轮廓不对齐/);

// Execute the real image-loader function to check async decode, compatibility
// when decode rejects, and cancellation while an otherwise loaded image decodes.
const adapterSource = readFileSync(new URL('../src/engine/generation/contentFramingImages.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('adapter.ts', adapterSource, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'load');
let releaseDecode, decodeCalls = 0, yields = 0, failDecode = false;
class Image {
  set src(value) { if (value) queueMicrotask(() => this.onload?.()); }
  decode() { decodeCalls++; return failDecode ? Promise.reject(new Error('drawable compatibility')) : new Promise(resolve => { releaseDecode = resolve; }); }
}
const exports = {};
new Function('exports', 'Image', 'urlToDataUrl', 'yieldToBrowserTask', ts.transpileModule(
  declaration.getText(ast) + '\nexports.load = load;',
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText)(exports, Image, async url => url, async () => { yields++; });
let resolved = false;
const pending = exports.load('colour').then(image => { resolved = true; return image; });
while (!releaseDecode) await Promise.resolve();
assert.equal(resolved, false); releaseDecode();
assert.equal((await pending).decoding, 'async'); assert.equal(yields, 1);
releaseDecode = undefined;
const abort = new AbortController(), aborted = exports.load('normal', abort.signal);
while (!releaseDecode) await Promise.resolve();
abort.abort(cancelled); releaseDecode();
await assert.rejects(() => aborted, error => error === cancelled);
assert.equal(yields, 1);
failDecode = true;
assert.ok(await exports.load('drawable-image'));
assert.equal(decodeCalls, 3); assert.equal(yields, 2);
console.log('Content bounds passed: 240 exhaustive mask/normal references, identical cooperative framing, empty-row cancellation, strict size/silhouette errors and async decode cancellation/compatibility.');
