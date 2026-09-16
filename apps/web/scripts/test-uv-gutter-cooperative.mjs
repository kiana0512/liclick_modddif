import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setInterval, clearInterval, setImmediate } from 'node:timers';
import * as THREE from 'three';
import * as pixelRaster from '../src/engine/bake/uvPixelCenterRaster.ts';
import * as oldDilation from './fixtures/uv-gutter-b3431cb.ts';
import * as nextDilation from '../src/engine/bake/dilation.ts';
import * as oldSeams from './fixtures/uv-seam-b3431cb.ts';
import ts from 'typescript';
import * as seamSnapshot from '../src/engine/bake/uvSeamGeometrySnapshot.ts';
import { padUvIslandGuttersWithTopology as reference } from './fixtures/uv-gutter-b3431cb.ts';
import {
  padUvIslandGuttersWithTopology as synchronous,
  padUvIslandGuttersWithTopologyCooperatively as cooperative,
} from '../src/engine/bake/dilation.ts';

const nextSeams = {};
// Keep the frozen donor/iteration oracle. The v9 contract intentionally changes
// only atlas coordinates to WebGL's pixel extent and containing-texel indexing.
const alignedSeams = {};
const alignedReference = (await readFile(new URL('./fixtures/uv-seam-b3431cb.ts', import.meta.url), 'utf8'))
  .replace('uv.x * (width - 1)', 'uv.x * width')
  .replace('(1 - uv.y) * (height - 1)', '(1 - uv.y) * height')
  .replace('Math.round(point.x)', 'Math.floor(point.x)')
  .replace('Math.round(point.y)', 'Math.floor(point.y)');
