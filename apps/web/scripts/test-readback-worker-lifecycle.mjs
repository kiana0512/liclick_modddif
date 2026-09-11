import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/engine/bake/gpuReadbackConversionWorker.ts', import.meta.url), 'utf8');
assert.match(source, /gpuReadbackConversion\.worker\?worker&inline/);
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness(constructorFailures = 0) {
  const workers = [], timers = new Set();
  class Worker {
    messages = [];
    constructor() {
      if (constructorFailures-- > 0) throw Error('constructor blocked');
      workers.push(this);
    }
    ready() { this.onmessage({ data: { ready: 1 } }); }
    error(message = '') { this.onerror({ message, preventDefault() {} }); }
    postMessage(message, transfer) {
      if (this.postError) throw Error('post failed');
      this.messages.push(globalThis.structuredClone(message, { transfer }));
    }
    answer(index = 0) {
      const request = this.messages[index];
      this.onmessage({ data: { id: request.id, mode: 'quality', quality: new Float32Array([1]).buffer } });
    }
    terminate() { this.terminated = true; }
  }
  const exports = {};
  new Function('require', 'exports', 'setTimeout', 'clearTimeout', code)(
    () => ({ default: Worker }), exports,
    (fn) => { timers.add(fn); return fn; }, (fn) => timers.delete(fn),
  );
  return { workers, timers, convert: (bytes = new Uint8Array([255])) => exports.convertQualityGpuReadbackInWorker(bytes, 1, true) };
}

{
  const h = harness(), a = new Uint8Array([123]), b = new Uint8Array([255]);
  const pa = h.convert(a), pb = h.convert(b);
  assert.equal(h.workers.length, 1, 'concurrent requests share bootstrap');
  assert.equal(h.workers[0].messages.length, 0);
  h.workers[0].error();
  await settle();
  assert.equal(a.byteLength, 1, 'bootstrap error cannot detach input');
  assert.equal(b.byteLength, 1);
  assert.equal(h.workers.length, 2, 'one shared bootstrap retry');
  const current = h.workers[1]; current.ready(); await settle();
  assert.equal(a.byteLength, 0); assert.equal(b.byteLength, 0);
  assert.deepEqual(current.messages.map((m) => [...new Uint8Array(m.pixels)]), [[123], [255]]);
  current.answer(1); current.answer(0);
  await Promise.all([pa, pb]);
  assert.equal(h.timers.size, 0);
}
{
  const h = harness(1), promise = h.convert(); await settle();
  h.workers[0].ready(); await settle(); h.workers[0].answer(); await promise;
}
{
  const h = harness(), bytes = new Uint8Array([90]), promise = h.convert(bytes);
  const rejected = assert.rejects(promise, /启动超时/);
  [...h.timers][0](); await settle(); [...h.timers][0](); await rejected;
  assert.equal(h.workers.length, 2, 'bounded retry, no endless spin');
  assert.equal(bytes.byteLength, 1);
  assert.equal(h.timers.size, 0); assert(h.workers.every((w) => w.terminated));
}
{
  const h = harness(), promise = h.convert(), rejected = assert.rejects(promise, /post failed/);
  const worker = h.workers[0]; worker.postError = true; worker.ready(); await rejected;
  worker.postError = false;
  const recovery = h.convert(); await settle(); worker.answer(); await recovery;
  assert.equal(h.workers.length, 1, 'post failure does not poison later requests');
}
for (const mode of ['error', 'messageerror']) {
  const h = harness(), a = h.convert(), b = h.convert();
  const rejectedA = assert.rejects(a, /转换失败|返回数据/), rejectedB = assert.rejects(b, /转换失败|返回数据/);
  const old = h.workers[0]; old.ready(); await settle();
  if (mode === 'error') old.error('crash'); else old.onmessageerror();
  await Promise.all([rejectedA, rejectedB]);
  assert.equal(h.workers.length, 1, 'never retry already transferred data');
  const next = h.convert(), current = h.workers[1];
  old.error('late old error'); old.onmessageerror();
  assert(!current.terminated, 'late events from dead workers cannot kill the replacement');
  current.ready(); await settle(); current.answer(); await next;
}
{
  const h = harness(), first = h.convert(), rejected = assert.rejects(first, /bad byte length/);
  const worker = h.workers[0]; worker.ready(); await settle();
  worker.onmessage({ data: { id: worker.messages[0].id, error: 'bad byte length' } });
  await rejected;
  const next = h.convert(); await settle(); worker.answer(1); await next;
  assert.equal(h.workers.length, 1, 'invalid conversion remains a request error');
}
console.log('Readback Worker: ready-before-transfer, bounded bootstrap retry, failure cleanup and stale-event isolation passed.');
