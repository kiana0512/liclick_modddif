import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root, appType: 'custom', logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } },
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const bitmap = () => ({ width: 4096, height: 4096, closed: 0, close() { this.closed++; } });

try {
  const scheduler = await server.ssrLoadModule('/src/engine/layers/uvLayerCompositeWorker.ts');
  const scene = await fs.readFile(path.join(root, 'src/engine/viewport/SceneRoot.tsx'), 'utf8');
  const expression = scene.match(/:\s*await (prepareUvCompositeBitmaps\([\s\S]*?),\s*workerOwnerKey,\s*\);/)?.[1];
  assert.ok(expression, 'Exercise the production live-source preparation call site.');
  const prepare = new Function('sortedSources', 'createImageBitmap', 'prepareUvCompositeBitmaps',
    `return (async () => (${expression}))()`);
  const run = (sources, decode) => prepare(sources.map((source, i) => ({ source, layer: { opacity: i / 4 } })),
    decode, scheduler.prepareUvCompositeBitmaps);

  // Fail first, then let an already started native decode finish. Failure must
  // not release the composing guard early or lose ownership of either bitmap.
  for (const reason of [new Error('decode failed'), undefined]) {
    const late = deferred(), failure = deferred();
    const earlyBitmap = bitmap(), lateBitmap = bitmap();
    let settled = false;
    const result = run([0, 1, 2].map(id => ({ id })), source => {
      if (source.id === 0) return Promise.resolve(earlyBitmap);
      if (source.id === 1) return failure.promise;
      return late.promise;
    }).then(() => { settled = true; return { ok: true }; }, error => { settled = true; return { error }; });
    failure.reject(reason);
    await flush();
    const settledBeforeDrain = settled;
    late.resolve(lateBitmap);
    const outcome = await result;
    assert.equal(settledBeforeDrain, false, 'Do not start another compose while failed decodes remain in flight.');
    assert.equal(outcome.error, reason, 'Preserve even an undefined rejection reason.');
    assert.equal(earlyBitmap.closed, 1);
    assert.equal(lateBitmap.closed, 1, 'Release a success arriving after the failure.');
  }

  // Success: start all snapshots immediately, allow out-of-order completion,
  // retain exact input identity, resolution, opacity and bottom-to-top order.
  const gates = Array.from({ length: 4 }, deferred);
  const images = gates.map(bitmap), starts = [];
  const success = run(gates, (...args) => {
    assert.equal(args.length, 1, 'No resize, pixel conversion or changed bitmap options.');
    const index = gates.indexOf(args[0]); starts.push(index);
    return gates[index].promise;
  });
  assert.deepEqual(starts, [0, 1, 2, 3], 'All native decodes begin before any resolve.');
  for (const index of [3, 1, 0, 2]) gates[index].resolve(images[index]);
  const layers = await success;
  assert.deepEqual(layers, images.map((image, i) => ({ bitmap: image, opacity: i / 4 })));
  assert.ok(images.every(image => image.closed === 0 && image.width === 4096));

  // Exercise both branches of the unified production dispatch, including its
  // owner key. Static URLs must never acquire main-thread bitmaps.
  const dispatchExpression = scene.match(/const bitmap = (await compositeUvLayersInWorker[\s\S]*?);\s*if \(options\?\.maxSize/)?.[1];
  assert.ok(dispatchExpression);
  const dispatch = new Function('staticSources', 'sortedSources', 'createImageBitmap',
    'prepareUvCompositeBitmaps', 'compositeUvLayersInWorker', 'workerOwnerKey',
    `return (async () => (${dispatchExpression.replace('layer.imageUrl!', 'layer.imageUrl')}))()`);
  const rows = [{ source: {}, layer: { imageUrl: '/full-size.png', opacity: 0.75 } }];
  const staticOutput = {};
  assert.equal(await dispatch(true, rows, () => assert.fail('Static input decoded on main thread'),
    () => assert.fail('Static input entered live preparation'), (input, owner) => {
      assert.deepEqual(input, [{ imageUrl: '/full-size.png', opacity: 0.75 }]);
      assert.equal(owner, 'static-owner');
      return staticOutput;
    }, 'static-owner'), staticOutput);
  const liveFailure = new Error('live preparation failed');
  await assert.rejects(dispatch(false, rows, () => Promise.reject(liveFailure),
    scheduler.prepareUvCompositeBitmaps, () => assert.fail('Failed decode was dispatched'), 'live-owner'),
    error => error === liveFailure);

  globalThis.document = { body: { dataset: {} } };
  const workers = [];
  globalThis.Worker = class {
    constructor() { workers.push(this); }
    postMessage(message, options) { this.message = message; this.options = options; }
  };
  const transferred = scheduler.compositeUvLayersInWorker(layers, 'live-owner');
  const worker = workers[0];
  assert.deepEqual(worker.options.transfer, images);
  assert.ok(images.every(image => image.closed === 0), 'Only the receiving Worker owns transferred inputs.');
  const output = bitmap();
  worker.onmessage({ data: { id: worker.message.id, bitmap: output, width: 4096, height: 4096 } });
  assert.equal(await transferred, output);

  // The existing missing-source guard and synchronous decode exceptions must
  // clean siblings too. Multiple failures must not cause unhandled rejections.
  for (const missing of [true, false]) {
    const survivors = [];
    const result = run([{}, missing ? undefined : {}, {}], source => {
      if (source) {
        if (!missing && survivors.length) throw new Error('synchronous decode');
        const survivor = bitmap();
        survivors.push(survivor);
        return Promise.resolve(survivor);
      }
      throw new Error('unexpected source');
    });
    await assert.rejects(result, missing ? /not decoded/ : /synchronous decode/);
    assert.equal(survivors.length, missing ? 2 : 1);
    assert.ok(survivors.every(image => image.closed === 1));
  }
  assert.deepEqual(await run([], () => { throw new Error('empty'); }), []);
  console.log('Live UV bitmap lifecycle: drain, cleanup, parallel order, full-size identity and Worker ownership passed.');
} finally {
  await server.close();
}
