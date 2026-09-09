import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } },
});

function assertValidUvMesh(mesh, sourceVertexCount) {
  assert.equal(mesh.indices.length % 3, 0);
  assert.equal(mesh.uvs.length, mesh.vertexXrefs.length * 2);
  mesh.uvs.forEach((value) => assert.ok(value >= 0 && value <= 1));
  mesh.vertexXrefs.forEach((value) => assert.ok(value < sourceVertexCount));
  for (let triangle = 0; triangle < mesh.indices.length; triangle += 3) {
    const a = mesh.indices[triangle] * 2;
    const b = mesh.indices[triangle + 1] * 2;
    const c = mesh.indices[triangle + 2] * 2;
    const area = Math.abs(
      (mesh.uvs[b] - mesh.uvs[a]) * (mesh.uvs[c + 1] - mesh.uvs[a + 1])
      - (mesh.uvs[b + 1] - mesh.uvs[a + 1]) * (mesh.uvs[c] - mesh.uvs[a]),
    );
    assert.ok(area > 1e-10, `UV triangle ${triangle / 3} is degenerate`);
  }
}

try {
  const { generateLocalUvAtlas } = await server.ssrLoadModule('/src/engine/uv/localUvAtlasCore.ts');
  const positions = new Float32Array([
    -1, -1, 0,
    1, -1, 0,
    1, 1, 0,
    -1, 1, 0,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const result = await generateLocalUvAtlas([{ positions, indices }], {
    resolution: 1024,
    padding: 8,
  });
  assert.equal(result.meshes.length, 1);
  assert.equal(result.meshes[0].indices.length, indices.length);
  assert.ok(result.chartCount >= 1);
  assert.ok(result.utilization > 0 && result.utilization <= 1);
  assert.ok(result.meshes[0].uvs.length >= positions.length / 3 * 2);
  assertValidUvMesh(result.meshes[0], positions.length / 3);

  const boxPositions = new Float32Array([
    -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
    -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
  ]);
  const boxIndices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  const tetraPositions = new Float32Array([
    2.5, 0, 0, 3.5, 0, 0, 3, 1, 0, 3, 0.5, 1,
  ]);
  const tetraIndices = new Uint32Array([
    0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3,
  ]);
  const multiMesh = await generateLocalUvAtlas([
    { positions: boxPositions, indices: boxIndices },
    { positions: tetraPositions, indices: tetraIndices },
  ], { resolution: 2048, padding: 12 });
  assert.equal(multiMesh.meshes.length, 2);
  assert.ok(Number.isInteger(multiMesh.width) && multiMesh.width > 0);
  assert.ok(Number.isInteger(multiMesh.height) && multiMesh.height > 0);
  assert.ok(multiMesh.chartCount >= 2);
  assert.ok(multiMesh.utilization > 0 && multiMesh.utilization <= 1);
  assertValidUvMesh(multiMesh.meshes[0], boxPositions.length / 3);
  assertValidUvMesh(multiMesh.meshes[1], tetraPositions.length / 3);
  console.log('Local xatlas WASM UV flat baseline and multi-mesh closed-geometry matrix passed.');
} finally {
  await server.close();
}
