import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import ts from 'typescript';
import * as snapshots from '../src/engine/bake/uvSeamGeometrySnapshot.ts';

const drain = steps => { let step; do { step = steps.next(); } while (!step.done); return step.value; };
// A large backing buffer with a small referenced mesh keeps the cache contract
// test fast. Direct edits anywhere in the source must still invalidate it.
const geometry = new THREE.BoxGeometry();
const original = geometry.attributes.position;
const positions = new Float32Array(9_000_000);
positions.set(original.array);
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
const root = new THREE.Mesh(geometry);
const snapshot = drain(snapshots.snapshotUvSeamGeometry(root));
assert(snapshot, 'compressible geometry above 32 MiB must retain an exact bounded snapshot');
assert(drain(snapshots.matchesUvSeamGeometry(root, snapshot)));
const storedBytes = snapshot.compressed.reduce((sum, buffer) =>
  sum + buffer.chunks.reduce((bytes, chunk) => bytes + chunk.byteLength, 0), 0);
assert(storedBytes <= 32 * 1024 * 1024);
for (const offset of [0, 65535, 65536, positions.byteLength - 1]) {
  const bytes = new Uint8Array(positions.buffer);
  bytes[offset] ^= 1;
  assert(!drain(snapshots.matchesUvSeamGeometry(root, snapshot)), `unversioned byte edit ${offset}`);
  bytes[offset] ^= 1;
}
root.position.x = 0.5;
assert(!drain(snapshots.matchesUvSeamGeometry(root, snapshot)));
root.position.x = 0;
assert(drain(snapshots.matchesUvSeamGeometry(root, snapshot)));

const api = {};
const code = await readFile(new URL('../src/engine/bake/uvSeamReconciliation.ts', import.meta.url), 'utf8');
new Function('require', 'exports', ts.transpileModule(code, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText)(name => {
  if (name === 'three') return THREE;
  if (name === './uvSeamGeometrySnapshot') return snapshots;
  throw Error(name);
}, api);
const oracle = {};
const frozen = (await readFile(new URL('./fixtures/uv-seam-b3431cb.ts', import.meta.url), 'utf8'))
  .replace('uv.x * (width - 1)', 'uv.x * width').replace('(1 - uv.y) * (height - 1)', '(1 - uv.y) * height')
  .replace('Math.round(point.x)', 'Math.floor(point.x)').replace('Math.round(point.y)', 'Math.floor(point.y)');
new Function('require', 'exports', ts.transpileModule(frozen, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText)(() => THREE, oracle);
const dataset = {};
globalThis.document = { body: { dataset } };
for (let pass = 0; pass < 3; pass++) {
  const image = { width: 64, height: 64,
    data: Uint8ClampedArray.from({ length: 64 * 64 * 4 }, (_, i) => (i * 17 + pass * 11) % 256) };
  const coverage = Uint8Array.from({ length: 64 * 64 }, (_, i) => Number((i + pass) % 3 === 0));
  const expected = { ...image, data: image.data.slice() }, mask = coverage.slice();
  const options = { repairMissingCoverage: true, bandPixels: 3 };
  const gold = oracle.reconcileUvSeams(expected, root, mask, options);
  const actual = await api.reconcileUvSeamsCooperatively(async () => {}, image, root, coverage, options);
  assert.deepEqual(actual, gold);
  assert.deepEqual(image.data, expected.data);
  assert.deepEqual(coverage, mask);
  assert.equal(dataset.residentUvSeamPlanCached, 'true');
  if (pass) assert.equal(dataset.residentUvSeamPlanHit, '1', 'large unchanged mesh reuses donor plan');
}
delete globalThis.document;
// Integer encoding is also exact, including direct index edits.
const indexed = new THREE.BufferGeometry();
indexed.setIndex(new THREE.BufferAttribute(Uint32Array.from({ length: 9_000_003 }, (_, i) => i), 1));
const indexRoot = new THREE.Mesh(indexed);
const indexSnapshot = drain(snapshots.snapshotUvSeamGeometry(indexRoot));
assert(indexSnapshot);
assert(drain(snapshots.matchesUvSeamGeometry(indexRoot, indexSnapshot)));
for (const index of [0, 16383, 16384, 9_000_002]) {
  indexed.index.array[index] ^= 0x80000000;
  assert(!drain(snapshots.matchesUvSeamGeometry(indexRoot, indexSnapshot)));
  indexed.index.array[index] ^= 0x80000000;
}
// Incompressible geometry must fall back rather than exceed the old budget.
const noise = new Uint32Array(9_000_000);
let seed = 91237;
for (let i = 0; i < noise.length; i++) {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; noise[i] = seed;
}
const noisy = new THREE.BufferGeometry();
noisy.setAttribute('position', new THREE.BufferAttribute(new Float32Array(noise.buffer), 3));
assert.equal(drain(snapshots.snapshotUvSeamGeometry(new THREE.Mesh(noisy))), undefined);
// Cancellation is checked by the real cooperative consumer while encoding.
const cancelRoot = new THREE.Mesh(geometry.clone());
await assert.rejects(api.reconcileUvSeamsCooperatively(async () => { throw Error('cancelled'); },
  { width: 8, height: 8, data: new Uint8ClampedArray(256) }, cancelRoot, new Uint8Array(64),
  { repairMissingCoverage: true }), /cancelled/);
console.log('Large seam cache: exact bytes, direct edits, transform invalidation and cold/warm frozen pixel oracle passed.');
