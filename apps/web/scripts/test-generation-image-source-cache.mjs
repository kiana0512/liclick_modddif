import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/services/generationImageSourceCache.ts', import.meta.url), 'utf8');
const module = {};
new Function('exports', ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText)(module);
const { GenerationImageSourceCache } = module;
const a = 'data:image/png;base64,AA==', b = 'data:image/png;base64,AQ==';
const prepared = { blob: new Blob([new Uint8Array([0, 1, 127, 255])]), digest: 'exact-file-digest' };
let loads = 0;
const load = async () => { loads++; return prepared; };
const cache = new GenerationImageSourceCache();
const first = cache.prepare(a, load);
assert.equal(cache.prepare(a, load), first, 'concurrent identical immutable input shares preparation');
assert.equal(await first, prepared);
assert.equal(await cache.prepare(a, load), prepared);
assert.equal(loads, 1, 'repeat saves do not fetch/decode/hash again');
await cache.prepare(b, load);
assert.equal(loads, 2, 'a changed source does not reuse a previous preparation');
assert.deepEqual([...new Uint8Array(await prepared.blob.arrayBuffer())], [0, 1, 127, 255]);
for (const url of ['blob:mutable', 'https://provider.test/changeable', 'liclick-live-projected-canvas:paint']) {
  await cache.prepare(url, load); await cache.prepare(url, load);
}
assert.equal(loads, 8, 'mutable sources are never retained');
for (const bounded of [new GenerationImageSourceCache(1), new GenerationImageSourceCache(1000, 0)]) {
  let calls = 0;
  await bounded.prepare(a, async () => { calls++; return prepared; });
  await bounded.prepare(a, async () => { calls++; return prepared; });
  assert.equal(calls, 2, 'oversize and zero-capacity inputs keep the original exact path');
}
const lru = new GenerationImageSourceCache(1000, 1);
let rereads = 0;
await lru.prepare(a, load); await lru.prepare(b, load);
await lru.prepare(a, async () => { rereads++; return prepared; });
assert.equal(rereads, 1, 'eviction drops only disposable source preparation');
const failure = new Error('read/hash failed');
await assert.rejects(cache.prepare('data:image/png;base64,FAIL', async () => { throw failure; }), error => error === failure);
assert.equal(await cache.prepare('data:image/png;base64,FAIL', load), prepared, 'failed preparation is retryable');
let rejectOld;
const stale = new GenerationImageSourceCache(1000, 1);
const old = stale.prepare(a, () => new Promise((_, reject) => { rejectOld = reject; }));
await Promise.resolve();
await stale.prepare(b, load);
const replacement = stale.prepare(a, load);
rejectOld(failure);
await assert.rejects(old, error => error === failure);
await replacement;
assert.equal(stale.prepare(a, load), replacement, 'late rejection cannot remove the replacement entry');
console.log('Generation source preparation: exact bytes, concurrent/repeat reuse, mutable bypass, bounded eviction and failure recovery passed.');