new Function('require', 'exports', ts.transpileModule(alignedReference, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(name => { if(name==='three')return THREE;throw Error(name); }, alignedSeams);
const seamCode = ts.transpileModule(await readFile(
  new URL('../src/engine/bake/uvSeamReconciliation.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
// Exercise the cooperative collector's compact keys directly as well as its
// resulting repaired pixels. Its public synchronous counterpart stays an oracle.
new Function('require', 'exports', seamCode + `
exports.createPositionIds = createSeamPositionIds;
exports.positionKey = positionKey;
exports.collectOptimized = (root, include) => {
  const steps = collectUvSeamPairSteps(root, include, true);
  let step; do { step = steps.next(); } while (!step.done); return step.value;
};`)(name => {
  if (name === 'three') return THREE;
  if (name === './uvSeamGeometrySnapshot') return seamSnapshot;
  throw new Error(`Unexpected dependency: ${name}`);
}, nextSeams);

let seed = 72913;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
// Deliberately collide the int32 hash while keeping distinct full coordinates.
// IDs must match the original string equivalence and first-appearance order.
const positionIds = nextSeams.createPositionIds(), expectedPositionIds = new Map();
const coordinates = [0, -0, 0.0000049, 0.0000051, 1, -1,
  2 ** 32 / 100000, -(2 ** 32) / 100000, Infinity, -Infinity, NaN];
const checkPosition = (position) => {
  const key = nextSeams.positionKey(position);
  if (!expectedPositionIds.has(key)) expectedPositionIds.set(key, expectedPositionIds.size);
  assert.equal(positionIds(position), expectedPositionIds.get(key));
};
for (const x of coordinates) for (const y of coordinates) for (const z of coordinates) {
  checkPosition(new THREE.Vector3(x, y, z));
  checkPosition(new THREE.Vector3(x, y, z));
}
for (let index = 0; index < 1000; index++) {
  const position = new THREE.Vector3(random() * 1e9, random() * 1e9, random() * 1e9);
  checkPosition(position); checkPosition(position.clone());
}
seed = 72913;
if (process.env.LI3D_UV_REPAIR_BENCHMARK === '1') {
  const size=4096, rgba=new Uint8ClampedArray(size*size*4);
  const topology=new Uint8Array(size*size), coverage=new Uint8Array(size*size), regions=new Uint32Array(size*size);
  for(let panel=0;panel<6;panel++) {
    const left=128+(panel%3)*1300,top=128+Math.floor(panel/3)*2000;
    for(let y=top;y<top+1500;y++) for(let x=left;x<left+700;x++) {
      const index=y*size+x;topology[index]=1;regions[index]=panel+1;
      if(x%80===0) continue;
      coverage[index]=1;rgba.set([100+panel*10,80,50,255],index*4);
    }
  }
  const run=kernel=>{
    const image={width:size,height:size,data:rgba.slice()}, mask=coverage.slice();
    const start=performance.now(),count=kernel(image,mask,topology,3,regions);
    return {image,mask,count,ms:performance.now()-start};
  };
  const before=run(oldDilation.fillEnclosedUvCoverageGaps),after=run(nextDilation.fillEnclosedUvCoverageGaps);
  assert.equal(after.count,before.count);assert.deepEqual(after.image.data,before.image.data);assert.deepEqual(after.mask,before.mask);
  console.log(JSON.stringify({phase:'4K interior crack repair',beforeMs:before.ms,afterMs:after.ms,filled:after.count,byteDifferences:0}));
}
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
  const indexed = (...args) => cooperative(...args, true);
  for (const kernel of [synchronous, cooperative, indexed, indexed]) {
    const image = { width, height, data: data.slice() };
    const mask = coverage.slice();
    const count = await kernel(image, mask, topology, iterations, mode, async () => {});
    assert.equal(count, expectedCount, `count trial ${trial}`);
    assert.deepEqual(image.data, expectedImage.data, `RGBA trial ${trial}`);
    assert.deepEqual(mask, expectedCoverage, `coverage trial ${trial}`);
    assert.deepEqual(topology, originalTopology, 'topology remains read-only');
  }
  // Cached topology membership must still evaluate new colors/coverage.
  for (const changed of [false, true]) {
    const fresh = Uint8ClampedArray.from(data, value => 255 - value);
    const mask = coverage.slice();
    if (changed) mask[trial % mask.length] = (mask[trial % mask.length] + 1) % 3;
    const expected = { width, height, data: fresh.slice() }, expectedMask = mask.slice();
    const actual = { width, height, data: fresh };
    const count = reference(expected, expectedMask, topology, iterations, mode);
    assert.equal(await indexed(actual, mask, topology, iterations, mode, async () => {}), count);
    assert.deepEqual(actual.data, expected.data, 'cached topology must not reuse previous RGBA');
    assert.deepEqual(mask, expectedMask, 'even one changed coverage byte must be evaluated');
  }
  const nextMask = Uint8Array.from(coverage, value => value ? 0 : 1);
  const nextGold = { width, height, data: data.slice() }, nextActual = { width, height, data: data.slice() };
  const goldMask = nextMask.slice();
  const goldCount = reference(nextGold, goldMask, topology, iterations, mode);
  const nextCount = await indexed(nextActual, nextMask, topology, iterations, mode, async () => {});
  assert.equal(nextCount, goldCount, 'cached frontier must re-evaluate dynamic coverage');
  assert.deepEqual(nextActual.data, nextGold.data);
  assert.deepEqual(nextMask, goldMask);
}

// Empty atlas regions used to exceed the 262144-index cap. Continuous spans
// retain their exact row-major membership without omitting raster fringe texels.
const indexedDilation = {};
new Function('require', 'exports', ts.transpileModule(await readFile(
  new URL('../src/engine/bake/dilation.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText + '\nexports.boundary = () => gutterBoundary;')(
  name => {
    if (name === 'three') return THREE;
    if (name === './uvPixelCenterRaster.ts') return pixelRaster;
    throw Error(name);
  }, indexedDilation);
for (const fragmented of [false, true]) {
  const size = 1024, topology = new Uint8Array(size * size).fill(1);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (fragmented ? x % 4 === 1 && y % 4 === 1 : x < 128 || x > 800 || y < 100 || y > 900) {
      topology[y * size + x] = 0;
    }
  }
  for (const mode of [false, true, 'rgb-only']) for (let repeat = 0; repeat < 2; repeat++) {
    const rgba = Uint8ClampedArray.from({ length: size * size * 4 }, () => random() * 256);
    // Deliberately include dynamically covered pixels OUTSIDE topology.
    const coverage = Uint8Array.from(topology, () => random() < 0.02 ? 1 : 0);
    const gold = { width: size, height: size, data: rgba.slice() }, goldMask = coverage.slice();
    const actual = { width: size, height: size, data: rgba }, actualMask = coverage.slice();
    const count = reference(gold, goldMask, topology, 2, mode);
    assert.equal(await indexedDilation.padUvIslandGuttersWithTopologyCooperatively(
      actual, actualMask, topology, 2, mode, async () => {}, true), count);
    assert.deepEqual(actual.data, gold.data);
    assert.deepEqual(actualMask, goldMask);
    const spans = indexedDilation.boundary().spans;
    if (fragmented) assert.equal(spans, undefined, 'fragmented atlas retains bounded fallback');
    else assert(spans && spans.length < 10000, 'large empty atlas fits the 1 MiB span budget');
  }
}
console.log('Gutter spans: large empty atlas, outside-topology coverage, all alpha modes, cold/warm and fragmented fallback are byte-exact.');

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
  const result = alignedSeams.reconcileUvSeams(expected, root, expectedMask, options);
  assert.deepEqual(nextSeams.collectUvSeamPairs(root, options.repairMissingCoverage),
    oldSeams.collectUvSeamPairs(root, options.repairMissingCoverage));
  assert.deepEqual(nextSeams.collectOptimized(root, options.repairMissingCoverage),
    oldSeams.collectUvSeamPairs(root, options.repairMissingCoverage));
  for (const flag of ['liclickPaintOverlay', 'liclickWireframeOverlay', 'liclickLocalRepaintGpuOverlay']) {
    const helper = mesh.clone();
    helper.userData[flag] = true;
    helper.position.x = 0.2;
    root.add(helper);
  }
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
    assert.deepEqual(nextSeams.collectOptimized(root, include), oldSeams.collectUvSeamPairs(root, include));
  }
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) { object.geometry.dispose(); object.material.dispose(); }
  });
}
console.log('UV seam repeated/non-manifold edge order parity passed.');

// Declared vertex counts beyond exact integer pairing must take the string
// fallback. The small index buffer keeps this malformed-count fixture bounded.
{
  const mesh = new THREE.Mesh(new THREE.BoxGeometry());
  mesh.geometry.attributes.position.count = 100_000_000;
  assert.deepEqual(nextSeams.collectOptimized(mesh, true), oldSeams.collectUvSeamPairs(mesh, true));
  mesh.geometry.dispose(); mesh.material.dispose();
}

// Reuse must follow exact geometry, including direct edits without needsUpdate.
const mutableRoot = new THREE.Group();
const mutableMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
mutableRoot.add(mutableMesh);
const drain = generator => { let step; do { step = generator.next(); } while (!step.done); return step.value; };
const sharedRoot = new THREE.Group();
const sharedGeometry = new THREE.BoxGeometry();
sharedRoot.add(new THREE.Mesh(sharedGeometry), new THREE.Mesh(sharedGeometry));
const sharedSnapshot = drain(seamSnapshot.snapshotUvSeamGeometry(sharedRoot));
assert.equal(sharedSnapshot.buffers.length, 4, 'Display meshes sharing geometry retain each byte span once');
assert(drain(seamSnapshot.matchesUvSeamGeometry(sharedRoot, sharedSnapshot)));
sharedGeometry.attributes.uv.setX(0, 0.123);
assert(!drain(seamSnapshot.matchesUvSeamGeometry(sharedRoot, sharedSnapshot)), 'Shared UV direct edits still invalidate');
sharedGeometry.dispose();
const changes = [
  () => mutableMesh.geometry.attributes.uv.setX(0, 0.37),
  () => mutableMesh.geometry.attributes.position.setY(0, 0.13),
  () => mutableMesh.geometry.attributes.normal.setZ(0, -0.77),
  () => mutableMesh.geometry.index.setX(0, 2),
  () => { mutableRoot.rotation.x += 0.33; },
  () => { mutableMesh.scale.z = 2.1; },
  () => { mutableMesh.geometry.attributes.uv.normalized = true; },
  () => { mutableRoot.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1))); },
  () => { mutableRoot.remove(mutableRoot.children[1]); },
];
for (const change of changes) {
  const before = drain(seamSnapshot.snapshotUvSeamGeometry(mutableRoot));
  assert(before);
  assert(drain(seamSnapshot.matchesUvSeamGeometry(mutableRoot, before)));
  const run = () => {
    const bytes = Uint8ClampedArray.from({ length: 64 * 64 * 4 }, () => random() * 256);
    const mask = Uint8Array.from({ length: 64 * 64 }, () => random() < 0.3 ? 0 : 1);
    const expected = { width: 64, height: 64, data: bytes.slice() }, expectedMask = mask.slice();
    const actual = { width: 64, height: 64, data: bytes }, options = { repairMissingCoverage: true };
    const count = alignedSeams.reconcileUvSeams(expected, mutableRoot, expectedMask, options);
    assert.deepEqual(nextSeams.reconcileUvSeams(actual, mutableRoot, mask, options), count);
    assert.deepEqual(actual.data, expected.data);
    assert.deepEqual(mask, expectedMask);
  };
  run(); run();
  change();
  assert(!drain(seamSnapshot.matchesUvSeamGeometry(mutableRoot, before)));
  run(); run();
}
console.log('Exact seam reuse: geometry bytes, normals, indices, UV, hierarchy and transforms invalidate; cold/warm output matches frozen kernel.');

