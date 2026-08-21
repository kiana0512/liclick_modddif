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
  const { bakePbrMapsLocally } = await server.ssrLoadModule(
    '/src/engine/bake/localPbrBakeCore.ts',
  );
  const positions = new Float32Array([
    -1, -1, 0,
    1, -1, 0,
    1, 1, 0,
    -1, 1, 0,
  ]);
  const normals = new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const result = bakePbrMapsLocally({
    high: { positions, normals, indices },
    low: [{ positions: positions.slice(), normals: normals.slice(), indices: indices.slice(), uvs }],
    resolution: 32,
    padding: 2,
    frontalDistance: 0.1,
    rearDistance: 0.1,
    normalOrientation: 'directx',
    aoSamples: 4,
    channels: ['normal', 'ambientOcclusion', 'worldNormal', 'position'],
  });
  assert.equal(result.triangleCount, 2);
  assert.ok(result.coveredPixels > 800);
  assert.equal(result.missedPixels, 0);
  const center = (16 * 32 + 16) * 4;
  const normal = result.outputs.normal;
  const ao = result.outputs.ambientOcclusion;
  assert.ok(normal);
  assert.ok(ao);
  assert.ok(Math.abs(normal[center] - 128) <= 1);
  assert.ok(Math.abs(normal[center + 1] - 128) <= 1);
  assert.equal(normal[center + 2], 255);
  assert.equal(normal[center + 3], 255);
  assert.equal(ao[center], 255);
  assert.equal(ao[center + 3], 255);
  console.log('Local BVH PBR bake normal/AO test passed.');
} finally {
  await server.close();
}
