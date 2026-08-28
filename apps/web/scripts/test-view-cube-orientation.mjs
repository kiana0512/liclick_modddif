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

function assertVectorClose(actual, expected, message) {
  assert(
    actual.distanceTo(expected) < 1e-6,
    `${message}: received ${actual.toArray().join(', ')}`,
  );
}

try {
  const {
    getViewCubeRotation,
    modelViewDirectionToWorld,
    worldViewDirectionToModelLocal,
  } = await server.ssrLoadModule('/src/engine/viewport/viewCubeOrientation.ts');

  const identity = new THREE.Quaternion();
  assertVectorClose(
    worldViewDirectionToModelLocal(new THREE.Vector3(1, 0, 0), identity),
    new THREE.Vector3(1, 0, 0),
    'Identity model orientation must preserve the camera direction',
  );

  assert.deepEqual(getViewCubeRotation(new THREE.Vector3(0, 0, 1)), {
    pitch: -0,
    yaw: -0,
  });
  assert.equal(
    getViewCubeRotation(new THREE.Vector3(1, 0, 0)).yaw,
    -90,
    'A camera on the user-right side must rotate the Right cube face toward the user',
  );
  assert.equal(
    getViewCubeRotation(new THREE.Vector3(-1, 0, 0)).yaw,
    90,
    'A camera on the user-left side must rotate the Left cube face toward the user',
  );

  const modelRotation = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI / 2,
  );
  const rotatedFront = modelViewDirectionToWorld(
    new THREE.Vector3(0, 0, 1),
    modelRotation,
  );
  assertVectorClose(
    worldViewDirectionToModelLocal(rotatedFront, modelRotation),
    new THREE.Vector3(0, 0, 1),
    'The cube must stay aligned with a rotated model',
  );

  const rightFaceNormal = new THREE.Vector3(1, 0, 0).applyAxisAngle(
    new THREE.Vector3(0, 1, 0),
    THREE.MathUtils.degToRad(getViewCubeRotation(new THREE.Vector3(1, 0, 0)).yaw),
  );
  assertVectorClose(
    rightFaceNormal,
    new THREE.Vector3(0, 0, 1),
    'The Right label must be the visible face from the user-right view',
  );

  stdout.write('ViewCube model-orientation and user-left/right regression test passed.\n');
} finally {
  await server.close();
}
