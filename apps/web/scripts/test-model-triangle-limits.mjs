import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, logLevel: 'silent', server: { middlewareMode: true } });

try {
  const THREE = await server.ssrLoadModule('three');
  const {
    assertModelTriangleLimit,
    AUTO_UV_MODEL_TRIANGLE_LIMIT,
    countModelTriangles,
    modelTriangleLimitMessage,
    TEXTURE_MODEL_TRIANGLE_LIMIT,
  } = await server.ssrLoadModule('/src/engine/loaders/modelTriangleLimit.ts');

  assert.equal(TEXTURE_MODEL_TRIANGLE_LIMIT, 2_000_000);
  assert.equal(AUTO_UV_MODEL_TRIANGLE_LIMIT, 70_000);
  assert.equal(
    modelTriangleLimitMessage(AUTO_UV_MODEL_TRIANGLE_LIMIT, 70_001),
    '不支持 7 万面以上的模型。当前模型约 70,001 面。',
  );
  assert.equal(
    modelTriangleLimitMessage(TEXTURE_MODEL_TRIANGLE_LIMIT, 2_000_001),
    '不支持 200 万面以上的模型。当前模型约 2,000,001 面。',
  );

  const rootObject = new THREE.Group();
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12 * 3), 3));
  indexed.setIndex([0, 1, 2, 2, 3, 0]);
  rootObject.add(new THREE.Mesh(indexed));
  const nonIndexed = new THREE.BufferGeometry();
  nonIndexed.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9 * 3), 3));
  rootObject.add(new THREE.Mesh(nonIndexed));

  assert.equal(countModelTriangles(rootObject), 5);
  assert.equal(assertModelTriangleLimit(rootObject, 5), 5);
  assert.throws(
    () => assertModelTriangleLimit(rootObject, 4),
    /不支持 4 面以上的模型。当前模型约 5 面。/,
  );
  console.log('Model triangle limit tests passed.');
} finally {
  await server.close();
}
