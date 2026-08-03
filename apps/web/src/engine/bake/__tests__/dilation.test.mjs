import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dilateImageData,
  fillEnclosedUvCoverageGaps,
  padUvIslandGuttersWithTopology,
} from '../dilation.ts';
import { getMergeUvPostprocessOptions } from '../../layers/mergeUvComposition.ts';

function createImageData(width, height) {
  return {
    width,
    height,
    colorSpace: 'srgb',
    data: new Uint8ClampedArray(width * height * 4),
  };
}

function setPixel(imageData, index, rgba) {
  imageData.data.set(rgba, index * 4);
}

function getPixel(imageData, index) {
  return Array.from(imageData.data.subarray(index * 4, index * 4 + 4));
}

test('UV interior repair fills a component fully enclosed inside one island', () => {
  const width = 9;
  const height = 5;
  const imageData = createImageData(width, height);
  const coverage = new Uint8Array(width * height);
  const topology = new Uint8Array(width * height);
  const holeRow = 2;

  for (let y = 1; y <= 3; y += 1) {
    for (let x = 1; x <= 7; x += 1) {
      const index = y * width + x;
      topology[index] = 1;
      coverage[index] = 1;
      setPixel(imageData, index, [24, 96, 180, 210]);
    }
  }
  for (const x of [2, 3, 4]) {
    const index = holeRow * width + x;
    coverage[index] = 0;
    setPixel(imageData, index, [0, 0, 0, 0]);
  }

  const filled = fillEnclosedUvCoverageGaps(imageData, coverage, topology, 2);

  assert.equal(filled, 3);
  for (const x of [2, 3, 4]) {
    const index = holeRow * width + x;
    assert.equal(coverage[index], 1);
    assert.deepEqual(getPixel(imageData, index), [24, 96, 180, 210]);
  }
});

test('safe UV-gap repair cannot cross a UV-island boundary', () => {
  const width = 7;
  const height = 3;
  const imageData = createImageData(width, height);
  const coverage = new Uint8Array(width * height);
  const topology = new Uint8Array(width * height);
  const row = 1;

  for (const x of [1, 2, 4, 5]) topology[row * width + x] = 1;
  for (const x of [1, 5]) {
    const index = row * width + x;
    coverage[index] = 1;
    setPixel(imageData, index, [200, 80, 32, 255]);
  }

  const filled = fillEnclosedUvCoverageGaps(imageData, coverage, topology, 4);

  assert.equal(filled, 0);
  assert.equal(coverage[row * width + 2], 0);
  assert.equal(coverage[row * width + 4], 0);
});

test('UV interior repair fills a wide enclosed hole but leaves open island blanks untouched', () => {
  const width = 13;
  const height = 5;
  const imageData = createImageData(width, height);
  const coverage = new Uint8Array(width * height);
  const topology = new Uint8Array(width * height);

  for (let y = 1; y <= 3; y += 1) {
    for (let x = 1; x <= 11; x += 1) {
      const index = y * width + x;
      topology[index] = 1;
      coverage[index] = 1;
      setPixel(imageData, index, [90, 120, 150, 255]);
    }
  }
  for (let x = 2; x <= 10; x += 1) {
    const index = 2 * width + x;
    coverage[index] = 0;
    setPixel(imageData, index, [0, 0, 0, 0]);
  }

  const filled = fillEnclosedUvCoverageGaps(imageData, coverage, topology, 100);
  assert.equal(filled, 9, 'a genuinely enclosed UV hole must be filled completely');

  const openImage = createImageData(width, height);
  const openCoverage = new Uint8Array(width * height);
  const openTopology = topology.slice();
  for (let y = 1; y <= 3; y += 1) {
    const index = y * width + 1;
    openCoverage[index] = 1;
    setPixel(openImage, index, [90, 120, 150, 255]);
  }
  const openFilled = fillEnclosedUvCoverageGaps(openImage, openCoverage, openTopology, 1);
  assert.equal(openFilled, 0, 'blank coverage reaching the UV boundary must remain transparent');
});

