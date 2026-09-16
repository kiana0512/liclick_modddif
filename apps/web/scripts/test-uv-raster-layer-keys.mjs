import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';

const source = readFileSync(new URL('../src/engine/bake/ProjectedUvRasterCache.ts', import.meta.url), 'utf8');
const module = { exports: {} };
new Function('module', 'exports', 'require', ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(module, module.exports, name => {
  if (name === 'three') return { RedFormat: 'red' };
  if (name === './UvContributionArchive') return { UvContributionArchive: class { dispose() {} } };
  if (name === './residentQualityComposite') return {};
  if (name === './uvContributionTiles') return {};
  throw new Error(`Unexpected cache dependency ${name}`);
});
const { ProjectedUvRasterCache } = module.exports;
const cache = new ProjectedUvRasterCache();
const layer = { id: 'paint', name: 'paint', type: 'projected', imageUrl: 'data:image/png;base64,AAAA',
  maskUrl: 'mask', depthUrl: 'depth', normalUrl: 'normal', localRepaintSourceUrl: 'source',
  localRepaintRawSourceUrl: 'raw', localRepaintMaskUrl: 'author-mask', renderedColorMaskUrl: 'uv-mask',
  camera: { projectionMatrix: [1, 2, 3] }, opacity: 1, strength: 1, visible: true, order: 3, blendMode: 'normal' };
const key = cache.layerKey(layer);
assert.equal(cache.layerKey({ ...layer, imageUrl: layer.imageUrl.split('').join('') }), key);
assert.equal(cache.layerKey({ ...layer, visible: false, name: 'renamed', order: 99 }), key);
for (const name of Object.keys(layer).filter(name => name.endsWith('Url'))) {
  assert.notEqual(cache.layerKey({ ...layer, [name]: layer[name] + 'different' }), key);
}
for (const patch of [{ opacity: 0.5 }, { strength: 0.2 }, { blendMode: 'multiply' },
  { camera: { projectionMatrix: [1, 2, 4] } }, { contentRevision: 1 }, { ignoreSourceAlpha: true },
  { adjustments: { hue: 1, saturation: 2, lightness: 3 } }, { objectId: 'another' }, { maskSpace: 'uv' }]) {
  assert.notEqual(cache.layerKey({ ...layer, ...patch }), key);
}
assert.notEqual(cache.layerKey({ ...layer, imageUrl: '["uv-url",1]' }), key);
assert.notEqual(cache.layerKey({ ...layer, normalUrl: undefined }), cache.layerKey({ ...layer, normalUrl: null }));
const before = JSON.stringify(layer);
cache.layerKey(layer); assert.equal(JSON.stringify(layer), before, 'Authored input is never replaced by tokens');
const renderer = { domElement: { addEventListener() {}, removeEventListener() {} } };
cache.prepare(renderer, 'geometry-a', [key]);
assert.equal(cache.layerKey(layer), key, 'GPU scope clear retains exact source identities');
cache.prepare(renderer, 'geometry-b', [key]);
assert.equal(cache.layerKey(layer), key);
for (let i = 0; i < 2100; i++) cache.layerKey({ ...layer, imageUrl: `unique-${i}` });
assert.ok(cache.sourceKeys.size <= 2048);
assert.equal(cache.layerKey(layer), key, 'Capacity fallback never evicts an active source identity');
const overflow = cache.layerKey({ ...layer, imageUrl: 'overflow-source' });
assert.equal(JSON.parse(overflow).imageUrl, 'overflow-source');
assert.equal(cache.layerKey({ ...layer, imageUrl: 'overflow-source' }), overflow);
cache.dispose(); assert.equal(cache.sourceKeys.size, 0); assert.equal(cache.sourceKeyBytes, 0);
assert.throws(() => cache.layerKey(layer), { name: 'AbortError' });

// Exercise the actual key builders on a returned-image-sized stack; report
// timings without a flaky speed assertion or claiming whole-project latency.
const bench = new ProjectedUvRasterCache();
const layers = Array.from({ length: 14 }, (_, i) => ({ ...layer, id: `view-${i}`,
  imageUrl: 'data:image/png;base64,' + 'A'.repeat(2 * 1024 * 1024) + String(i) }));
const started = performance.now();
const originalKeys = layers.map(value => JSON.stringify({ ...value, visible: true, name: '', order: 0 }));
const beforeMs = performance.now() - started;
const compactStart = performance.now();
const compactKeys = layers.map(value => bench.layerKey(value));
const coldMs = performance.now() - compactStart;
const hotStart = performance.now();
assert.deepEqual(layers.map(value => bench.layerKey(value)), compactKeys);
const hotMs = performance.now() - hotStart;
assert.ok(compactKeys.join('').length < originalKeys.join('').length / 1000);
const budgetOverflow = 'data:image/png;base64,' + 'B'.repeat(5 * 1024 * 1024);
assert.equal(JSON.parse(bench.layerKey({ ...layer, imageUrl: budgetOverflow })).imageUrl, budgetOverflow);
assert.ok(bench.sourceKeyBytes <= 64 * 1024 * 1024);
assert.deepEqual(layers.map(value => bench.layerKey(value)), compactKeys, 'Byte-budget overflow must retain existing keys');
bench.dispose();
process.stdout.write(`Exact UV layer keys passed: all source URLs and pixel inputs invalidate, owner/capacity isolation, no input mutation. 14x2MiB strings: original ${beforeMs.toFixed(1)}ms, cold ${coldMs.toFixed(1)}ms, hot ${hotMs.toFixed(1)}ms (key construction only).\n`);
