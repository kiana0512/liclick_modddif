import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bakeHighDisplayScale,
  bakeOverlayScale,
  canonicalizeBakeBoundingBox,
} from '../bakeModelAlignment.ts';

test('canonicalizes equivalent centimeter and meter FBX bounds to the same space', () => {
  const high = canonicalizeBakeBoundingBox(
    {
      min: [0, 0, 0],
      max: [63.7748, 94.0082, 100],
      center: [31.8874, 47.0041, 50],
      size: [63.7748, 94.0082, 100],
    },
    'fbx',
    1,
  );
  const low = canonicalizeBakeBoundingBox(
    {
      min: [0, 0, 0],
      max: [0.637748, 0.940082, 1],
      center: [0.318874, 0.470041, 0.5],
      size: [0.637748, 0.940082, 1],
    },
    'fbx',
    100,
  );

  assert.deepEqual(low, high);
});

test('canonicalizes glTF meters and FBX centimeters to the same space', () => {
  const glb = canonicalizeBakeBoundingBox(
    {
      min: [0, 0, 0],
      max: [0.637748, 0.940082, 1],
      center: [0.318874, 0.470041, 0.5],
      size: [0.637748, 0.940082, 1],
    },
    'glb',
  );
  const fbx = canonicalizeBakeBoundingBox(
    {
      min: [0, 0, 0],
      max: [63.7748, 94.0082, 100],
      center: [31.8874, 47.0041, 50],
      size: [63.7748, 94.0082, 100],
    },
    'fbx',
    1,
  );

  assert.deepEqual(glb, fbx);
});

test('displays an unnormalized glTF high mesh in centimeter bake space', () => {
  assert.deepEqual(bakeHighDisplayScale([1, 1, 1], 'glb', undefined, false), [100, 100, 100]);
  assert.deepEqual(bakeHighDisplayScale([3, 3, 3], 'glb', undefined, true), [3, 3, 3]);
});

test('maps overlay source units into the high-poly source coordinate system', () => {
  assert.deepEqual(bakeOverlayScale([0.03, 0.03, 0.03], 'fbx', 1, true, 'fbx', 100), [3, 3, 3]);
  assert.deepEqual(bakeOverlayScale([3, 3, 3], 'fbx', 100, true, 'fbx', 1), [0.03, 0.03, 0.03]);
});

test('aligns unnormalized GLB high and FBX low display scales', () => {
  assert.deepEqual(bakeOverlayScale([1, 1, 1], 'glb', undefined, false, 'fbx', 1), [1, 1, 1]);
  assert.deepEqual(bakeOverlayScale([1, 1, 1], 'fbx', 1, false, 'glb', undefined), [100, 100, 100]);
});
