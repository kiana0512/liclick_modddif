import assert from 'node:assert/strict';
import { padUvIslandGuttersWithTopologyCooperatively as pad } from '../src/engine/bake/dilation.ts';
import { padUvIslandGuttersWithTopology as reference } from './fixtures/uv-gutter-b3431cb.ts';

// More candidates than the old 262144-seed cap. Count actual topology reads,
// not wall time, to prove unchanged geometry avoids repeated neighbour scans.
const size = 768, mask = new Uint8Array(size * size);
let reads = 0;
const topology = new Proxy(mask, { get(target, key) {
  if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
  return Reflect.get(target, key, target);
} });
const run = async (fill, topologyMask) => {
  const image = { width: size, height: size, data: new Uint8ClampedArray(size * size * 4).fill(91) };
  const coverage = new Uint8Array(size * size).fill(fill);
  const count = await pad(image, coverage, topologyMask, 1, 'rgb-only', async () => {}, true);
  return { image, coverage, count };
};
await run(1, topology);
reads = 0;
const actual = await run(1, topology);
assert.equal(reads, 0, 'warm immutable atlas must reuse eligibility even above old seed cap');
const expected = { width: size, height: size, data: new Uint8ClampedArray(size * size * 4).fill(91) };
const coverage = new Uint8Array(size * size).fill(1);
assert.equal(actual.count, reference(expected, coverage, mask, 1, 'rgb-only'));
assert.deepEqual(actual.image.data, expected.data);
assert.deepEqual(actual.coverage, coverage);
// A different geometry object must never reuse the old plan.
mask.fill(1);
const replaced = await run(1, mask);
assert.equal(replaced.count, 0);
for (const offset of [0, 1, 2, 3]) {
  const width = 13, height = 7, geometry = new Uint8Array(width * height);
  geometry.fill(1, 18, 50);
  for (let pass = 0; pass < 2; pass++) {
    const mask = new Uint8Array(new ArrayBuffer(width * height + offset), offset);
    for (let i = pass; i < mask.length; i += 3) mask[i] = 2;
    const image = { width, height, data: Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => i % 253) };
    const gold = { ...image, data: image.data.slice() }, goldMask = mask.slice();
    const count = reference(gold, goldMask, geometry, 3, 'rgb-only');
    assert.equal(await pad(image, mask, geometry, 3, 'rgb-only', async () => {}, true), count);
    assert.deepEqual(image.data, gold.data);
    assert.deepEqual(mask, goldMask);
  }
}
console.log('UV gutter reuse: dense immutable atlas, changed coverage and geometry identity passed.');
