import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as THREE from 'three';
import { OBJLoader } from 'three-stdlib';
import ts from 'typescript';
import * as snapshots from '../src/engine/bake/uvSeamGeometrySnapshot.ts';

const modelPath = process.argv[2];
assert(modelPath, 'Pass an existing OBJ path; the source asset is read-only.');
const root = new OBJLoader().parse(await readFile(modelPath, 'utf8'));
const require = createRequire(import.meta.url);
const { MeshBVH } = createRequire(require.resolve('@react-three/drei'))('three-mesh-bvh');
root.traverse(mesh => {
  if (!mesh.isMesh) return;
  // Match the viewport's indexed BVH preparation, including index reordering.
  new MeshBVH(mesh.geometry, { maxLeafTris: 12, verbose: false });
});
const load = (code, snapshotApi) => {
  const exports = {};
  new Function('require', 'exports', ts.transpileModule(code, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText)(name => {
    if (name === 'three') return THREE;
    if (name === './uvSeamGeometrySnapshot') return snapshotApi;
    throw Error(name);
  }, exports);
  return exports;
};
const previousFile = name => execFileSync('git', ['show', `6dcdec1:apps/web/src/engine/bake/${name}.ts`], { encoding: 'utf8' });
const previousSnapshot = load(previousFile('uvSeamGeometrySnapshot'));
const previous = load(previousFile('uvSeamReconciliation'), previousSnapshot);
const next = load(await readFile(new URL('../src/engine/bake/uvSeamReconciliation.ts', import.meta.url), 'utf8'), snapshots);
const dataset = {};
globalThis.document = { body: { dataset } };
const run = async (api, variant) => {
  const width = 2048, image = { width, height: width,
    data: Uint8ClampedArray.from({ length: width * width * 4 }, (_, i) => (i * 11 + variant * 17) % 256) };
  const coverage = Uint8Array.from({ length: width * width }, (_, i) => Number((i + variant) % 3 === 0));
  const start = performance.now();
  const result = await api.reconcileUvSeamsCooperatively(async () => {}, image, root, coverage,
    { repairMissingCoverage: true, bandPixels: 2 });
  return { image, coverage, result, ms: performance.now() - start, diagnostics: { ...dataset } };
};
for (let round = 0; round < 3; round++) {
  const before = await run(previous, round), after = await run(next, round);
  assert.deepEqual(after.result, before.result);
  assert.deepEqual(after.image.data, before.image.data);
  assert.deepEqual(after.coverage, before.coverage);
  console.log(JSON.stringify({ round, phase: round ? 'warm' : 'cold', beforeMs: before.ms, afterMs: after.ms,
    ...after.result, ...after.diagnostics, byteDifferences: 0 }));
}
delete globalThis.document;
