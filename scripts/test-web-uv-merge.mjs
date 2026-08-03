import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compositeRgbaUnderInPlace,
  getMergeUvPostprocessOptions,
  getRgbaAlphaCoverageRatio,
  isContentAwareUvUnderlay,
  isFlattenableUvMergeSource,
} from '../apps/web/src/engine/layers/mergeUvComposition.ts';

test('content-aware repair is a flattenable UV underlay', () => {
  const layer = {
    id: 'content-aware-uv-repair-1',
    type: 'uv',
    role: 'content-aware-underlay',
    generationId: 'texture-map-content-aware-repair',
    imageUrl: 'repair.png',
  };
  assert.equal(isContentAwareUvUnderlay(layer), true);
  assert.equal(isFlattenableUvMergeSource(layer), true);
  assert.equal(
    isFlattenableUvMergeSource({
      ...layer,
      id: 'merged-uv-1',
      role: 'merged-uv',
      generationId: undefined,
    }),
    false,
  );
});

test('repair fills only transparent projection pixels', () => {
  const front = new Uint8ClampedArray([
    20, 40, 220, 255,
    0, 0, 0, 0,
    10, 20, 30, 128,
  ]);
  const repair = new Uint8ClampedArray([
    220, 30, 20, 255,
    220, 30, 20, 255,
    210, 30, 10, 255,
  ]);
  compositeRgbaUnderInPlace(front, repair);
  assert.deepEqual([...front.slice(0, 4)], [20, 40, 220, 255]);
  assert.deepEqual([...front.slice(4, 8)], [220, 30, 20, 255]);
  assert.deepEqual([...front.slice(8, 12)], [110, 25, 20, 255]);
});

test('transparent RGB padding survives flattening', () => {
  const front = new Uint8ClampedArray([9, 8, 7, 0]);
  const repair = new Uint8ClampedArray([200, 100, 50, 0]);
  compositeRgbaUnderInPlace(front, repair);
  assert.deepEqual([...front], [9, 8, 7, 0]);
});

test('coverage counts alpha pixels without scanning RGB channels', () => {
  assert.equal(
    getRgbaAlphaCoverageRatio(new Uint8ClampedArray([10, 20, 30, 255, 2, 3, 4, 0])),
    0.5,
  );
});

test('merge postprocess stays bounded and never enables broad dilation', () => {
  assert.deepEqual(getMergeUvPostprocessOptions(4096), {
    uvIslandGutterPixels: 8,
    uvCoverageGapPixels: 0,
    uvInteriorHolePixels: 2,
    uvSeamRepairPixels: 4,
  });
});
