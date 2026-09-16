import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import * as THREE from 'three';
import { padUvIslandGuttersWithTopologyCooperatively as current } from '../src/engine/bake/dilation.ts';

// Freeze the immediately preceding production implementation, not an older,
// slower reference oracle. No project, renderer or persistent state is loaded.
const baseline = {};
const source = execFileSync('git', ['show', '6dcdec1:apps/web/src/engine/bake/dilation.ts'], { encoding: 'utf8' });
new Function('require', 'exports', ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(name => { assert.equal(name, 'three'); return THREE; }, baseline);
const previous = baseline.padUvIslandGuttersWithTopologyCooperatively;
const size = 4096, rgba = new Uint8ClampedArray(size * size * 4);
const coverage = new Uint8Array(size * size), topology = new Uint8Array(size * size);
for (let panel = 0; panel < 6; panel++) {
  const left = 128 + (panel % 3) * 1300, top = 128 + Math.floor(panel / 3) * 2000;
  for (let y = top; y < top + 1500; y++) for (let x = left; x < left + 1100; x++) {
    const index = y * size + x;
    topology[index] = 1; coverage[index] = 1;
    rgba.set([90 + panel * 10, 80, 40, 255], index * 4);
  }
}
const run = async (kernel, geometry) => {
  const image = { width: size, height: size, data: rgba.slice() }, mask = coverage.slice();
  const startedAt = performance.now();
  const count = await kernel(image, mask, geometry, 8, true, async () => {}, true);
  return { ms: performance.now() - startedAt, image, mask, count };
};
for (let round = 0; round < 3; round++) {
  const geometry = topology.slice();
  for (const phase of ['cold', 'warm']) {
    let before, after;
    if (round % 2) { after = await run(current, geometry); before = await run(previous, geometry); }
    else { before = await run(previous, geometry); after = await run(current, geometry); }
    assert.equal(after.count, before.count);
    assert.deepEqual(after.image.data, before.image.data);
    assert.deepEqual(after.mask, before.mask);
    console.log(JSON.stringify({ resolution: size, round, phase, beforeMs: before.ms, afterMs: after.ms,
      paddedPixels: after.count, byteDifferences: 0 }));
  }
}
