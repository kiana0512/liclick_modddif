import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContentAwareRepairMask } from '../buildRepairMask.ts';

function createFixture(width, height) {
  const pixelCount = width * height;
  const rgba = new Uint8Array(pixelCount * 4);
  for (let index = 0; index < pixelCount; index += 1) {
    rgba[index * 4 + 3] = 255;
  }
  return {
    width,
    height,
    rgba,
    topologyMask: new Uint8Array(pixelCount).fill(1),
    coreMask: new Uint8Array(pixelCount).fill(1),
    regionIds: new Uint32Array(pixelCount).fill(1),
    conflictMask: new Uint8Array(pixelCount),
  };
}

function indexAt(fixture, x, y) {
  return y * fixture.width + x;
}

function setAlpha(fixture, x, y, alpha) {
  fixture.rgba[indexAt(fixture, x, y) * 4 + 3] = alpha;
}

function assertSelected(result, fixture, coordinates, expected = 255) {
  for (const [x, y] of coordinates) {
    assert.equal(result.mask[indexAt(fixture, x, y)], expected, `unexpected mask at ${x},${y}`);
  }
}

test('rejects tiny components while retaining area and long narrow seams', async () => {
  const fixture = createFixture(16, 12);
  const singleton = [[1, 1]];
  const tinyBlock = [
    [4, 1],
    [5, 1],
    [4, 2],
    [5, 2],
  ];
  const areaComponent = [
    [9, 1],
    [10, 1],
    [11, 1],
    [9, 2],
    [10, 2],
    [11, 2],
    [9, 3],
    [10, 3],
    [11, 3],
  ];
  const longSeam = Array.from({ length: 6 }, (_, offset) => [2 + offset, 8]);
  for (const [x, y] of [...singleton, ...tinyBlock, ...areaComponent, ...longSeam]) {
    setAlpha(fixture, x, y, 0);
  }

  const result = await buildContentAwareRepairMask({
    ...fixture,
    weakGrowPixels: 0,
    minimumComponentPixels: 8,
    minimumComponentSpan: 6,
  });

  assertSelected(result, fixture, [...singleton, ...tinyBlock], 0);
  assertSelected(result, fixture, [...areaComponent, ...longSeam]);
  assert.deepEqual(result.stats, {
    hardPixels: 15,
    weakPixels: 0,
    totalPixels: 15,
    conflictRejectedPixels: 0,
    conservativeHaloRejectedPixels: 0,
    noiseRejectedPixels: 5,
    noiseRejectedComponents: 2,
  });
});

test('uses 4-neighbor connectivity and never joins components across regions', async () => {
  const fixture = createFixture(8, 6);
  const diagonal = [
    [1, 1],
    [2, 2],
  ];
  const adjacentDifferentRegions = [
    [5, 1],
    [6, 1],
  ];
  for (const [x, y] of [...diagonal, ...adjacentDifferentRegions]) {
    setAlpha(fixture, x, y, 0);
  }
  fixture.regionIds[indexAt(fixture, 6, 1)] = 2;

  const result = await buildContentAwareRepairMask({
    ...fixture,
    weakGrowPixels: 0,
    minimumComponentPixels: 2,
    minimumComponentSpan: 0,
  });

  assertSelected(result, fixture, [...diagonal, ...adjacentDifferentRegions], 0);
  assert.equal(result.stats.hardPixels, 0);
  assert.equal(result.stats.noiseRejectedPixels, 4);
  assert.equal(result.stats.noiseRejectedComponents, 4);
});

test('filters hard noise before weak growth so rejected specks cannot seed halos', async () => {
  const fixture = createFixture(10, 6);
  const rejectedHard = [1, 1];
  const rejectedWeakNeighbor = [2, 1];
  const retainedHard = [
    [6, 2],
    [7, 2],
  ];
  const retainedWeakNeighbor = [8, 2];
  setAlpha(fixture, ...rejectedHard, 0);
  setAlpha(fixture, ...rejectedWeakNeighbor, 16);
  for (const [x, y] of retainedHard) setAlpha(fixture, x, y, 0);
  setAlpha(fixture, ...retainedWeakNeighbor, 16);

  const result = await buildContentAwareRepairMask({
    ...fixture,
    weakGrowPixels: 1,
    minimumComponentPixels: 2,
    minimumComponentSpan: 0,
  });

  assertSelected(result, fixture, [rejectedHard, rejectedWeakNeighbor], 0);
  assertSelected(result, fixture, [...retainedHard, retainedWeakNeighbor]);
  assert.equal(result.stats.hardPixels, 2);
  assert.equal(result.stats.weakPixels, 1);
  assert.equal(result.stats.noiseRejectedPixels, 1);
  assert.equal(result.stats.noiseRejectedComponents, 1);
});

test('defaults reject an isolated texel and an already-aborted signal stays abortable', async () => {
  const fixture = createFixture(8, 8);
  setAlpha(fixture, 3, 3, 0);
  const result = await buildContentAwareRepairMask({ ...fixture, weakGrowPixels: 0 });
  assert.equal(result.mask[indexAt(fixture, 3, 3)], 0);
  assert.equal(result.stats.noiseRejectedPixels, 1);
  assert.equal(result.stats.noiseRejectedComponents, 1);

  const controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(
    buildContentAwareRepairMask({ ...fixture, signal: controller.signal }),
    (error) => error instanceof Error && error.name === 'AbortError',
  );
});

test('retains a large low-confidence projection region when the scan threshold is raised', async () => {
  const fixture = createFixture(14, 10);
  const lowConfidenceRegion = [];
  for (let y = 2; y <= 7; y += 1) {
    for (let x = 3; x <= 10; x += 1) {
      setAlpha(fixture, x, y, 24);
      lowConfidenceRegion.push([x, y]);
    }
  }

  const strictResult = await buildContentAwareRepairMask({
    ...fixture,
    hardAlphaThreshold: 8,
    weakGrowPixels: 0,
    minimumComponentPixels: 8,
    minimumComponentSpan: 0,
  });
  assert.equal(strictResult.stats.totalPixels, 0);

  const confidenceAwareResult = await buildContentAwareRepairMask({
    ...fixture,
    hardAlphaThreshold: 32,
    weakAlphaThreshold: 64,
    weakGrowPixels: 1,
    minimumComponentPixels: 8,
    minimumComponentSpan: 0,
  });
  assertSelected(confidenceAwareResult, fixture, lowConfidenceRegion);
  assert.equal(confidenceAwareResult.stats.hardPixels, lowConfidenceRegion.length);
  assert.equal(confidenceAwareResult.stats.totalPixels, lowConfidenceRegion.length);
});
