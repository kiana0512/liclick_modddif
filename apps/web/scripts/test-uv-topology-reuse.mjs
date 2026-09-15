import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';
import * as snapshots from '../src/engine/bake/uvSeamGeometrySnapshot.ts';

const source = (await readFile(new URL('../src/engine/bake/webGpuUvTopologyRaster.ts', import.meta.url), 'utf8'))
  .replaceAll('import.meta.url', "'https://fixture.invalid/module.js'") + '\nexport const matches = matchesSerializedUvTriangles;';
const requests = [], api = {};
let compressedSnapshots = 0;
const snapshotApi = { ...snapshots, *snapshotUvSeamGeometry(...args) {
  const result = yield* snapshots.snapshotUvSeamGeometry(...args);
  if (result?.compressed) compressedSnapshots++;
  return result;
} };
class Worker {
  postMessage(request) {
    requests.push({ ...request, triangles: request.triangles.slice(0) });
    globalThis.queueMicrotask(() => this.onmessage({ data: { type: 'result', id: request.id,
      mask: new Uint8Array(request.width * request.height).buffer, backend: 'offscreen-canvas-worker',
      gpuAccepted: false, mismatchedPixels: 0, rawMismatchedPixels: 0, maximumDifference: 0,
      gpuMs: 0, cpuGoldMs: 0, totalMs: 0 } }));
  }
  terminate() {}
}
new Function('require', 'exports', 'Worker', 'window', ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(name => name === './uvSeamGeometrySnapshot' ? snapshotApi : { recordWebGpuProductionDispatch() {} },
  api, Worker, { setTimeout, location: { search: '' } });

const geometry = new THREE.BufferGeometry();
const uv = new Float32Array(9_000_000); // 36 MB source, above the raw snapshot limit.
uv.set([0, 0, 1, 0, 0, 1]);
geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geometry.setIndex([0, 1, 2]);
const root = new THREE.Group(), mesh = new THREE.Mesh(geometry); root.add(mesh);
const raster = () => api.rasterizeUvTopologyMaskWithWebGpu(root, 8, 8);
const first = await raster();
assert.equal(compressedSnapshots, 0, 'topology reuse must not compress an oversized source snapshot');
assert.deepEqual([...new Float32Array(requests[0].triangles)], [0, 0, 1, 0, 0, 1]);
assert.equal((await raster()).mask, first.mask);
assert.equal(requests.length, 1, 'unchanged topology does not dispatch another raster');
mesh.position.x = 5; assert.equal((await raster()).mask, first.mask);
uv[0] = 0.25; await raster(); assert.equal(requests.length, 2, 'unversioned UV edit invalidates');
geometry.index.array[0] = 1; await raster(); assert.equal(requests.length, 3, 'unversioned index edit invalidates');
assert.notEqual(requests[1].cacheKey, requests[2].cacheKey);
// Bit-exact comparison must distinguish negative zero from positive zero.
geometry.index.array[0] = 0; uv[0] = 0; await raster();
uv[0] = -0; await raster();
assert.equal(new Uint32Array(requests.at(-1).triangles)[0], 0x80000000);
const overlay = new THREE.Mesh(new THREE.PlaneGeometry()); overlay.userData.liclickPaintOverlay = true;
root.add(overlay); const beforeHelper = requests.length; await raster(); assert.equal(requests.length, beforeHelper);
root.remove(mesh); await assert.rejects(raster(), /no UV triangles/);
root.add(mesh); await raster();
assert.deepEqual([...new Uint32Array(requests.at(-1).triangles)], [...new Uint32Array(new Float32Array([-0, 0, 1, 0, 0, 1]).buffer)]);
api.terminateWebGpuUvTopologyRasterWorker();

// Compare unusual attribute layouts against the actual Float32 raster input.
const nan = new Float32Array(new Uint32Array([0x7f800001, 0, 0x3f800000, 0, 0, 0x3f800000]).buffer);
const interleaved = new THREE.InterleavedBuffer(new Float32Array([9, 0, 0, 9, 1, 0, 9, 0, 1]), 3);
for (const attribute of [
  new THREE.BufferAttribute(nan, 2),
  new THREE.BufferAttribute(new Float64Array([0.123456789, 0, 1, 0, 0, 1]), 2),
  new THREE.BufferAttribute(new Uint16Array([0, 0, 65535, 0, 0, 65535]), 2, true),
  new THREE.Float16BufferAttribute([0, 0, 15360, 0, 0, 15360], 2),
  new THREE.InterleavedBufferAttribute(interleaved, 2, 1),
]) {
  const fixture = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('uv', attribute));
  const expected = new Float32Array(6);
  for (let vertex = 0; vertex < 3; vertex++) {
    expected[vertex * 2] = attribute.getX(vertex); expected[vertex * 2 + 1] = attribute.getY(vertex);
  }
  assert(await api.matches(fixture, expected), 'attribute conversion matches serialization');
  attribute.setY(0, 0.5);
  assert.equal(await api.matches(fixture, expected), false, 'converted attribute edits invalidate');
  assert.equal(await api.matches(fixture, expected.subarray(0, 4)), false, 'triangle count changes invalidate');
}
console.log('UV topology reuse: oversized snapshots, mask reuse, UV/index edits, signed zero, helpers/removal, NaN, Float64, normalized, half-float and interleaved attributes passed.');