test('weak transparent coverage is reclassified before enclosed-hole repair', () => {
  const width = 5;
  const height = 5;
  const imageData = createImageData(width, height);
  const coverage = new Uint8Array(width * height);
  const topology = new Uint8Array(width * height);

  for (let y = 1; y <= 3; y += 1) {
    for (let x = 1; x <= 3; x += 1) {
      const index = y * width + x;
      topology[index] = 1;
      coverage[index] = 1;
      setPixel(imageData, index, [52, 112, 204, 255]);
    }
  }
  const weakCenter = 2 * width + 2;
  setPixel(imageData, weakCenter, [52, 112, 204, 8]);

  const filled = fillEnclosedUvCoverageGaps(imageData, coverage, topology, 1);

  assert.equal(filled, 1);
  assert.equal(coverage[weakCenter], 1);
  assert.deepEqual(getPixel(imageData, weakCenter), [52, 112, 204, 255]);
});

test('one-pixel crack connected to an island edge closes only between opposite donors', () => {
  const width = 9;
  const height = 7;
  const imageData = createImageData(width, height);
  const coverage = new Uint8Array(width * height);
  const topology = new Uint8Array(width * height);

  for (let y = 1; y <= 5; y += 1) {
    for (let x = 1; x <= 7; x += 1) {
      const index = y * width + x;
      topology[index] = 1;
      coverage[index] = 1;
      setPixel(imageData, index, [40, 104, 190, 255]);
    }
  }
  for (let y = 1; y <= 4; y += 1) {
    const index = y * width + 4;
    coverage[index] = 0;
    setPixel(imageData, index, [0, 0, 0, 0]);
  }

  const filled = fillEnclosedUvCoverageGaps(imageData, coverage, topology, 1);

  assert.equal(filled, 4);
  for (let y = 1; y <= 4; y += 1) {
    const index = y * width + 4;
    assert.equal(coverage[index], 1);
    assert.deepEqual(getPixel(imageData, index), [40, 104, 190, 255]);
  }
});

test('filter-only coverage cannot seed an interior UV repair', () => {
  const width = 5;
  const height = 3;
  const imageData = createImageData(width, height);
  const coverage = new Uint8Array(width * height);
  const topology = new Uint8Array(width * height);
  const row = 1;

  for (let x = 1; x <= 3; x += 1) topology[row * width + x] = 1;
  for (const x of [1, 3]) {
    const index = row * width + x;
    coverage[index] = 2;
    setPixel(imageData, index, [80, 120, 180, 0]);
  }

  const filled = fillEnclosedUvCoverageGaps(imageData, coverage, topology, 1);

  assert.equal(filled, 0);
  assert.equal(coverage[row * width + 2], 0);
});

test('isolated conservative-topology pinhole closes without growing through an island gap', () => {
  const width = 9;
  const height = 7;
  const imageData = createImageData(width, height);
  const coverage = new Uint8Array(width * height);
  const topology = new Uint8Array(width * height);
  const center = 3 * width + 3;
  const neighbors = [center - 1, center + 1, center - width, center + width];

  for (const index of neighbors) {
    topology[index] = 1;
    coverage[index] = 1;
    setPixel(imageData, index, [48, 106, 196, 255]);
  }
  const islandGap = 3 * width + 7;
  for (const index of [islandGap - 1, islandGap + 1]) {
    topology[index] = 1;
    coverage[index] = 1;
    setPixel(imageData, index, [48, 106, 196, 255]);
  }

  const filled = fillEnclosedUvCoverageGaps(imageData, coverage, topology, 1);

  assert.equal(filled, 1);
  assert.equal(coverage[center], 1);
  assert.deepEqual(getPixel(imageData, center), [48, 106, 196, 255]);
  assert.equal(coverage[islandGap], 0, 'a two-sided gap between islands stays transparent');
});

test('region-aware repair closes a continuous one-pixel topology crack inside one UV island', () => {
  const width = 7;
  const height = 5;
  const imageData = createImageData(width, height);
  const coverage = new Uint8Array(width * height);
  const topology = new Uint8Array(width * height);
  const regionIds = new Uint32Array(width * height);

  for (let y = 1; y <= 3; y += 1) {
    for (const x of [2, 4]) {
      const index = y * width + x;
      topology[index] = 1;
      coverage[index] = 1;
      regionIds[index] = 17;
      setPixel(imageData, index, [48, 106, 196, 255]);
    }
  }

  const filled = fillEnclosedUvCoverageGaps(
    imageData,
    coverage,
    topology,
    1,
    regionIds,
  );

  assert.equal(filled, 3);
  for (let y = 1; y <= 3; y += 1) {
    const index = y * width + 3;
    assert.equal(coverage[index], 1);
    assert.deepEqual(getPixel(imageData, index), [48, 106, 196, 255]);
  }
});