if (process.env.LICLICK_BENCH_UV_POSTPROCESS === '1') {
  const width = 4096, height = 4096, pixels = width * height;
  const data = new Uint8ClampedArray(pixels * 4);
  const topology = new Uint8Array(pixels), coverage = new Uint8Array(pixels);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    if (x % 128 < 64 && y % 128 < 64) {
      topology[index] = coverage[index] = 1;
      data[index * 4] = x % 255; data[index * 4 + 1] = y % 255;
      data[index * 4 + 2] = (x + y) % 255; data[index * 4 + 3] = 127;
    }
  }
  const durations = { old: [], next: [] };
  for (let round = 0; round < 3; round++) {
    const results = {};
    for (const name of round % 2 ? ['next', 'old'] : ['old', 'next']) {
      const image = { width, height, data: data.slice() }, mask = coverage.slice();
      const start = performance.now();
      const count = (name === 'old' ? reference : synchronous)(image, mask, topology, 16, true);
      durations[name].push(performance.now() - start);
      results[name] = { image, mask, count };
    }
    assert.deepEqual(results.next, results.old);
  }
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 256));
  const seamTimes = [];
  for (let run = 0; run < 3; run++) {
    const image = { width: 128, height: 128, data: new Uint8ClampedArray(128 * 128 * 4) };
    const start = performance.now();
    nextSeams.reconcileUvSeams(image, mesh, new Uint8Array(128 * 128), { repairMissingCoverage: true });
    seamTimes.push(performance.now() - start);
  }
  console.log(JSON.stringify({ full4kGutterMs: durations, geometrySeamColdWarmMs: seamTimes, byteDifferences: 0 }));
}
