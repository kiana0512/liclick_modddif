import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
const { AbortController, queueMicrotask } = globalThis;

const path = 'apps/web/src/engine/localRepaint/imageUtils.ts';
const root = new URL('../../../', import.meta.url);
const source = process.argv.includes('--baseline')
  ? execFileSync('git', ['show', `HEAD:${path}`], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(new URL(path, root), 'utf8');
const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const fn = tree.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'urlToImageData');
assert(fn);
const js = ts.transpileModule(fn.getText(tree), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
class Pixels {
  constructor(width, height) {
    Object.assign(this, { width, height, data: new Uint8ClampedArray(width * height * 4) });
  }
}
function harness(settings = {}) {
  const events = [], images = [];
  let yields = 0, draws = 0;
  class MockImage {
    naturalWidth = settings.width ?? 513;
    naturalHeight = settings.height ?? 1027;
    width = 7;
    height = 3;
    constructor() {
      images.push(this);
      if (settings.noDecode) this.decode = undefined;
    }
    async decode() {
      events.push('decode');
      if (settings.decodeError) throw new Error('optional decoder rejected');
    }
    set src(value) {
      this.url = value;
      if (value && !settings.pendingLoad) queueMicrotask(() => settings.loadError ? this.onerror?.() : this.onload?.());
    }
  }
  const reads = [];
  const document = { createElement(tag) {
    assert.equal(tag, 'canvas');
    const canvas = { width: 0, height: 0, getContext(kind, options) {
      assert.equal(kind, '2d'); assert.deepEqual(options, { willReadFrequently: true });
      if (settings.noContext) return null;
      return {
        drawImage(image, x, y, width, height) {
          assert.equal(image, images[0]);
          assert.equal(image.crossOrigin, 'anonymous');
          assert.deepEqual([x, y, width, height], [0, 0, canvas.width, canvas.height]);
          draws++; events.push('draw');
        },
        getImageData(x, y, width, height) {
          assert.equal(x, 0); assert.equal(width, canvas.width);
          if (settings.readError) throw new Error('readback failed');
          reads.push({ y, width, height, yield: yields });
          const output = new Pixels(width, height);
          // The virtual canvas includes coloured RGB under every alpha value.
          for (let i = 0; i < output.data.length; i++) output.data[i] = ((y * width * 4 + i) * 37) % 256;
          return output;
        },
      };
    } };
    return canvas;
  } };
  const exports = {};
  new Function('exports', 'Image', 'ImageData', 'document', 'yieldToBrowserTask', 'waitForViewportInteractionIdle', js)(
    exports, MockImage, Pixels, document,
    async () => { yields++; events.push('yield'); settings.onYield?.(yields); },
    async () => { events.push('idle'); settings.onIdle?.(); },
  );
  return { run: exports.urlToImageData, events, images, reads, draws: () => draws };
}
for (const size of [[1, 1], [1, 600], [513, 1027], [2048, 513]]) {
  const original = harness(), staged = harness();
  const expected = await original.run('source', ...size);
  const actual = await staged.run('source', ...size, { cooperative: true });
  assert.deepEqual(actual, expected, `all RGBA bytes at ${size}`);
  assert.equal(staged.draws(), 1, 'one full-size draw preserves scaling and boundary pixels');
  assert.equal(original.reads.length, 1, 'default consumers keep their existing path');
  assert.equal(original.events.includes('yield'), false);
  assert(staged.events.indexOf('decode') < staged.events.indexOf('draw'));
  let nextRow = 0, previousYield = 1;
  for (const read of staged.reads) {
    assert.equal(read.y, nextRow); nextRow += read.height;
    assert(read.width * read.height <= 262144, 'readback bounded to 1 MiB');
    assert(read.yield > previousYield, 'yield and idle gate before every stripe');
    previousYield = read.yield;
  }
  assert.equal(nextRow, size[1]);
}
for (const settings of [{}, { width: 0, height: 0 }, { noDecode: true }, { decodeError: true }]) {
  const original = harness(settings), staged = harness(settings);
  assert.deepEqual(await staged.run('source', undefined, undefined, { cooperative: true }), await original.run('source'));
}
for (const phase of ['initial', 'load', 'before-draw', 'after-draw', 'next-stripe', 'idle']) {
  const controller = new AbortController();
  const subject = harness({ pendingLoad: phase === 'load',
    onYield(n) {
      if ((phase === 'before-draw' && n === 1) || (phase === 'after-draw' && n === 2) || (phase === 'next-stripe' && n === 3)) controller.abort();
    },
    onIdle() { if (phase === 'idle') controller.abort(); },
  });
  if (phase === 'initial') controller.abort();
  const result = subject.run('source', undefined, undefined, { cooperative: true, signal: controller.signal });
  if (phase === 'load') controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(subject.reads.length, phase === 'next-stripe' ? 1 : 0);
  if (phase === 'load') {
    assert.equal(subject.images[0].url, '');
    assert.equal(subject.images[0].onload, null);
  }
}
for (const [settings, message] of [[{ loadError: true }, /load image/], [{ noContext: true }, /image canvas/], [{ readError: true }, /readback failed/]]) {
  await assert.rejects(harness(settings).run('source', undefined, undefined, { cooperative: true }), message);
}
const preview = fs.readFileSync(new URL('apps/web/src/engine/localRepaint/resultPreviewUtils.ts', root), 'utf8');
const previewTree = ts.createSourceFile('preview.ts', preview, ts.ScriptTarget.Latest, true);
const previewFunction = (name) => previewTree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(previewTree);
const bind = (code, name, scope = {}) => new Function(...Object.keys(scope), `${ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}\nreturn ${name};`)(...Object.values(scope));
const bounds = bind(previewFunction('getExactAlphaContentBounds'), 'getExactAlphaContentBounds');
const referenceBounds = (image) => {
  let left = image.width, top = image.height, right = -1, bottom = -1;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (image.data[(y * image.width + x) * 4 + 3] === 0) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return right < left ? undefined : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
};
let seed = 12345;
for (let fixture = 0; fixture < 400; fixture++) {
  const image = new Pixels(1 + fixture % 71, 1 + fixture % 43);
  for (let i = 3; i < image.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    image.data[i] = fixture % 4 === 0 ? 0 : fixture % 4 === 1 ? 255 : seed % 7 === 0 ? 1 : 0;
  }
  assert.deepEqual(bounds(image), referenceBounds(image), 'Exact alpha bounds preserve transparency, gaps, edges and alpha=1');
}
const opaque = new Pixels(1024, 1024); opaque.data.fill(255);
const measure = (fn) => { const start = performance.now(); for (let i = 0; i < 20; i++) fn(opaque); return (performance.now() - start) / 20; };
const oldBoundsMs = measure(referenceBounds), newBoundsMs = measure(bounds);
for (const withDepth of [false, true]) for (let cancelAt = 0; cancelAt <= (withDepth ? 5 : 4); cancelAt++) {
  const controller = new AbortController(), events = [];
  let frames = 0;
  const run = bind(previewFunction('createGeneratedDisplayPreviewUncached'), 'createGeneratedDisplayPreviewUncached', {
    GENERATED_DISPLAY_MAX_DIMENSION: 1024, GENERATED_DISPLAY_PADDING_RATIO: 0.06,
    urlToImageData: async (url, _w, _h, options) => { options.signal.throwIfAborted(); events.push(url); return new Pixels(2048, 2048); },
    waitForBrowserPaint: async () => { events.push('frame'); if (++frames === cancelAt) controller.abort(); },
    waitForViewportInteractionIdle: async () => {},
    resizeImageData: () => { events.push('resize'); return opaque; },
    applyPackedDepthDisplayMask: (imageData) => { events.push('mask'); return { imageData, changedPixels: 1 }; },
    removeStrictOuterDarkDisplayBackground: (imageData) => { events.push('mask'); return { imageData, changedPixels: 1 }; },
    getExactAlphaContentBounds: (image) => { events.push('bounds'); return bounds(image); },
    encodeDisplayImage: async () => { events.push('encode'); return 'encoded-exact-image'; },
  });
  const result = run('source', withDepth ? 'depth' : undefined, controller.signal);
  if (cancelAt) {
    await assert.rejects(result, { name: 'AbortError' });
    assert.equal(frames, cancelAt, 'Cancellation stops before the next processing stage');
    assert.equal(events.at(-1), 'frame', 'No pixel work after cancellation at a frame boundary');
  } else {
    assert.deepEqual(await result, { alignedUrl: 'encoded-exact-image', fittedUrl: 'encoded-exact-image' });
    assert.deepEqual(events, withDepth
      ? ['source', 'frame', 'resize', 'frame', 'depth', 'frame', 'mask', 'frame', 'bounds', 'encode', 'frame']
      : ['source', 'frame', 'resize', 'frame', 'mask', 'frame', 'bounds', 'encode', 'frame']);
  }
}
console.log(`Display stages passed: all cancellation boundaries; 400 exact-bound fixtures. Opaque 1024 bounds: ${oldBoundsMs.toFixed(3)} -> ${newBoundsMs.toFixed(3)} ms.`);
assert.match(preview, /const readOptions = \{ cooperative: true, signal \};/);
assert.match(preview, /urlToImageData\(sourceUrl, undefined, undefined, readOptions\)/);
assert.match(preview, /urlToImageData\(depthUrl, source.width, source.height, readOptions\)/);
console.log('Display image readback passed: decode before draw, exact RGBA stripe assembly, unchanged default path, cancellation and failures.');