test('region-aware topology crack repair cannot bridge separate UV islands', () => {
  const width = 7;
  const height = 3;
  const imageData = createImageData(width, height);
  const coverage = new Uint8Array(width * height);
  const topology = new Uint8Array(width * height);
  const regionIds = new Uint32Array(width * height);
  const row = 1;
  const left = row * width + 2;
  const right = row * width + 4;
  const gap = row * width + 3;

  for (const [index, region] of [[left, 3], [right, 9]]) {
    topology[index] = 1;
    coverage[index] = 1;
    regionIds[index] = region;
    setPixel(imageData, index, [48, 106, 196, 255]);
  }

  const filled = fillEnclosedUvCoverageGaps(
    imageData,
    coverage,
    topology,
    1,
    regionIds,
  );

  assert.equal(filled, 0);
  assert.equal(coverage[gap], 0);
  assert.deepEqual(getPixel(imageData, gap), [0, 0, 0, 0]);
});

test('transparent UV gutter preserves source color and alpha outside the island', () => {
  const width = 5;
  const height = 5;
  const imageData = createImageData(width, height);
  const coverage = new Uint8Array(width * height);
  const topology = new Uint8Array(width * height);
  const center = 2 * width + 2;

  topology[center] = 1;
  coverage[center] = 1;
  setPixel(imageData, center, [14, 88, 201, 192]);

  const padded = padUvIslandGuttersWithTopology(
    imageData,
    coverage,
    topology,
    1,
    true,
  );

  assert.equal(padded, 8);
  const neighbor = 2 * width + 1;
  assert.deepEqual(getPixel(imageData, neighbor), [14, 88, 201, 192]);
  assert.equal(coverage[neighbor], 1);
  assert.deepEqual(getPixel(imageData, center), [14, 88, 201, 192]);
});

test('topology target mask keeps the frontier fill inside model UVs', () => {
  const width = 9;
  const height = 3;
  const imageData = createImageData(width, height);
  const coverage = new Uint8Array(width * height);
  const topology = new Uint8Array(width * height);
  const row = 1;
  const seed = row * width + 1;

  for (let x = 1; x <= 5; x += 1) topology[row * width + x] = 1;
  coverage[seed] = 1;
  setPixel(imageData, seed, [35, 75, 145, 220]);

  const filled = dilateImageData(imageData, coverage, 64, topology, true);

  assert.equal(filled, 4);
  assert.deepEqual(getPixel(imageData, row * width + 5), [35, 75, 145, 220]);
  assert.equal(coverage[row * width + 6], 0, 'frontier must stop at the topology boundary');
});

test('merge UV options enable enclosed-hole repair without broad topology growth', () => {
  assert.deepEqual(getMergeUvPostprocessOptions(512), {
    uvIslandGutterPixels: 2,
    uvCoverageGapPixels: 0,
    uvInteriorHolePixels: 1,
    uvSeamRepairPixels: 2,
  });
  assert.deepEqual(getMergeUvPostprocessOptions(2048), {
    uvIslandGutterPixels: 4,
    uvCoverageGapPixels: 0,
    uvInteriorHolePixels: 1,
    uvSeamRepairPixels: 2,
  });
  assert.deepEqual(getMergeUvPostprocessOptions(8192), {
    uvIslandGutterPixels: 8,
    uvCoverageGapPixels: 0,
    uvInteriorHolePixels: 2,
    uvSeamRepairPixels: 4,
  });
});

test('opaque UV gutter keeps the historical opaque alpha behavior', () => {
  const width = 3;
  const height = 3;
  const imageData = createImageData(width, height);
  const coverage = new Uint8Array(width * height);
  const topology = new Uint8Array(width * height);
  const center = 4;

  topology[center] = 1;
  coverage[center] = 1;
  setPixel(imageData, center, [40, 50, 60, 128]);

  padUvIslandGuttersWithTopology(imageData, coverage, topology, 1, false);

  assert.deepEqual(getPixel(imageData, 1), [40, 50, 60, 255]);
  assert.equal(coverage[1], 1);
});
