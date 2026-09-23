import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';
import ts from 'typescript';

const source = readFileSync(new URL('../src/workers/compositeUvLayers.worker.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(fault) {
  const bitmaps = [], replies = [], draws = [], transforms = [];
  const pendingDecode = deferred(), decodeStarted = deferred();
  const bitmap = (name, width = 4, height = 4) => {
    const value = { name, width, height, closed: 0, close() { this.closed++; } };
    bitmaps.push(value);
    return value;
  };
  const fetch = async (url, options) => {
    assert.equal(options.credentials, 'same-origin');
    if (url === 'pending-fetch') {
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        decodeStarted.resolve();
      });
    }
    if (url === 'bad') {
      await decodeStarted.promise;
      return { ok: false, status: 503 };
    }
    return { ok: true, blob: async () => url };
  };
  const createImageBitmap = async (url, options) => {
    assert.deepEqual(options, { imageOrientation: 'none', premultiplyAlpha: 'none' });
    if (url === 'slow') { decodeStarted.resolve(); await pendingDecode.promise; }
    if (url === 'decode-error') throw new Error('decode failed');
    return bitmap(url, url === 'wide' ? 8 : 4, url === 'tall' ? 8 : 4);
  };
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      if (fault === 'context') return null;
      return {
        clearRect() {}, save() {}, restore() {},
        translate: (...args) => transforms.push(['translate', ...args]),
        scale: (...args) => transforms.push(['scale', ...args]),
        drawImage(value, ...args) {
          if (fault === 'draw') throw new Error('draw failed');
          assert.equal(value.closed, 0);
          draws.push([value.name, this.globalAlpha, this.globalCompositeOperation, ...args]);
        },
      };
    }
    transferToImageBitmap() {
      if (fault === 'canvas-transfer') throw new Error('canvas transfer failed');
      return bitmap('output', this.width, this.height);
    }
  }
  const worker = { postMessage(response, options) {
    if (response.bitmap) {
      if (fault === 'post') throw new Error('post failed');
      assert.deepEqual(options.transfer, [response.bitmap]);
    }
    replies.push(response);
  } };
  new Function('self', 'exports', 'fetch', 'createImageBitmap', 'OffscreenCanvas', code)(
    worker, {}, fetch, createImageBitmap, Canvas,
  );
  return { worker, bitmap, bitmaps, replies, draws, transforms, pendingDecode, decodeStarted };
}

// An early HTTP failure races an already-started native decode. Reply only after
// every acquired input has been released, so a new full-size job cannot overlap.
{
  const f = fixture();
  const input = f.bitmap('owned');
  const work = f.worker.onmessage({ data: { id: 1, layers: [
    { bitmap: input, opacity: 1 }, { imageUrl: 'bad', opacity: 1 }, { imageUrl: 'slow', opacity: 1 },
  ] } });
  await f.decodeStarted.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.replies.length, 0, 'Failure must drain late decodes before releasing the worker slot');
  f.pendingDecode.resolve();
  await work;
  assert.match(f.replies[0].error, /503/);
  assert(f.bitmaps.every(value => value.closed === 1), 'All owned/late inputs close exactly once');
  await f.worker.onmessage({ data: { id: 2, layers: [{ imageUrl: 'wide', opacity: 0.5 }] } });
  assert.equal(f.replies[1].bitmap.width, 8, 'Worker remains usable after failure');
}

{
  const f = fixture();
  await f.worker.onmessage({ data: { id: 5, layers: [
    { imageUrl: 'pending-fetch', opacity: 1 }, { imageUrl: 'bad', opacity: 1 },
  ] } });
  assert.match(f.replies[0].error, /503/, 'Cancel remaining network work and preserve original failure');
}

for (const fault of ['decode-error', 'context', 'draw', 'canvas-transfer', 'post']) {
  const f = fixture(fault);
  await f.worker.onmessage({ data: { id: 3, layers: [
    { bitmap: f.bitmap('input'), opacity: 0.5 },
    { imageUrl: fault === 'decode-error' ? fault : 'wide', opacity: 1 },
  ] } });
  assert.equal(typeof f.replies[0].error, 'string', fault);
  assert(f.bitmaps.every(value => value.closed === 1), `${fault}: release all inputs and unsent output`);
}

// Keep max dimensions, vertical upload orientation, input order, alpha clamp,
// and source-over drawing unchanged despite out-of-order asynchronous decode.
{
  const f = fixture();
  const work = f.worker.onmessage({ data: { id: 4, layers: [
    { imageUrl: 'slow', opacity: -1 }, { imageUrl: 'wide', opacity: 0.5 },
    { imageUrl: 'tall', opacity: 2 },
  ] } });
  await f.decodeStarted.promise;
  f.pendingDecode.resolve(); await work;
  assert.deepEqual(f.transforms, [['translate', 0, 8], ['scale', 1, -1]]);
  assert.deepEqual(f.draws, [
    ['slow', 0, 'source-over', 0, 0, 8, 8],
    ['wide', 0.5, 'source-over', 0, 0, 8, 8],
    ['tall', 1, 'source-over', 0, 0, 8, 8],
  ]);
  assert(f.bitmaps.filter(value => value.name !== 'output').every(value => value.closed === 1));
  assert.equal(f.replies[0].bitmap.closed, 0, 'Transferred result belongs to the caller');
  assert.equal(f.replies[0].width, 8); assert.equal(f.replies[0].height, 8);
}
console.log('UV compositor bitmap lifecycle and drawing contract regressions passed.');
