import assert from 'node:assert/strict';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

const planarBounds = {
  min: [-1, -1, 0],
  max: [1, 1, 0],
  center: [0, 0, 0],
  size: [2, 2, 0],
};

try {
  const { bakeSourceUnitScaleFactor, canonicalizeBakeBoundingBox } =
    await server.ssrLoadModule('/src/features/bake/bakeModelAlignment.ts');

  assert.equal(bakeSourceUnitScaleFactor('obj'), 1);
  assert.equal(bakeSourceUnitScaleFactor('glb'), 100);
  assert.equal(
    bakeSourceUnitScaleFactor('glb', 1),
    1,
    'A GLB derived from an OBJ must retain the OBJ physical unit scale.',
  );
  assert.deepEqual(
    canonicalizeBakeBoundingBox(planarBounds, 'glb', 1),
    planarBounds,
    'An Auto UV GLB with inherited unit metadata must align with its planar OBJ source.',
  );
  assert.deepEqual(canonicalizeBakeBoundingBox(planarBounds, 'glb').size, [200, 200, 0]);

  stdout.write('Bake model unit alignment regression test passed.\n');
} finally {
  await server.close();
}
