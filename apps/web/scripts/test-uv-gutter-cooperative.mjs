import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setInterval, clearInterval, setImmediate } from 'node:timers';
import * as THREE from 'three';
import * as oldDilation from './fixtures/uv-gutter-b3431cb.ts';
import * as nextDilation from '../src/engine/bake/dilation.ts';
import * as oldSeams from './fixtures/uv-seam-b3431cb.ts';
import * as nextSeams from '../src/engine/bake/uvSeamReconciliation.ts';
import { padUvIslandGuttersWithTopology as reference } from './fixtures/uv-gutter-b3431cb.ts';
import {
  padUvIslandGuttersWithTopology as synchronous,
  padUvIslandGuttersWithTopologyCooperatively as cooperative,
} from '../src/engine/bake/dilation.ts';

let seed = 72913;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
for (let trial = 0; trial < 600; trial++) {
  const width = 1 + Math.floor(random() * 43);
  const height = trial % 7 === 0 ? 1 : 1 + Math.floor(random() * 37);
  const data = Uint8ClampedArray.from({ length: width * height * 4 }, () => random() * 256);
  const coverage = Uint8Array.from({ length: width * height }, () => random() < 0.5 ? 0 : 1 + Math.floor(random() * 2));
  const topology = Uint8Array.from({ length: width * height }, () => random() < 0.25 ? 0 : 255);
  const originalTopology = topology.slice();
  const iterations = [-1, 0, 1, 2, 2.5, 4, 8][trial % 7];
  const mode = [false, true, 'rgb-only'][trial % 3];
  const expectedImage = { width, height, data: data.slice() };
  const expectedCoverage = coverage.slice();
  const expectedCount = reference(expectedImage, expectedCoverage, topology, iterations, mode);
  for (const kernel of [synchronous, cooperative]) {
    const image = { width, height, data: data.slice() };
    const mask = coverage.slice();
    const count = await kernel(image, mask, topology, iterations, mode, async () => {});
    assert.equal(count, expectedCount, `count trial ${trial}`);
    assert.deepEqual(image.data, expectedImage.data, `RGBA trial ${trial}`);
    assert.deepEqual(mask, expectedCoverage, `coverage trial ${trial}`);
    assert.deepEqual(topology, originalTopology, 'topology remains read-only');
  }
}

const width = 2048;
const image = { width, height: width, data: new Uint8ClampedArray(width * width * 4) };
const topology = new Uint8Array(width * width).fill(1);
const coverage = topology.slice();
let ticks = 0;
const timer = setInterval(() => ticks++, 0);
try {
  await cooperative(image, coverage, topology, 8, true, () => new Promise(setImmediate));
  assert(ticks > 0, 'event loop must run during full-size scanning');
} finally {
  clearInterval(timer);
}
await assert.rejects(cooperative(image, coverage, topology, 8, true, async () => {
  throw new Error('scheduler failed');
}), /scheduler failed/);
await assert.rejects(cooperative(image, coverage, new Uint8Array(1), 8, true, async () => {}), /dimensions/);

