import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { applyPackedDepthDisplayMask as referenceDepth, removeStrictOuterDarkDisplayBackground as referenceDark } from './fixtures/display-mask-reference.mjs';
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
  const events = [], images = [], canvases = [];
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
    canvases.push(canvas);
    return canvas;
  } };
  const exports = {};
  new Function('exports', 'Image', 'ImageData', 'document', 'yieldToBrowserTask', 'waitForViewportInteractionIdle', js)(
    exports, MockImage, Pixels, document,
    async () => { yields++; events.push('yield'); settings.onYield?.(yields); },
    async () => { events.push('idle'); settings.onIdle?.(); },
  );
  return { run: exports.urlToImageData, events, images, canvases, reads, draws: () => draws };
}
const released = (subject) => assert(subject.canvases.every(c => c.width * c.height === 0),
  'Scratch canvas backing stores must be released without waiting for garbage collection');
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
  released(original); released(staged);
}
for (const settings of [{}, { width: 0, height: 0 }, { noDecode: true }, { decodeError: true }]) {
  const original = harness(settings), staged = harness(settings);
  assert.deepEqual(await staged.run('source', undefined, undefined, { cooperative: true }), await original.run('source'));
}
for (const [width, height, expectedWidth, expectedHeight] of [[4096,2048,128,64], [300,1200,32,128], [31,17,31,17], [1,4096,1,128]]) {
  const thumbnail = harness({width,height});
  const result = await thumbnail.run('source', undefined, undefined, {cooperative:true, maxSize:128});
  assert.deepEqual([result.width,result.height], [expectedWidth,expectedHeight]);
  assert.equal(thumbnail.draws(), 1);
  assert(thumbnail.reads.every((read) => read.width * read.height <= 128 * 128), 'Thumbnail path never reads back the full 4K image');
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
  released(subject);
  assert.equal(subject.reads.length, phase === 'next-stripe' ? 1 : 0);
  if (phase === 'load') {
    assert.equal(subject.images[0].url, '');
    assert.equal(subject.images[0].onload, null);
  }
}
for (const [settings, message] of [[{ loadError: true }, /load image/], [{ noContext: true }, /image canvas/], [{ readError: true }, /readback failed/]]) {
  const subject = harness(settings);
  await assert.rejects(subject.run('source', undefined, undefined, { cooperative: true }), message);
  released(subject);
}
// Execute the real resize helper, including failure at every canvas boundary.
// Returned ImageData must survive releasing both native scratch bitmaps.
const resizeNode = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'resizeImageData');
for (const failure of [undefined, 'source-context', 'put', 'output-context', 'draw', 'read']) {
  const canvases = [], events = [];
  const expected = new Pixels(3, 5); expected.data.fill(73);
  const resizeExports = {};
  const document = {createElement() {
    const index = canvases.length;
    const canvas = {width:0,height:0,getContext(kind, options) {
      assert.equal(kind,'2d');
      assert.deepEqual(options, index ? {willReadFrequently:true} : undefined);
      if (failure === (index ? 'output-context' : 'source-context')) return null;
      return {
        putImageData(input, x, y) {assert.deepEqual([input.width,input.height,x,y],[4096,4096,0,0]); if(failure==='put')throw Error('put'); events.push('put');},
        drawImage(input, ...args) {assert.deepEqual([input.width,input.height,...args],[4096,4096,0,0,3,5]); if(failure==='draw')throw Error('draw'); events.push('draw');},
        getImageData(...args) {assert.deepEqual(args,[0,0,3,5]); if(failure==='read')throw Error('read'); events.push('read'); return expected;},
      };
    }};
    canvases.push(canvas); return canvas;
  }};
  new Function('exports','document',ts.transpileModule(resizeNode.getText(tree),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText)(resizeExports,document);
  const input = {width:4096,height:4096};
  assert.equal(resizeExports.resizeImageData(input,4096,4096), input, 'No-op resize keeps identity and allocates no canvas');
  assert.equal(canvases.length,0);
  if(failure) assert.throws(()=>resizeExports.resizeImageData(input,3,5));
  else {
    assert.equal(resizeExports.resizeImageData(input,3,5),expected);
    assert.deepEqual(events,['put','draw','read']);
    assert(expected.data.every(byte=>byte===73),'Canvas cleanup must not alter returned RGBA');
  }
  released({canvases});
}
console.log('Scratch canvas release passed: complete, cancelled, failed readback, unchanged resize operations and independent output.');
const preview = fs.readFileSync(new URL('apps/web/src/engine/localRepaint/resultPreviewUtils.ts', root), 'utf8');
const previewTree = ts.createSourceFile('preview.ts', preview, ts.ScriptTarget.Latest, true);
const previewFunction = (name) => previewTree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(previewTree);
const bind = (code, name, scope = {}) => new Function(...Object.keys(scope), `${ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}\nreturn ${name};`)(...Object.values(scope));
const paddedDisplayBounds = bind(previewFunction('paddedDisplayBounds'),'paddedDisplayBounds');
for(let i=0;i<400;i++) {
  const source={width:1+i%67,height:1+i%43}, bounds={x:i%source.width,y:i%source.height,width:1+i%13,height:1+i%17}, padding=i%9;
  const x=Math.max(0,bounds.x-padding), y=Math.max(0,bounds.y-padding);
  assert.deepEqual(paddedDisplayBounds(source,bounds,padding),[x,y,Math.max(1,Math.min(source.width,bounds.x+bounds.width+padding)-x),Math.max(1,Math.min(source.height,bounds.y+bounds.height+padding)-y)]);
}
// Cropping stays a single unscaled canvas draw. Verify both context failures,
// transparent RGBA ownership and cleanup without depending on GC.
for (const failure of [undefined, 'source-context', 'output-context', 'draw', 'read']) {
  const canvases = [], events = [], input = new Pixels(31, 23), output = new Pixels(7, 9);
  for (let i=0;i<output.data.length;i++) output.data[i]=(i*37)%256;
  const expected=output.data.slice();
  const crop=bind(previewFunction('cropDisplayImage'),'cropDisplayImage',{document:{createElement() {
    const index=canvases.length;
    const canvas={width:0,height:0,getContext(kind,options) {
      assert.equal(kind,'2d'); assert.deepEqual(options,index?{willReadFrequently:true}:undefined);
      if(failure===(index?'output-context':'source-context'))return null;
      return {
        putImageData(image,x,y) {assert.equal(image,input); assert.deepEqual([x,y],[0,0]); events.push('put');},
        drawImage(source,...args) {assert.equal(source,canvases[0]); assert.deepEqual([source.width,source.height,...args],[31,23,3,5,7,9,0,0,7,9]); if(failure==='draw')throw Error('draw'); events.push('draw');},
        getImageData(...args) {assert.deepEqual(args,[0,0,7,9]); if(failure==='read')throw Error('read'); events.push('read'); return output;},
      };
    }};
    canvases.push(canvas); return canvas;
  }}});
  if(failure==='draw'||failure==='read')assert.throws(()=>crop(input,3,5,7,9),new RegExp(failure));
  else if(failure)assert.equal(crop(input,3,5,7,9),undefined);
  else {assert.equal(crop(input,3,5,7,9),output); assert.deepEqual(events,['put','draw','read']);}
  released({canvases}); assert.deepEqual(output.data,expected);
}
for(const kind of ['generated','capture'])for(const missingContext of [false,true]) {
  const source=new Pixels(31,23), calls=[];
  const scope={paddedDisplayBounds,GENERATED_DISPLAY_MAX_DIMENSION:1024,GENERATED_DISPLAY_PADDING_RATIO:0.06,SUBJECT_PADDING_RATIO:0.06,
    urlToImageData:async()=>source,waitForBrowserPaint:async()=>{},waitForViewportInteractionIdle:async()=>{},
    removeStrictOuterDarkDisplayBackground:()=>({imageData:source,changedPixels:0}),applyCapturePreviewMask:()=>source,
    getExactAlphaContentBounds:()=>({x:8,y:7,width:7,height:9}),getAlphaContentBounds:()=>({x:8,y:7,width:7,height:9}),
    cropDisplayImage:(image,...rect)=>{assert.equal(image,source);calls.push(rect);return missingContext?undefined:source;},
    encodeDisplayImage:async(image)=>{assert.equal(image,source);return 'cropped';},
  };
  const name=kind==='generated'?'createGeneratedDisplayPreviewUncached':'createCaptureMaskedPreviewUncached';
  const result=await bind(previewFunction(name),name,scope)('original',kind==='capture'?'mask':undefined,new AbortController().signal);
  assert.deepEqual(calls,[kind==='generated'?[4,3,15,17]:[6,5,11,13]],'Keep each path’s original padding');
  assert.deepEqual(result,kind==='generated'?{alignedUrl:'original',fittedUrl:missingContext?'original':'cropped'}:missingContext?'original':'cropped');
}
console.log('Shared preview crop passed: exact draw/read rectangles, RGBA ownership, cleanup, distinct padding and original fallbacks.');
for (const projected of [false,true]) for (const abortAfterRead of [false,true]) {
  const controller = new AbortController(), events = [];
  const run = bind(previewFunction('createLayerThumbnail').replace('export ', ''), 'createLayerThumbnail', {
    requestLayerThumbnail: (key, work, signal) => { assert.deepEqual(JSON.parse(key), ['source','depth',7,projected]); return work(signal); },
    createGeneratedDisplayPreview: async (url, depth, request) => {
      assert.deepEqual([url,depth,request.revision], ['source','depth',7]); events.push('exact-preview'); return {fittedUrl:'exact-fitted'};
    },
    urlToImageData: async (url, width, height, options) => {
      assert.equal(url, projected ? 'exact-fitted' : 'source');
      assert.deepEqual([width,height,options.maxSize,options.cooperative], [undefined,undefined,128,true]);
      events.push('thumbnail'); if (abortAfterRead) controller.abort(); return 'pixels';
    },
    encodeDisplayImage: async (pixels) => { assert.equal(pixels,'pixels'); events.push('encode'); return 'small-png'; },
  });
  const result = run('source','depth',{revision:7,signal:controller.signal},projected);
  if (abortAfterRead) { await assert.rejects(result,{name:'AbortError'}); assert.equal(events.at(-1),'thumbnail'); }
  else assert.deepEqual(await result,{alignedUrl:'small-png',fittedUrl:'small-png'});
  assert.equal(events.includes('exact-preview'),projected,'Only projected thumbnails consume the original exact mask/crop pipeline');
}
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
    paddedDisplayBounds,
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

// Execute both production masks against the frozen pixel implementation,
// including RGB under zero alpha and non-aligned input data views.
class MaskPixels {
  constructor(data, width, height) {
    Object.assign(this, { data, width, height });
  }
}
globalThis.ImageData = MaskPixels;
const depthMask = bind(previewFunction('applyPackedDepthDisplayMask').replace('export ', ''), 'applyPackedDepthDisplayMask', { ImageData: MaskPixels });
const darkMask = bind(`${previewFunction('getTone')}\n${previewFunction('removeStrictOuterDarkDisplayBackground').replace('export ', '')}`, 'removeStrictOuterDarkDisplayBackground', { ImageData: MaskPixels });
const thresholds = [0, 1, 8, 9, 11, 16, 17, 20, 24, 25, 32, 33, 253, 254, 255];
for (let fixture = 0; fixture < 600; fixture++) {
  const width = 1 + fixture % 43, height = 1 + fixture % 29;
  const image = new MaskPixels(new Uint8ClampedArray(new ArrayBuffer(width * height * 4 + 3), 3), width, height);
  const depth = new MaskPixels(new Uint8ClampedArray(width * height * 4), width, height);
  for (let i = 0; i < image.data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    image.data[i] = thresholds[seed % thresholds.length];
    depth.data[i] = 253 + seed % 3;
  }
  if (fixture % 3 === 0) image.data.fill(fixture % 256);
  const unchanged = image.data.slice();
  for (const [actual, expected] of [[depthMask(image, depth), referenceDepth(image, depth)], [darkMask(image), referenceDark(image)]]) {
    assert.deepEqual(actual.imageData.data, expected.imageData.data);
    assert.equal(actual.changedPixels, expected.changedPixels);
    assert.deepEqual([actual.imageData.width, actual.imageData.height], [width, height]);
    assert.notEqual(actual.imageData.data.buffer, image.data.buffer);
  }
  assert.deepEqual(image.data, unchanged, 'Neither mask may mutate the input');
}
assert.throws(() => depthMask(new MaskPixels(new Uint8ClampedArray(4), 1, 1), {width:2,height:1}), /dimensions must match/);
if (process.argv.includes('--benchmark')) {
  const input = new MaskPixels(new Uint8ClampedArray(1024 * 1024 * 4).fill(255), 1024, 1024);
  const depth = new MaskPixels(input.data.slice(), 1024, 1024);
  const median = (fn) => {
    const samples = [];
    for (let i = 0; i < 25; i++) { const start = performance.now(); fn(); if (i >= 5) samples.push(performance.now() - start); }
    return samples.sort((a,b) => a-b)[10].toFixed(2);
  };
  console.log(`Depth mask 1024: ${median(() => referenceDepth(input, depth))} -> ${median(() => depthMask(input, depth))} ms`);
  input.data.fill(0);
  console.log(`Transparent flood 1024: ${median(() => referenceDark(input))} -> ${median(() => darkMask(input))} ms`);
  for (let i = 3; i < input.data.length; i += 4) input.data[i] = 255;
  console.log(`Opaque dark flood 1024: ${median(() => referenceDark(input))} -> ${median(() => darkMask(input))} ms`);
}
console.log('Display masks passed: 600 byte-exact fixtures, threshold edges, source ownership and dimension errors.');
