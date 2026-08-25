import assert from 'node:assert/strict';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import * as THREE from 'three';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

function createSeamedMesh(name) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        1, 0, 0,
        1, 1, 0,
        0, 1, 0,
      ],
      3,
    ),
  );
  // Both physical triangles occupy the same atlas triangle, while their
  // shared physical B-C edge uses different UV edges. They therefore belong
  // to one component but two UV regions.
  geometry.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute(
      [
        0.2, 0.2,
        0.8, 0.2,
        0.2, 0.8,
        0.2, 0.2,
        0.8, 0.2,
        0.2, 0.8,
      ],
      2,
    ),
  );
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.name = name;
  return mesh;
}

function createCrossComponentMesh() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([10, 0, 0, 11, 0, 0, 10, 1, 0], 3),
  );
  geometry.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute([0.2, 0.2, 0.8, 0.2, 0.2, 0.8], 2),
  );
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.name = 'cross-component';
  return mesh;
}

async function buildFixture(buildContentAwareSurfaceTopology, includeCrossComponent) {
  const fixtureRoot = new THREE.Group();
  fixtureRoot.add(createSeamedMesh('seamed-component'));
  if (includeCrossComponent) fixtureRoot.add(createCrossComponentMesh());
  return buildContentAwareSurfaceTopology(fixtureRoot, 32, 32, {
    includeSeamLinks: false,
    yieldIntervalMs: 2,
  });
}

try {
  const { buildContentAwareSurfaceTopology } = await server.ssrLoadModule(
    '/src/engine/contentAware/buildSurfaceTopology.ts',
  );
  const recoverable = await buildFixture(buildContentAwareSurfaceTopology, false);
  const recoverableIndices = [];
  for (let index = 0; index < recoverable.conflictMask.length; index += 1) {
    if (recoverable.conflictMask[index] === 1) recoverableIndices.push(index);
  }
  assert.ok(recoverableIndices.length > 0, 'the intra-component UV overlap must be recoverable');
  assert.equal(
    recoverable.conflictMask.includes(2),
    false,
    'one physical component must not be classified as a hard overlap',
  );
  for (const index of recoverableIndices) {
    assert.notEqual(
      recoverable.regionIds[index],
      0,
      'recoverable seam texels must retain a deterministic UV-region owner',
    );
  }

  const upgraded = await buildFixture(buildContentAwareSurfaceTopology, true);
  assert.equal(
    upgraded.conflictMask.includes(1),
    false,
    'a later unrelated component must upgrade an earlier recoverable overlap',
  );
  assert.equal(
    upgraded.conflictMask.includes(2),
    true,
    'cross-component UV overlap must be classified as a hard conflict',
  );
  stdout.write('Content-aware topology classification regression test passed.\n');
} finally {
  await server.close();
}