const caller = await readFile(new URL('../src/engine/bake/bakeProjectedLayerToTexture.ts', import.meta.url), 'utf8');
assert.equal((caller.match(/await padUvIslandGuttersWithTopologyCooperatively\(/g) ?? []).length, 3);
assert.equal((caller.match(/await padUvIslandGuttersCooperatively\(/g) ?? []).length, 3);
assert(!/\bpadUvIslandGutters(?:WithTopology)?\(/.test(caller.replace(/\/\/[^\n]*/g, '')),
  'all production GPU parity, direct GPU and CPU fallback consumers must await padding');
console.log('UV gutter: 600 frozen-oracle RGBA/coverage/count cases, scheduling, errors and all bake consumers passed.');

for (let trial = 0; trial < 250; trial++) {
  const width = 1 + Math.floor(random() * 40), height = 1 + Math.floor(random() * 40);
  const data = Uint8ClampedArray.from({ length: width * height * 4 }, () => random() * 256);
  const coverage = Uint8Array.from({ length: width * height }, () => random() < 0.4 ? 0 : 1);
  const topology = Uint8Array.from({ length: width * height }, () => random() < 0.1 ? 0 : 1);
  const regions = trial % 2 ? undefined : Uint32Array.from(topology, (_, i) => 1 + i % 3);
  for (const [name, rest] of [
    ['dilateImageData', [trial % 5, trial % 2 ? topology : undefined, trial % 3 === 0]],
    ['fillEnclosedUvCoverageGaps', [topology, trial % 5, regions]],
  ]) {
    const expected = { width, height, data: data.slice() }, expectedMask = coverage.slice();
    const count = oldDilation[name](expected, expectedMask, ...rest);
    for (const cooperative of [false, true]) {
      const actual = { width, height, data: data.slice() }, mask = coverage.slice();
      const args = [actual, mask, ...rest];
      const actualCount = cooperative
        ? await nextDilation[name + 'Cooperatively'](async () => {}, ...args)
        : nextDilation[name](...args);
      assert.equal(actualCount, count, `${name} count ${trial}`);
      assert.deepEqual(actual.data, expected.data, `${name} RGBA ${trial}`);
      assert.deepEqual(mask, expectedMask, `${name} coverage ${trial}`);
    }
  }
}

for (let trial = 0; trial < 40; trial++) {
  const root = new THREE.Group();
  let geometry = trial % 2 ? new THREE.SphereGeometry(1, 12, 8) : new THREE.BoxGeometry(1, 1, 1, 3, 3, 3);
  if (trial % 4 === 0) {
    const indexed = geometry;
    geometry = geometry.toNonIndexed();
    indexed.dispose();
  }
  if (trial % 3 === 0) geometry.deleteAttribute('normal');
  const mesh = new THREE.Mesh(geometry);
  mesh.rotation.set(0.25, trial / 7, -0.4);
  mesh.scale.set(1, 2, 0.7);
  root.add(mesh);
  const data = Uint8ClampedArray.from({ length: 64 * 64 * 4 }, () => random() * 256);
  const coverage = Uint8Array.from({ length: 64 * 64 }, () => random() < 0.3 ? 0 : 1);
  const options = { repairMissingCoverage: trial % 2 === 0, bandPixels: trial % 8 };
  const expected = { width: 64, height: 64, data: data.slice() }, expectedMask = coverage.slice();
  const result = oldSeams.reconcileUvSeams(expected, root, expectedMask, options);
  assert.deepEqual(nextSeams.collectUvSeamPairs(root, options.repairMissingCoverage),
    oldSeams.collectUvSeamPairs(root, options.repairMissingCoverage));
  for (const cooperative of [false, true]) {
    const actual = { width: 64, height: 64, data: data.slice() }, mask = coverage.slice();
    const args = [actual, root, mask, options];
    const actualResult = cooperative
      ? await nextSeams.reconcileUvSeamsCooperatively(async () => {}, ...args)
      : nextSeams.reconcileUvSeams(...args);
    assert.deepEqual(actualResult, result);
    assert.deepEqual(actual.data, expected.data, `seam RGBA ${trial}`);
    assert.deepEqual(mask, expectedMask, `seam coverage ${trial}`);
  }
  geometry.dispose();
  mesh.material.dispose();
}
console.log('UV repair/seams: 500 repair and 40 transformed-mesh frozen-oracle cases passed.');

for (const name of ['dilateImageData', 'fillEnclosedUvCoverageGaps']) {
  let deliveries = 0;
  const args = name === 'dilateImageData' ? [1, topology, true] : [topology, 1];
  await nextDilation[name + 'Cooperatively'](
    () => new Promise((resolve) => setImmediate(() => { deliveries++; resolve(); })),
    image, coverage.slice(), ...args,
  );
  assert(deliveries > 0, `${name} yields control during a 2K scan`);
}
const largeRoot = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 128));
let seamDeliveries = 0;
await nextSeams.reconcileUvSeamsCooperatively(
  () => new Promise((resolve) => setImmediate(() => { seamDeliveries++; resolve(); })),
  { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) },
  largeRoot, new Uint8Array(64 * 64),
);
assert(seamDeliveries > 0, 'seam geometry traversal yields control');
largeRoot.geometry.dispose();
largeRoot.material.dispose();
console.log('UV repair/seam event-loop delivery checks passed.');

// Repeated and non-manifold edges must retain first UV-key order / last record.
for (const count of [4, 5, 6, 50]) {
  const root = new THREE.Group();
  for (let index = 0; index < count; index++) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const uv = geometry.getAttribute('uv');
    for (let vertex = 0; vertex < uv.count; vertex++) {
      uv.setXY(vertex, uv.getX(vertex) * 0.5 + (index % 17) / 34, uv.getY(vertex) * 0.5);
    }
    root.add(new THREE.Mesh(geometry));
  }
  for (const include of [false, true]) {
    assert.deepEqual(nextSeams.collectUvSeamPairs(root, include), oldSeams.collectUvSeamPairs(root, include));
  }
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) { object.geometry.dispose(); object.material.dispose(); }
  });
}
console.log('UV seam repeated/non-manifold edge order parity passed.');
