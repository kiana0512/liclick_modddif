import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setImmediate } from 'node:timers';
import ts from 'typescript';
import * as oldCleanup from './fixtures/uv-cleanup-b3431cb.mjs';

const bake = fs.readFileSync(new URL('../src/engine/bake/bakeProjectedLayerToTexture.ts', import.meta.url), 'utf8');
const cleanup = bake.slice(bake.indexOf('async function fillTransparentTexelsForViewport'), bake.indexOf('function clampByte'));
let paints = 0;
const next = new Function('waitForBrowserPaint', `const UNPROJECTED_TEXTURE_FILL=[8,9,13], MIN_TRANSPARENT_OUTPUT_ALPHA=8, BAKE_PIXELS_PER_YIELD=32768;
${ts.transpileModule(cleanup, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}
return {fillTransparentTexelsForViewport, clearWeakTransparentTexels};`)(
  () => new Promise((resolve) => setImmediate(() => { paints++; resolve(); })),
);
let seed = 987;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
for (const width of [1, 17, 257, 2048]) {
  const data = Uint8ClampedArray.from({ length: width * width * 4 }, () => random() % 256);
  // Explicitly include every alpha threshold and all coverage tags.
  for (let i = 3; i < data.length; i += 4) data[i] = [0, 1, 7, 8, 9, 128, 255][(i >>> 2) % 7];
  for (const name of Object.keys(next)) for (const withCoverage of [false, true]) {
    const a = { width, height: width, data: data.slice() }, b = { ...a, data: data.slice() };
    const ac = withCoverage ? Uint8Array.from({ length: width * width }, () => random() % 3) : undefined;
    const bc = ac?.slice();
    await oldCleanup[name](a, ac);
    await next[name](b, bc);
    assert.deepEqual(b, a, `${name}: all RGBA at ${width}`);
    assert.deepEqual(bc, ac, `${name}: coverage at ${width}`);
  }
}
assert(paints > 0, 'large scans allow actual event-loop delivery');

const imageSource = fs.readFileSync(new URL('../src/engine/bake/imageSampler.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('imageSampler.ts', imageSource, ts.ScriptTarget.Latest, true);
const fn = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'loadImageData');
const js = ts.transpileModule(fn.getText(tree).replace('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
for (const mode of ['decode', 'reject', 'absent', 'load-error']) {
  const events = [], images = [];
  class Image {
    naturalWidth = 8; naturalHeight = 4;
    constructor() { images.push(this); if (mode === 'absent') this.decode = undefined; }
    set src(value) { this.url = value; }
    decode() { events.push('decode'); return new Promise((resolve, reject) => { this.finish = resolve; this.fail = reject; }); }
  }
  const env = {
    Image, getLiveProjectedTextureSourceState: () => undefined,
    resolveImageAssetUrl: x => x, getImageDataCacheKey: x => x,
    imageDataCache: new Map(), rememberImageData: () => events.push('cache'),
    waitForBrowserPaint: async () => events.push('paint'),
    describeUrlKind: () => 'fixture', isLiveProjectedCanvasUrl: () => false,
    document: { createElement: () => ({ getContext: () => ({
      drawImage: () => events.push('draw'), getImageData: () => ({ data: new Uint8ClampedArray(128) }),
    }) }) },
  };
  const load = new Function('env', `const {${Object.keys(env).join(',')}}=env; ${js}; return loadImageData;`)(env);
  const pending = load('blob:fixture');
  if (mode === 'load-error') {
    images[0].onerror();
    await assert.rejects(pending, /Could not load/);
    assert.equal(events.length, 0);
    continue;
  }
  images[0].onload();
  await Promise.resolve();
  if (mode !== 'absent') {
    assert.deepEqual(events, ['decode'], 'onload cannot publish or draw during decoding');
    if (mode === 'reject') images[0].fail(Error('optional decode rejected'));
    else images[0].finish();
  }
  await pending;
  assert.deepEqual(events.slice(-3), ['paint', 'draw', 'cache']);
}
console.log('UV source scheduling: frozen cleanup RGBA/coverage, event loop, decode barrier/fallback and load failure passed.');
