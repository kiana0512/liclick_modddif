import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Exercise the real worker queue and CPU blend. Only browser I/O is substituted.
const source = await readFile(new URL('../src/workers/webGpuRgbaComposite.worker.ts', import.meta.url), 'utf8');
const pending = new Map();
let fetches = 0, decodes = 0, closes = 0, fail = false, duringDecode;
const scope = { navigator: {}, postMessage(message, transfer = []) {
  const delivered = globalThis.structuredClone(message, { transfer });
  pending.get(message.id)(delivered); pending.delete(message.id);
} };
const raster = [17, 41, 93, 128];
class Canvas {
  getContext() { return {
    clearRect() {}, drawImage() {},
    getImageData(_x, _y, width, height) {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < data.length; i += 4) data.set(raster, i);
      return { data };
    },
  }; }
}
new Function('require', 'exports', 'self', 'fetch', 'createImageBitmap', 'OffscreenCanvas',
  ts.transpileModule(pipelineTraceDisabled(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(
  name => {
    if (name.endsWith('workerScheduling')) return { yieldWorkerTask: async () => {} };
    if (name.endsWith('encodeRgbaPngCore')) return {};
    throw Error(name);
  }, {}, scope,
  async () => { fetches++; if (fail) { fail = false; throw Error('decode failed'); } return { ok: true, blob: async () => new Blob([new Uint8Array(raster)], { type: 'image/png' }) }; },
  async () => { decodes++; duringDecode?.(); duringDecode = undefined; return { width: 1, height: 1, close() { closes++; } }; }, Canvas,
);
let id = 0;
const send = async (overrides = {}) => {
  const request = { type: 'composite', id: ++id, front: new Uint8ClampedArray([100, 80, 60, 128]).buffer,
    underlayUrl: 'https://example.test/asset', underlayCacheKey: 'layer:revision1', width: 1, height: 1,
    opacity: 0.7, verify: false, interactive: false, idleChunkBytes: 1e8, interactiveChunkBytes: 1e8, ...overrides };
  const response = new Promise(resolve => pending.set(request.id, resolve));
  scope.onmessage({ data: request });
  return response;
};
const bytes = result => { assert.equal(result.type, 'result'); return [...new Uint8ClampedArray(result.output)]; };
const first = bytes(await send());
const attributed = await send({ renderedColorMask: new Uint8Array([200]).buffer });
assert.deepEqual(
  [...new Uint8Array(attributed.renderedColorMask)],
  [Math.round(200 * 128 / new Uint8ClampedArray(attributed.output)[3])],
  'Worker updates rendered-color attribution from the exact old/new alpha bytes',
);
const transparent = await send({
  front: new Uint8ClampedArray([0, 0, 0, 128]).buffer,
  opacity: 0,
  renderedColorMask: new Uint8Array([211]).buffer,
});
assert.deepEqual([...new Uint8Array(transparent.renderedColorMask)], [211]);
assert.deepEqual(bytes(await send()), first);
assert.equal(decodes, 1, 'unchanged underlay must decode only once across transferred outputs');
assert.deepEqual(bytes(await send({ opacity: 0.3 })), bytes(await send({ opacity: 0.3, underlayCacheKey: undefined })));
const beforeRevision = decodes;
await send({ underlayCacheKey: 'layer:revision2' });
assert.equal(decodes, beforeRevision + 1, 'content revision invalidates');
await send({ underlayUrl: 'https://example.test/new-asset' });
assert.equal(decodes, beforeRevision + 2, 'asset URL invalidates');
await send({ width: 2, front: new Uint8ClampedArray(8).buffer });
assert.equal(decodes, beforeRevision + 3, 'dimensions invalidate');
await send();
const beforeOver = decodes;
const over = bytes(await send({ sourceOver: true }));
assert.equal(decodes, beforeOver);
assert.deepEqual(bytes(await send()), first, 'source-over must not mutate or detach cached bytes');
assert.deepEqual(over, bytes(await send({ sourceOver: true, underlayCacheKey: undefined })));
const beforePlain = decodes;
await send({ underlayCacheKey: undefined }); await send({ underlayCacheKey: undefined });
assert.equal(decodes, beforePlain, 'byte-verified requests reuse unchanged decode without an explicit revision');
scope.onmessage({ data: { type: 'release' } });
await send(); assert.equal(decodes, beforePlain + 1, 'release drops decoded pixels');
duringDecode = () => scope.onmessage({ data: { type: 'release' } });
await send({ underlayCacheKey: 'late-release' });
const afterLateRelease = decodes;
await send({ underlayCacheKey: 'late-release' });
assert.equal(decodes, afterLateRelease + 1, 'in-flight decode cannot repopulate released cache');
fail = true;
assert.equal((await send({ underlayCacheKey: 'failed' })).type, 'error');
await send({ underlayCacheKey: 'failed' });
const beforeCancel = decodes;
duringDecode = () => scope.onmessage({ data: { type: 'cancel', id } });
assert.equal((await send({ underlayCacheKey: 'cancelled' })).type, 'error');
await send({ underlayCacheKey: 'cancelled' });
assert.equal(decodes, beforeCancel + 2, 'cancelled decode is not cached');
assert(fetches > decodes, 'cache hits still fetch to check bytes and permission');
assert.equal(closes, decodes, 'every decoded bitmap closes, including cancellation');
const beforeEviction = decodes;
await send({ underlayCacheKey: 'replacement' }); await send({ underlayCacheKey: 'cancelled' });
assert.equal(decodes, beforeEviction + 2, 'only one decoded underlay is retained');
const beforeOversize = decodes;
for (let attempt = 0; attempt < 2; attempt++) {
  const result = await send({ width: 4097, height: 4096, front: new ArrayBuffer(4097 * 4096 * 4),
    underlayCacheKey: 'over64MiB' });
  assert.equal(result.type, 'result');
}
assert.equal(decodes, beforeOversize + 2, 'over-budget images are decoded at full resolution without caching');
console.log('Underlay reuse: exact blend, transfer ownership, revision/URL/size, source-over, release, failure and cancellation passed.');
import { pipelineTraceDisabled } from './pipeline-trace-test-build.mjs';
