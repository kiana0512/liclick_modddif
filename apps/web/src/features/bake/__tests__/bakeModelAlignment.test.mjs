import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bakeOverlayScale,
  canonicalizeFbxBoundingBox,
} from '../bakeModelAlignment.ts';

test('canonicalizes equivalent centimeter and meter FBX bounds to the same space', () => {
  const high = canonicalizeFbxBoundingBox(
    {
      min: [0, 0, 0],
      max: [63.7748, 94.0082, 100],
      center: [31.8874, 47.0041, 50],
      size: [63.7748, 94.0082, 100],
    },
    1,
  );
  const low = canonicalizeFbxBoundingBox(
    {
      min: [0, 0, 0],
      max: [0.637748, 0.940082, 1],
      center: [0.318874, 0.470041, 0.5],
      size: [0.637748, 0.940082, 1],
    },
    100,
  );

  assert.deepEqual(low, high);
});

test('maps overlay source units into the high-poly source coordinate system', () => {
  assert.deepEqual(bakeOverlayScale([0.03, 0.03, 0.03], 1, 100), [3, 3, 3]);
  assert.deepEqual(bakeOverlayScale([3, 3, 3], 100, 1), [0.03, 0.03, 0.03]);
});
