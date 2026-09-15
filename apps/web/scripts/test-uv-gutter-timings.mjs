import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';
import { padUvIslandGuttersWithTopology as reference } from './fixtures/uv-gutter-b3431cb.ts';

const source = await readFile(new URL('../src/engine/bake/dilation.ts', import.meta.url), 'utf8');
let clock = 0;
const api = {};
new Function('require', 'exports', 'performance', ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(name => { assert.equal(name, 'three'); return THREE; }, api, { now: () => clock += 10 });
const size = 128, topology = new Uint8Array(size * size);
const original = new Uint8ClampedArray(size * size * 4).fill(91), coverage = topology.slice();
for (let y = 8; y < size - 8; y++) for (let x = 8; x < size - 8; x++) {
  topology[y * size + x] = coverage[y * size + x] = 1;
}
for (const mode of [true, false, 'rgb-only']) {
  const image = { width: size, height: size, data: original.slice() }, mask = coverage.slice();
  const gold = { ...image, data: original.slice() }, goldMask = coverage.slice();
  const expected = reference(gold, goldMask, topology, 8, mode);
  let yields = 0;
  const timings = {}, start = clock;
  const count = await api.padUvIslandGuttersWithTopologyCooperatively(image, mask, topology, 8, mode,
    async () => { yields++; clock += 100; }, true, timings);
  assert(yields > 0);
  assert.equal(timings.gutterYieldMs, yields * 110, 'scheduler delays are separately accounted');
  assert(timings.gutterBoundaryScanMs > 0);
  assert(timings.gutterExpansionMs > 0);
  assert.equal(timings.gutterTopologyRasterMs, 0);
  assert(timings.gutterBoundaryScanMs + timings.gutterExpansionMs + timings.gutterYieldMs <= clock - start);
  assert.equal(count, expected); assert.deepEqual(image.data, gold.data); assert.deepEqual(mask, goldMask);
  await api.padUvIslandGuttersWithTopologyCooperatively(image, mask, topology, 0, mode, async () => {}, true, timings);
  assert(Object.values(timings).every(value => value === 0), 'reused metrics do not retain an old run');
}
// Execute the production stage wrapper with controlled preparation/compute
// durations so overlap cannot accidentally be counted twice in the report.
const bake = await readFile(new URL('../src/engine/bake/bakeProjectedLayerToTexture.ts', import.meta.url), 'utf8');
const start = bake.indexOf('        const gutterStartedAt =');
const end = bake.indexOf('        const finalizeStartedAt =', start);
assert(start >= 0 && end > start);
for (const useWorker of [false, true]) {
const breakdown = {};
const wrapper = new Function('performance', 'input', 'getUvGutterTopology',
  'padUvIslandGuttersWithTopologyCooperatively', 'performanceBreakdown',
  'padResidentUvGutterInWorker', 'markUvBakePerformancePhase', 'composite', 'qualityCoverage', 'yieldPostprocess',
  ts.transpileModule('return (async () => {' + bake.slice(start, end) + '})();', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText);
await wrapper({ now: () => clock += 10 }, { uvIslandGutterPixels: 4, outputAlpha: 'transparent' },
  async () => { clock += 500; return { mask: topology }; },
  async (_image, _coverage, _topology, _iterations, _alpha, _yield, _immutable, timings) => {
    Object.assign(timings, { gutterBoundaryScanMs: 30, gutterExpansionMs: 40, gutterYieldMs: 100, gutterTopologyRasterMs: 0 });
    clock += 170; return 0;
  }, breakdown, async () => {
    if (!useWorker) return undefined;
    clock += 170;
    return { imageData: {}, coverage, paddedPixels: 0, timings: {
      gutterBoundaryScanMs: 30, gutterExpansionMs: 40, gutterYieldMs: 100, gutterTopologyRasterMs: 0,
    } };
  }, () => {}, {}, coverage, async () => {});
assert.equal(breakdown.gutterTopologyWaitMs, 510);
assert.equal(breakdown.gutterYieldMs, 100);
assert.equal(Object.entries(breakdown).filter(([key]) => key !== 'gutterMs' && key !== 'gutterWorkerUsed').reduce((sum, [, value]) => sum + value, 0), breakdown.gutterMs);
assert.equal(breakdown.gutterWorkerUsed, Number(useWorker));
}
console.log('UV gutter timings: cold/warm phases, scheduler waits, reset, exact pixels and stage total accounting passed.');
