import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setImmediate } from 'node:timers';
import ts from 'typescript';

const source = await fs.readFile(process.env.LI3D_TEST_UPLOAD_SOURCE ?? new URL('../src/engine/viewport/previewTextureCache.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source.slice(source.indexOf('export function uploadPreviewTextureInStripes(')), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

async function run(failure, flipY, fast = false) {
  let cancelled = false;
  let uploads = 0;
  let monitors = 0;
  let invalidations = 0;
  const bitmaps = [];
  const submissions = [];
  class Bitmap {
    constructor(width, height, row = -1) { this.width = width; this.height = height; this.row = row; this.closed = 0; }
    close() { assert.equal(this.closed++, 0, 'each owned bitmap closes exactly once'); }
  }
  const texture = { image: new Bitmap(2, 8), source: { dataReady: true }, userData: {}, flipY };
  const states = new Map([['active', 7], ['binding', 'original'], ['flip', true], ['premultiply', true]]);
  const context = {
    ACTIVE_TEXTURE: 'active', TEXTURE_BINDING_2D: 'binding', UNPACK_FLIP_Y_WEBGL: 'flip',
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 'premultiply', TEXTURE_2D: '2d', RGBA: 'rgba', UNSIGNED_BYTE: 'byte',
    getParameter: key => states.get(key), pixelStorei: (key, value) => states.set(key, value),
    activeTexture: value => states.set('active', value), bindTexture: (_, value) => states.set('binding', value), flush() {},
    texSubImage2D(...args) {
      if (failure === 'submit') throw new Error('submit failed');
      const bitmap = args.at(-1);
      submissions.push([args[3], bitmap.row, bitmap.height]);
    },
  };
  const renderer = { domElement: { isConnected: true }, getContext: () => context,
    initTexture() { if (failure === 'allocate') throw new Error('allocation failed'); },
    properties: { get: () => ({ __webglTexture: 'new' }) },
  };
  let waitCount = 0;
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  const scope = {
    window: { location: { search: fast ? '?perfResidentQuality=1' : '' } },
    yieldToBrowserTask: async () => { await new Promise(resolve => setImmediate(resolve)); },
    exports: {}, ImageBitmap: Bitmap, document: { body: { dataset: {} } },
    previewTextureReadyRenderers: new WeakMap(), previewTextureUploadPromises: new WeakMap(),
    markPreviewTextureUploadStarted: () => uploads++, markPreviewTextureUploadFinished: () => uploads--,
    getWorkerBitmapId: () => undefined, previewUploadGovernorEnabled: () => true,
    createTextureUploadBudget: () => ({ pixels: 4 }), updateTextureUploadBudget: budget => budget,
    startFrameIntervalMonitor: () => { monitors++; return { stop: () => monitors--, readAndReset: () => ({}) }; },
    waitForViewportInteractionIdle: async () => { if (failure === 'before-allocation') cancelled = true; },
    isViewportInteractionBusy: () => false,
    waitForBrowserPaint: async () => {
      waitCount++;
      if (failure === 'after-crop' && waitCount === 1) cancelled = true;
      if (failure === 'drain' && waitCount === 5) cancelled = true;
      // A rejected next crop may sit across a whole browser task before use.
      await new Promise(resolve => setImmediate(resolve));
    },
    createImageBitmap: async (_, x, y, width, height) => {
      if ((failure === 'first-crop' && y === 0) || (failure === 'next-crop' && y > 0)) throw new Error('crop failed');
      if (failure === 'late-crop' && y > 0) await new Promise(resolve => setTimeout(resolve, 5));
      const bitmap = new Bitmap(width, height, y); bitmaps.push(bitmap); return bitmap;
    },
    markPreviewUploadStep() {}, invalidatePreviewTextureAfterUploadFailure: () => invalidations++,
    PREVIEW_TEXTURE_UPLOAD_STRIPES_PER_FLUSH: 4, DETACHED_PREVIEW_TEXTURE_UPLOAD_PIXELS_PER_FRAME: 4,
  };
  if (failure === 'late-crop') context.texSubImage2D = () => { throw new Error('submit failed'); };
  try {
    const upload = new Function(...Object.keys(scope), code + ';return uploadPreviewTextureInStripes;')(...Object.values(scope));
    const operation = upload(renderer, texture, { shouldCancel: () => cancelled });
    if (failure) await assert.rejects(operation); else await operation;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(uploads, 0);
    assert.equal(monitors, 0, 'allocation errors also stop frame monitoring');
    assert.equal(texture.source.dataReady, true);
    assert.equal(invalidations, failure ? 1 : 0);
    assert.equal(Boolean(texture.userData.liclickPreviewStripedUploadReady), !failure);
    for (const bitmap of bitmaps) assert.equal(bitmap.closed, 1, 'active and pending crops are released');
    assert.equal(texture.image.closed, 0, 'the source image belongs to its caller');
    assert.deepEqual(unhandled, []);
    if (!failure) assert.deepEqual(submissions, [0, 2, 4, 6].map(y => [flipY ? 6 - y : y, y, 2]));
    assert.equal(states.get('active'), 7);
    assert.equal(states.get('binding'), 'original');
    assert.equal(Boolean(states.get('flip')), true);
    assert.equal(Boolean(states.get('premultiply')), true);
  } finally { process.off('unhandledRejection', onUnhandled); }
}

for (const failure of [undefined, 'before-allocation', 'allocate', 'first-crop', 'next-crop', 'submit', 'late-crop']) {
  for (const flipY of [false,true]) await run(failure,flipY,true);
}

for (let cycle = 0; cycle < 10; cycle++) {
  for (const failure of [undefined, 'before-allocation', 'allocate', 'first-crop', 'next-crop', 'after-crop', 'submit', 'late-crop', 'drain']) {
    await run(failure, cycle % 2 === 1);
  }
}
console.log('Preview upload cleanup passed: 90 baseline + 14 batched success/cancel/failure cases; late/rejected crops, GL state, source ownership, orientation and zero live monitors/uploads.');
