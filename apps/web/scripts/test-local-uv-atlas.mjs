/* global console */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

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
  result.meshes[0].uvs.forEach((value) => assert.ok(value >= 0 && value <= 1));
  result.meshes[0].vertexXrefs.forEach((value) => assert.ok(value < positions.length / 3));
  console.log('Local xatlas WASM UV generation test passed.');
} finally {
  await server.close();
}
