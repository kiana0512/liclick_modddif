import assert from 'node:assert/strict';
import test from 'node:test';

import { repairSurfaceTexture } from '../surfaceAwareRepair.ts';

function setPixel(rgba, index, color, alpha = 255) {
  rgba.set([...color, alpha], index * 4);
}

function getRgb(result, index) {
  return Array.from(result.filledRgba.subarray(index * 4, index * 4 + 3));
}

function createPhysicalSeamFixture(includeSeamLink) {
  const width = 17;
  const height = 1;
  const pixelCount = width * height;
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  const writeMask = new Uint8Array(pixelCount);
  const topologyMask = new Uint8Array(pixelCount);
  const topologyRegionIds = new Uint32Array(pixelCount);

  // Region 1 and 2 are different UV islands connected by one physical seam.
  // Region 3 is intentionally unrelated and must retain its own donor colour.
  for (let index = 0; index <= 4; index += 1) {
    topologyMask[index] = 1;
    topologyRegionIds[index] = 1;
  }
  for (let index = 7; index <= 10; index += 1) {
    topologyMask[index] = 1;
    topologyRegionIds[index] = 2;
  }
  for (let index = 13; index <= 16; index += 1) {
    topologyMask[index] = 1;
    topologyRegionIds[index] = 3;
  }

  setPixel(rgba, 0, [210, 30, 20]);
  setPixel(rgba, 10, [20, 60, 220]);
  setPixel(rgba, 13, [30, 190, 70]);
  for (const index of [1, 2, 3, 4, 7, 8, 9, 14, 15, 16]) writeMask[index] = 255;

  return {
    width,
    height,
    rgba,
    writeMask,
    topologyMask,
    topologyRegionIds,
    ...(includeSeamLink ? { seamLinks: new Uint32Array([4, 7]) } : {}),
    sourcePaddingPixels: 0,
    maxDistance: 32,
    minSourceAlpha: 250,
    connectivity: 4,
    outputBleedPixels: 0,
    requireCompleteComponents: false,
    lockToDominantSourceRegion: true,
  };
}

test('a physical seam-connected gap locks every UV region to one donor', () => {
  const result = repairSurfaceTexture(createPhysicalSeamFixture(true));

  for (const index of [1, 2, 3, 4, 7, 8, 9]) {
    assert.deepEqual(getRgb(result, index), [210, 30, 20], `mixed donor at texel ${index}`);
    assert.equal(result.repairedMask[index], 255);
  }
  for (const index of [14, 15, 16]) {
    assert.deepEqual(getRgb(result, index), [30, 190, 70], `unrelated island changed at ${index}`);
    assert.equal(result.repairedMask[index], 255);
  }
  assert.equal(result.stats.sourceRegionLockedComponents, 1);
  assert.equal(result.stats.sourceRegionReassignedPixels, 3);
});

test('UV islands without a physical seam link keep independent donors', () => {
  const result = repairSurfaceTexture(createPhysicalSeamFixture(false));

  for (const index of [1, 2, 3, 4]) {
    assert.deepEqual(getRgb(result, index), [210, 30, 20]);
  }
  for (const index of [7, 8, 9]) {
    assert.deepEqual(getRgb(result, index), [20, 60, 220]);
  }
  for (const index of [14, 15, 16]) {
    assert.deepEqual(getRgb(result, index), [30, 190, 70]);
  }
  assert.equal(result.stats.sourceRegionLockedComponents, 0);
  assert.equal(result.stats.sourceRegionReassignedPixels, 0);
});

test('competing source pixels inside one donor region cannot split a gap into two colours', () => {
  const width = 6;
  const rgba = new Uint8ClampedArray(width * 4);
  const writeMask = new Uint8Array(width);
  const topologyMask = new Uint8Array(width).fill(1);
  const topologyRegionIds = new Uint32Array(width).fill(1);
  setPixel(rgba, 0, [230, 40, 25], 255);
  setPixel(rgba, 5, [30, 80, 225], 240);
  for (const index of [1, 2, 3, 4]) writeMask[index] = 255;

  const result = repairSurfaceTexture({
    width,
    height: 1,
    rgba,
    writeMask,
    topologyMask,
    topologyRegionIds,
    sourcePaddingPixels: 0,
    maxDistance: 16,
    minSourceAlpha: 200,
    connectivity: 4,
    outputBleedPixels: 0,
    requireCompleteComponents: false,
    lockToDominantSourceRegion: true,
  });

  // Both source pixels own two gap texels after the first propagation pass.
  // The alpha tie-break selects source 0 and the complete component must clone
  // that one exact RGB value, with no nearest-owner split or interpolation.
  for (const index of [1, 2, 3, 4]) {
    assert.deepEqual(getRgb(result, index), [230, 40, 25]);
    assert.equal(result.repairedMask[index], 255);
  }
  assert.equal(result.stats.sourceRegionLockedComponents, 1);
  assert.equal(result.stats.sourceRegionReassignedPixels, 2);
});
