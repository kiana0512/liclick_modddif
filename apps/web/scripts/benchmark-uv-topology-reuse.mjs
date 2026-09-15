import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { OBJLoader } from 'three-stdlib';
import ts from 'typescript';
import * as snapshots from '../src/engine/bake/uvSeamGeometrySnapshot.ts';

assert(process.argv[2], 'Pass the existing OBJ path (read-only).');
const root = new OBJLoader().parse(await readFile(process.argv[2], 'utf8'));
const require = createRequire(import.meta.url);
const { MeshBVH } = createRequire(require.resolve('@react-three/drei'))('three-mesh-bvh');
root.traverse(mesh => { if (mesh.isMesh) new MeshBVH(mesh.geometry, { maxLeafTris: 12, verbose: false }); });
const load = source => {
  const api = {};
  new Function('require', 'exports', 'window', ts.transpileModule(
    source.replaceAll('import.meta.url', "'https://fixture.invalid/module.js'") + '\nexport const prepare = serializeUvTriangles;', {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText)(name => name === './uvSeamGeometrySnapshot' ? snapshots : { recordWebGpuProductionDispatch() {} },
    api, { setTimeout });
  return api;
};
// This file was unchanged since 6dcdec1 before this patch. Both sides use the
// current shared snapshot module, including the existing large-seam work.
const before = load(execFileSync('git', ['show', '6dcdec1:apps/web/src/engine/bake/webGpuUvTopologyRaster.ts'], { encoding: 'utf8' }));
const after = load(await readFile(new URL('../src/engine/bake/webGpuUvTopologyRaster.ts', import.meta.url), 'utf8'));
const run = async api => { const start = performance.now(); const data = await api.prepare(root); return { data, ms: performance.now() - start }; };
let last;
for (let round = 0; round < 4; round++) {
  let a, b;
  if (round % 2) { b = await run(after); a = await run(before); }
  else { a = await run(before); b = await run(after); }
  assert.deepEqual(new Uint8Array(b.data.buffer), new Uint8Array(a.data.buffer));
  if (last) assert.equal(b.data, last, 'warm preparation reuses the exact retained triangle buffer');
  last = b.data;
  console.log(JSON.stringify({ round, phase: round ? 'warm' : 'cold', beforeMs: a.ms, afterMs: b.ms,
    triangleBytes: b.data.byteLength, byteDifferences: 0 }));
}
