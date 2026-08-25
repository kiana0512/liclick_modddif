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

function makeLoadedModel(id, width, x = 0) {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(width, 2, 1)));
  group.position.set(x, 1, 0);
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const boundingBox = {
    min: box.min.toArray(),
    max: box.max.toArray(),
    center: center.toArray(),
    size: size.toArray(),
  };
  const transform = {
    position: group.position.toArray(),
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
  const importNormalizationTransform = {
    position: transform.position,
    scale: transform.scale,
    targetMaxDimension: 3,
    grounded: true,
    normalized: true,
  };
  return {
    root: group,
    sourceUrl: `blob:${id}`,
    result: {
      objectId: id,
      name: id,
      format: 'glb',
      group,
      sourceFileName: `${id}.glb`,
      materialSlots: [],
      uvSets: [],
      boundingBox,
      originalBoundingBox: boundingBox,
      importNormalizationTransform,
      childMeshCount: 1,
      warnings: [],
    },
    object: {
      id,
      name: id,
      type: 'mesh',
      format: 'glb',
      materialSlots: [],
      uvSets: [],
      boundingBox,
      importNormalizationTransform,
      userTransform: transform,
      transform,
      visible: true,
      selected: true,
    },
  };
}

try {
  const { placeImportedModelBesideScene } = await server.ssrLoadModule(
    '/src/engine/scene/placeImportedModelBesideScene.ts',
  );
  const { getWorkspaceCameraTransition, isStrictModelAppend } = await server.ssrLoadModule(
    '/src/engine/viewport/cameraFramingPolicy.ts',
  );

  const first = makeLoadedModel('first', 2, -1.5);
  const firstPositionBefore = first.result.group.position.clone();
  const second = placeImportedModelBesideScene(makeLoadedModel('second', 3), [first.result]);
  const firstBox = new THREE.Box3().setFromObject(first.result.group);
  const secondBox = new THREE.Box3().setFromObject(second.result.group);
  const expectedGap = Math.max(0.45, Math.min(1.2, Math.max(2, 3) * 0.18));

  assert(first.result.group.position.equals(firstPositionBefore), 'Existing model must not move.');
  assert(Math.abs(secondBox.min.x - firstBox.max.x - expectedGap) < 1e-6);
  assert.deepEqual(second.object.transform.position, second.result.group.position.toArray());
  assert.deepEqual(second.object.userTransform, second.object.transform);
  assert.deepEqual(
    second.object.importNormalizationTransform.position,
    second.object.transform.position,
  );

  const third = placeImportedModelBesideScene(makeLoadedModel('third', 1), [
    first.result,
    second.result,
  ]);
  const thirdBox = new THREE.Box3().setFromObject(third.result.group);
  assert(thirdBox.min.x > secondBox.max.x, 'Each subsequent import must remain separated.');

  assert.equal(getWorkspaceCameraTransition('scene', 'texture', true), 'focus-selected');
  assert.equal(getWorkspaceCameraTransition('texture', 'scene', true), 'preserve');
  assert.equal(getWorkspaceCameraTransition('scene', 'scene', true), 'none');
  assert.equal(getWorkspaceCameraTransition('scene', 'texture', false), 'none');
  assert.equal(isStrictModelAppend(new Set(['a']), new Set(['a', 'b'])), true);
  assert.equal(isStrictModelAppend(new Set(), new Set(['a'])), false);
  assert.equal(isStrictModelAppend(new Set(['a', 'b']), new Set(['a'])), false);

  stdout.write('Model placement and camera-focus regression test passed.\n');
} finally {
  await server.close();
}
