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

try {
  const {
    frontProjectThumbnailCapture,
    getContainedImageDrawRect,
    getFrontProjectThumbnailCameraFrame,
    getProjectThumbnailFraming,
  } =
    await server.ssrLoadModule('/src/features/projects/projectThumbnailPolicy.ts');
  const { neutralizeUntexturedThumbnailMaterials } = await server.ssrLoadModule(
    '/src/features/projects/projectThumbnailMaterials.ts',
  );

  assert.deepEqual(frontProjectThumbnailCapture, {
    width: 2048,
    height: 2048,
    matchCameraToRenderAspect: true,
  });

  const single = getProjectThumbnailFraming([
    { min: [3, 0, -1], max: [7, 6, 1], center: [5, 3, 0], size: [4, 6, 2] },
  ]);
  assert.deepEqual(single, {
    bounds: {
      min: [3, 0, -1],
      max: [7, 6, 1],
      center: [5, 3, 0],
      size: [4, 6, 2],
    },
    leftmostModelIndex: 0,
    rightmostModelIndex: 0,
  });
  const singleCamera = getFrontProjectThumbnailCameraFrame(single.bounds);
  assert.equal(singleCamera.position[0], 5);
  assert.equal(singleCamera.position[1], 3);
  assert.deepEqual(singleCamera.target, [5, 3, 0]);
  assert(singleCamera.position[2] > singleCamera.target[2]);

  const multipleInput = [
    { min: [4, 0, -1], max: [7, 4, 1], center: [5.5, 2, 0], size: [3, 4, 2] },
    { min: [-1, -2, -2], max: [1, 9, 2], center: [0, 3.5, 0], size: [2, 11, 4] },
    { min: [-6, 0, -1], max: [-3, 5, 1], center: [-4.5, 2.5, 0], size: [3, 5, 2] },
  ];
  const multipleInputBefore = JSON.parse(JSON.stringify(multipleInput));
  const multiple = getProjectThumbnailFraming(multipleInput);
  assert.deepEqual(multiple, {
    bounds: {
      min: [-6, -2, -2],
      max: [7, 9, 2],
      center: [0.5, 3.5, 0],
      size: [13, 11, 4],
    },
    leftmostModelIndex: 2,
    rightmostModelIndex: 0,
  });
  const multipleCamera = getFrontProjectThumbnailCameraFrame(multiple.bounds);
  assert.deepEqual(multipleCamera.target, [0.5, 3.5, 0]);
  assert.equal(multipleCamera.position[0], 0.5);
  assert.equal(multipleCamera.position[1], 3.5);
  assert.equal(multipleCamera.aspect, 1);
  const multipleCameraDistance = multipleCamera.position[2] - multipleCamera.target[2];
  const expectedDistance =
    multiple.bounds.size[2] / 2 +
    Math.max(
      multiple.bounds.size[1] / 2 / Math.tan((35 * Math.PI) / 360),
      multiple.bounds.size[0] / 2 / Math.tan((35 * Math.PI) / 360),
    ) *
      1.08;
  assert(Math.abs(multipleCameraDistance - expectedDistance) < 1e-10);
  assert(multipleCamera.near < multipleCameraDistance - multiple.bounds.size[2] / 2);
  assert(multipleCamera.far > multipleCameraDistance + multiple.bounds.size[2] / 2);
  assert.deepEqual(multipleInput, multipleInputBefore, 'Framing must not mutate model bounds.');
  assert.deepEqual(
    getProjectThumbnailFraming([...multipleInput].reverse()).bounds,
    multiple.bounds,
  );
  assert.equal(getProjectThumbnailFraming([]), undefined);
  assert.equal(
    getProjectThumbnailFraming([
      {
        min: [Number.NaN, 0, 0],
        max: [1, 1, 1],
        center: [0, 0, 0],
        size: [1, 1, 1],
      },
    ]),
    undefined,
  );

  const clayMaterial = new THREE.MeshStandardMaterial({
    color: '#f0f1ee',
    emissive: '#3b0764',
    emissiveIntensity: 0.2,
  });
  const texture = new THREE.Texture();
  const texturedMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    map: texture,
    emissive: '#220000',
    emissiveIntensity: 0.4,
  });
  const clayMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), clayMaterial);
  const texturedMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), texturedMaterial);
  const materialRoot = new THREE.Group();
  materialRoot.add(clayMesh, texturedMesh);
  const restoreMaterials = neutralizeUntexturedThumbnailMaterials([materialRoot]);
  assert.equal(clayMesh.material, clayMaterial);
  assert.equal(texturedMesh.material, texturedMaterial);
  assert.equal(clayMaterial.emissive.getHex(), 0x000000);
  assert.equal(clayMaterial.emissiveIntensity, 0);
  assert.equal(texturedMaterial.emissive.getHex(), 0x220000);
  assert.equal(texturedMaterial.emissiveIntensity, 0.4);
  restoreMaterials();
  assert.equal(clayMaterial.emissive.getHex(), 0x3b0764);
  assert.equal(clayMaterial.emissiveIntensity, 0.2);
  clayMaterial.dispose();
  texturedMaterial.dispose();
  texture.dispose();
  clayMesh.geometry.dispose();
  texturedMesh.geometry.dispose();

  assert.deepEqual(getContainedImageDrawRect(2000, 1000, 2048, 2048), {
    x: 0,
    y: 512,
    width: 2048,
    height: 1024,
  });
  assert.deepEqual(getContainedImageDrawRect(1000, 2000, 2048, 2048), {
    x: 512,
    y: 0,
    width: 1024,
    height: 2048,
  });
  assert.deepEqual(getContainedImageDrawRect(0, 1000, 2048, 2048), {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });

  stdout.write('Project thumbnail policy regression test passed.\n');
} finally {
  await server.close();
}
