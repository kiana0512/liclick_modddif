import assert from 'node:assert/strict';
import test from 'node:test';

import { repairSurfaceTexture } from '../surfaceAwareRepair.ts';
import { createVisibleSurfaceCompletionPolicy } from '../visibleSurfaceCompletionPolicy.ts';

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

test('bounded seam propagation seeds one blank neighbour without cascading across islands', () => {
  const width = 13;
  const rgba = new Uint8ClampedArray(width * 4);
  const writeMask = new Uint8Array(width);
  const topologyMask = new Uint8Array(width);
  const topologyRegionIds = new Uint32Array(width);

  for (const index of [0, 1, 2]) {
    topologyMask[index] = 1;
    topologyRegionIds[index] = 1;
  }
  for (const index of [5, 6, 7]) {
    topologyMask[index] = 1;
    topologyRegionIds[index] = 2;
  }
  for (const index of [10, 11, 12]) {
    topologyMask[index] = 1;
    topologyRegionIds[index] = 3;
  }
  setPixel(rgba, 0, [204, 92, 34]);
  for (const index of [1, 2, 5, 6, 7, 10, 11, 12]) writeMask[index] = 255;

  const result = repairSurfaceTexture({
    width,
    height: 1,
    rgba,
    writeMask,
    topologyMask,
    topologyRegionIds,
    seamLinks: new Uint32Array([2, 5, 7, 10]),
    maxSeamCrossings: 1,
    sourcePaddingPixels: 0,
    maxDistance: 32,
    minSourceAlpha: 250,
    connectivity: 4,
    outputBleedPixels: 0,
    requireCompleteComponents: true,
    lockToDominantSourceRegion: true,
    dominantSourceColorThreshold: 18,
  });

  for (const index of [1, 2, 5, 6, 7]) {
    assert.deepEqual(getRgb(result, index), [204, 92, 34]);
    assert.equal(result.repairedMask[index], 255);
  }
  for (const index of [10, 11, 12]) {
    assert.equal(result.repairedMask[index], 0, `colour crossed a second seam at ${index}`);
  }
  assert.equal(result.stats.repairedPixels, 5);
  assert.equal(result.stats.partialComponentsDiscarded, 1);
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

test('adaptive locking preserves multi-source expansion across a textured boundary', () => {
  const width = 6;
  const rgba = new Uint8ClampedArray(width * 4);
  const writeMask = new Uint8Array(width);
  const topologyMask = new Uint8Array(width).fill(1);
  const topologyRegionIds = new Uint32Array(width).fill(1);
  setPixel(rgba, 0, [230, 40, 25]);
  setPixel(rgba, 5, [30, 80, 225]);
  writeMask.fill(255, 1, 5);

  const result = repairSurfaceTexture({
    width,
    height: 1,
    rgba,
    writeMask,
    topologyMask,
    topologyRegionIds,
    sourcePaddingPixels: 0,
    maxDistance: 16,
    minSourceAlpha: 250,
    connectivity: 4,
    outputBleedPixels: 0,
    requireCompleteComponents: true,
    lockToDominantSourceRegion: true,
    dominantSourceColorThreshold: 18,
  });

  assert.deepEqual(getRgb(result, 1), [230, 40, 25]);
  assert.deepEqual(getRgb(result, 2), [230, 40, 25]);
  assert.deepEqual(getRgb(result, 3), [30, 80, 225]);
  assert.deepEqual(getRgb(result, 4), [30, 80, 225]);
  assert.equal(result.stats.sourceRegionLockedComponents, 0);
  assert.equal(result.stats.repairedPixels, 4);
});

test('adaptive locking still stabilizes a nearly uniform flat-colour gap', () => {
  const width = 6;
  const rgba = new Uint8ClampedArray(width * 4);
  const writeMask = new Uint8Array(width);
  const topologyMask = new Uint8Array(width).fill(1);
  const topologyRegionIds = new Uint32Array(width).fill(1);
  setPixel(rgba, 0, [132, 91, 48]);
  setPixel(rgba, 5, [138, 96, 52]);
  writeMask.fill(255, 1, 5);

  const result = repairSurfaceTexture({
    width,
    height: 1,
    rgba,
    writeMask,
    topologyMask,
    topologyRegionIds,
    sourcePaddingPixels: 0,
    maxDistance: 16,
    minSourceAlpha: 250,
    connectivity: 4,
    outputBleedPixels: 0,
    requireCompleteComponents: true,
    lockToDominantSourceRegion: true,
    dominantSourceColorThreshold: 18,
  });

  for (const index of [1, 2, 3, 4]) {
    assert.deepEqual(getRgb(result, index), [132, 91, 48]);
  }
  assert.equal(result.stats.sourceRegionLockedComponents, 1);
});

test('complete-component mode does not publish a coloured rim around an unresolved centre', () => {
  const width = 10;
  const rgba = new Uint8ClampedArray(width * 4);
  const writeMask = new Uint8Array(width);
  const topologyMask = new Uint8Array(width).fill(1);
  const topologyRegionIds = new Uint32Array(width).fill(1);
  setPixel(rgba, 0, [210, 80, 35]);
  setPixel(rgba, 9, [215, 84, 38]);
  writeMask.fill(255, 1, 9);

  const result = repairSurfaceTexture({
    width,
    height: 1,
    rgba,
    writeMask,
    topologyMask,
    topologyRegionIds,
    sourcePaddingPixels: 0,
    maxDistance: 2,
    minSourceAlpha: 250,
    connectivity: 4,
    outputBleedPixels: 0,
    requireCompleteComponents: true,
    lockToDominantSourceRegion: true,
    dominantSourceColorThreshold: 18,
  });

  assert.equal(result.stats.repairedPixels, 0);
  assert.equal(result.stats.partialComponentsDiscarded, 1);
  assert.equal(result.stats.partialPixelsDiscarded, 8);
  assert.deepEqual(Array.from(result.repairedMask), new Array(width).fill(0));
});

test('a second bounded pass advances from the previous repair result', () => {
  const width = 20;
  const topologyMask = new Uint8Array(width).fill(1);
  const topologyRegionIds = new Uint32Array(width).fill(1);
  const firstRgba = new Uint8ClampedArray(width * 4);
  const firstMask = new Uint8Array(width);
  for (let index = 0; index <= 4; index += 1) setPixel(firstRgba, index, [132, 91, 48]);
  firstMask.fill(255, 5);

  const options = {
    width,
    height: 1,
    topologyMask,
    topologyRegionIds,
    sourcePaddingPixels: 2,
    maxDistance: 5,
    minSourceAlpha: 64,
    connectivity: 4,
    outputBleedPixels: 0,
    requireCompleteComponents: false,
  };
  const first = repairSurfaceTexture({ ...options, rgba: firstRgba, writeMask: firstMask });
  assert.equal(first.repairedMask[7], 255);
  assert.equal(first.repairedMask[8], 0);

  const secondRgba = new Uint8ClampedArray(firstRgba);
  for (let index = 0; index < width; index += 1) {
    if (first.repairedMask[index] === 0) continue;
    secondRgba.set(first.filledRgba.subarray(index * 4, index * 4 + 4), index * 4);
  }
  const secondMask = new Uint8Array(width);
  secondMask.fill(255, 8);
  const second = repairSurfaceTexture({ ...options, rgba: secondRgba, writeMask: secondMask });

  assert.equal(second.repairedMask[10], 255, 'second pass did not advance from pass one');
  assert.equal(second.repairedMask[11], 0, 'second pass exceeded its bounded layer');
});

test('visible-surface completion fills a deep reachable gap in one linear pass', () => {
  const width = 320;
  const pixelCount = width;
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  const writeMask = new Uint8Array(pixelCount);
  const topologyMask = new Uint8Array(pixelCount).fill(1);
  const topologyRegionIds = new Uint32Array(pixelCount).fill(1);
  setPixel(rgba, 0, [146, 92, 43]);
  writeMask.fill(255, 1);

  const policy = createVisibleSurfaceCompletionPolicy(width, 1);
  const result = repairSurfaceTexture({
    width,
    height: 1,
    rgba,
    writeMask,
    topologyMask,
    topologyRegionIds,
    ...policy.propagation,
  });

  assert.equal(policy.propagation.maxDistance, pixelCount);
  assert.equal(result.stats.repairedPixels, pixelCount - 1);
  assert.equal(result.stats.unresolvedPixels, 0);
  assert.equal(result.stats.globalFallbackPixels, 0);
  assert.equal(result.repairedMask.at(-1), 255, 'the deepest hatch-visible texel stayed open');
  assert.deepEqual(getRgb(result, pixelCount - 1), [146, 92, 43]);
});

test('visible-surface completion never exposes hatch for a component with no local donor', () => {
  const width = 8;
  const rgba = new Uint8ClampedArray(width * 4);
  const writeMask = new Uint8Array(width);
  const topologyMask = new Uint8Array(width).fill(1);
  const topologyRegionIds = new Uint32Array([1, 1, 1, 1, 2, 2, 2, 2]);
  setPixel(rgba, 0, [180, 112, 52]);
  writeMask.fill(255, 1);

  const policy = createVisibleSurfaceCompletionPolicy(width, 1);
  const result = repairSurfaceTexture({
    width,
    height: 1,
    rgba,
    writeMask,
    topologyMask,
    topologyRegionIds,
    ...policy.propagation,
  });

  assert.equal(result.stats.repairedPixels, width - 1);
  assert.equal(result.stats.unresolvedPixels, 0);
  assert.equal(result.stats.globalFallbackPixels, 4);
  assert.deepEqual(result.stats.globalFallbackColor, [180, 112, 52]);
  for (let index = 4; index < width; index += 1) {
    assert.equal(result.repairedMask[index], 255);
    assert.deepEqual(getRgb(result, index), [180, 112, 52]);
  }
});

test('coverage skirt closes transparent filtering gaps without crossing UV regions', () => {
  const width = 7;
  const rgba = new Uint8ClampedArray(width * 4);
  const writeMask = new Uint8Array(width);
  const topologyMask = new Uint8Array(width).fill(1);
  const topologyRegionIds = new Uint32Array([1, 1, 1, 1, 2, 2, 2]);
  setPixel(rgba, 0, [132, 91, 48]);
  writeMask[2] = 255;

  const result = repairSurfaceTexture({
    width,
    height: 1,
    rgba,
    writeMask,
    topologyMask,
    topologyRegionIds,
    sourcePaddingPixels: 0,
    maxDistance: 16,
    minSourceAlpha: 250,
    connectivity: 4,
    coverageSkirtPixels: 1,
    coverageSkirtMaxInputAlpha: 32,
    outputBleedPixels: 0,
    requireCompleteComponents: false,
  });

  assert.equal(result.repairedMask[2], 255, 'requested gap was not repaired');
  assert.equal(result.repairedMask[1], 255, 'left transparent filtering texel stayed open');
  assert.equal(result.repairedMask[3], 255, 'right transparent filtering texel stayed open');
  assert.equal(result.repairedMask[0], 0, 'existing authored coverage was overwritten');
  assert.equal(result.repairedMask[4], 0, 'coverage skirt crossed into another UV region');
  for (const index of [1, 2, 3]) assert.deepEqual(getRgb(result, index), [132, 91, 48]);
  assert.equal(result.stats.repairedPixels, 1);
  assert.equal(result.stats.coverageSkirtPixelCount, 2);
});

test('dominant-source locking visits one connected gap only once', () => {
  const width = 64;
  const rgba = new Uint8ClampedArray(width * 4);
  const writeMask = new Uint8Array(width);
  const topologyMask = new Uint8Array(width).fill(1);
  const topologyRegionIds = new Uint32Array(width).fill(1);
  setPixel(rgba, 0, [220, 45, 30]);
  setPixel(rgba, width - 1, [35, 70, 215]);
  writeMask.fill(255, 1, width - 1);

  const lockingProgress = [];
  const result = repairSurfaceTexture(
    {
      width,
      height: 1,
      rgba,
      writeMask,
      topologyMask,
      topologyRegionIds,
      sourcePaddingPixels: 0,
      maxDistance: width,
      minSourceAlpha: 250,
      connectivity: 4,
      outputBleedPixels: 0,
      requireCompleteComponents: false,
      lockToDominantSourceRegion: true,
    },
    {
      progressStride: 1,
      onProgress(progress) {
        if (progress.phase === 'locking-source-region') lockingProgress.push(progress);
      },
    },
  );

  assert.equal(result.stats.repairedPixels, width - 2);
  assert.equal(lockingProgress.length, 2, 'one component report plus the final phase report');
  assert.equal(lockingProgress.at(-1).completed, width);
});

test('thin white projection fringe cannot become a repair donor', () => {
  const width = 9;
  const height = 7;
  const pixelCount = width * height;
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  const writeMask = new Uint8Array(pixelCount);
  const topologyMask = new Uint8Array(pixelCount).fill(1);
  const topologyRegionIds = new Uint32Array(pixelCount).fill(1);
  const brown = [132, 91, 48];

  for (let index = 0; index < pixelCount; index += 1) setPixel(rgba, index, brown);
  for (let y = 1; y <= 5; y += 1) {
    for (let x = 2; x <= 6; x += 1) {
      const isGap = x >= 3 && x <= 5 && y >= 2 && y <= 4;
      const isWhiteFringe = !isGap && (x === 2 || x === 6 || y === 1 || y === 5);
      const index = y * width + x;
      if (isGap) {
        writeMask[index] = 255;
        setPixel(rgba, index, [0, 0, 0], 0);
      } else if (isWhiteFringe) {
        setPixel(rgba, index, [255, 255, 255], 255);
      }
    }
  }

  const result = repairSurfaceTexture({
    width,
    height,
    rgba,
    writeMask,
    topologyMask,
    topologyRegionIds,
    sourcePaddingPixels: 0,
    maxDistance: 32,
    minSourceAlpha: 160,
    sourceColorOutlierThreshold: 64,
    connectivity: 4,
    outputBleedPixels: 0,
    requireCompleteComponents: false,
    lockToDominantSourceRegion: true,
  });

  for (let y = 2; y <= 4; y += 1) {
    for (let x = 3; x <= 5; x += 1) {
      const index = y * width + x;
      assert.deepEqual(getRgb(result, index), brown, `white fringe leaked into texel ${index}`);
      assert.equal(result.repairedMask[index], 255);
    }
  }
  assert.ok(result.stats.sourceColorOutliersRejected > 0);
});
