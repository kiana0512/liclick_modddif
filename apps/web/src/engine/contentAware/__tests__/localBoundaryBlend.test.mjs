import assert from 'node:assert/strict';
import test from 'node:test';
import { repairSurfaceTexture } from '../surfaceAwareRepair.ts';
import { createVisibleSurfaceCompletionPolicy } from '../visibleSurfaceCompletionPolicy.ts';

function fixture(width, height = 1) {
  const size = width * height;
  return { width, height, rgba: new Uint8ClampedArray(size * 4), writeMask: new Uint8Array(size),
    topologyMask: new Uint8Array(size).fill(1), topologyRegionIds: new Uint32Array(size).fill(1),
    ...createVisibleSurfaceCompletionPolicy(width, height).propagation,
    maxDistance: 16, coverageSkirtPixels: 0, outputBleedPixels: 0, sourceColorOutlierThreshold: 0 };
}
const pixel = (f, i, rgb, alpha = 255) => f.rgba.set([...rgb, alpha], i * 4);
const rgb = (r, i) => [...r.filledRgba.slice(i * 4, i * 4 + 3)];

test('a narrow seam interpolates both local boundaries instead of a constant or nearest-owner stripe', () => {
  const f = fixture(9); pixel(f, 0, [110, 80, 75]); pixel(f, 8, [150, 100, 95]); f.writeMask.fill(255, 1, 8);
  const before = f.rgba.slice(); const repaired = repairSurfaceTexture(f);
  const nearest = repairSurfaceTexture({ ...f, localBoundaryBlend: false });
  assert.ok(rgb(repaired, 4)[0] > 115 && rgb(repaired, 4)[0] < 145);
  const colors = [110, ...Array.from({ length: 7 }, (_, i) => rgb(repaired, i + 1)[0]), 150];
  for (let i = 1; i < colors.length; i++) {
    assert.ok(colors[i] >= colors[i - 1], 'gradient is monotonic');
    assert.ok(colors[i] - colors[i - 1] < 15, 'no abrupt donor boundary');
  }
  assert.notDeepEqual(repaired.filledRgba, nearest.filledRgba);
  assert.deepEqual(f.rgba, before, 'source texture untouched');
  assert.equal(repaired.repairedMask[0], 0); assert.equal(repaired.repairedMask[8], 0);
  assert.equal(repaired.stats.sourceRegionLockedComponents, 0);
});

test('mouth pink uses its own boundary, never the nearby yellow skin or foreign seam link', () => {
  const f = fixture(14);
  f.topologyRegionIds.fill(2, 6);
  for (let i = 0; i < 6; i++) pixel(f, i, [230, 175, 35]);
  pixel(f, 6, [140, 80, 90]); pixel(f, 13, [160, 100, 105]); f.writeMask.fill(255, 7, 13);
  f.seamLinks = new Uint32Array([5, 9]);
  const repaired = repairSurfaceTexture({ ...f, maxSeamCrossings: 1, fillUnreachableWithGlobalAverage: true, lockToDominantSourceRegion: true });
  for (let i = 7; i < 13; i++) {
    const [r, g, b] = rgb(repaired, i);
    assert.ok(r >= 140 && r <= 160 && g <= 100 && b >= 90, 'only pink local boundary colors');
  }
  f.rgba.fill(0, 6 * 4); f.writeMask.fill(255, 6);
  const blank = repairSurfaceTexture(f);
  assert.equal(blank.stats.repairedPixels, 0, 'blank mouth remains open, no yellow fallback');
  assert.equal(blank.stats.globalFallbackPixels, 0);
});

test('strong material boundaries do not become averaged muddy colors', () => {
  const f = fixture(9); pixel(f, 0, [230, 175, 35]); pixel(f, 8, [120, 60, 100]); f.writeMask.fill(255, 1, 8);
  const repaired = repairSurfaceTexture(f);
  for (let i = 1; i < 8; i++) {
    assert.ok([[230, 175, 35], [120, 60, 100]].some((v) => v.every((c, j) => rgb(repaired, i)[j] === c)));
  }
});

test('fine boundary variation stays local and holes/excluded weak pixels cannot donate', () => {
  const f = fixture(7, 7);
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
    pixel(f, y * 7 + x, [120 + y * 3, 80, 90]);
    if (x === 3) { f.writeMask[y * 7 + x] = 255; pixel(f, y * 7 + x, [255, 255, 255], 0); }
  }
  f.topologyMask[24] = 0;
  const result = repairSurfaceTexture(f);
  assert.equal(result.repairedMask[24], 0, 'real hole preserved');
  assert.ok(rgb(result, 3)[0] < rgb(result, 45)[0], 'vertical variation is not a single flat color');
  assert.ok(rgb(result, 3)[0] < 130);
  const weak = fixture(5); pixel(weak, 0, [255, 255, 255], 100); weak.writeMask.fill(255, 1);
  assert.equal(repairSurfaceTexture(weak).stats.repairedPixels, 0, 'weak fringe rejected');
});

test('blend is deterministic, cancellable, and radius scales without lowering output resolution', () => {
  const f = fixture(9); pixel(f, 0, [110, 80, 75]); pixel(f, 8, [150, 100, 95]); f.writeMask.fill(255, 1, 8);
  assert.deepEqual(repairSurfaceTexture(f).filledRgba, repairSurfaceTexture(f).filledRgba);
  let abort = false;
  assert.throws(() => repairSurfaceTexture(f, { shouldAbort: () => abort, onProgress: (p) => { if (p.phase === 'blending') abort = true; } }), /cancelled/);
  for (const size of [1024, 2048, 4096, 8192]) {
    const p = createVisibleSurfaceCompletionPolicy(size).propagation;
    assert.equal(p.maxDistance, size / 128); assert.equal(p.localBoundaryBlend, true);
    assert.equal(p.fillUnreachableWithGlobalAverage, false); assert.equal(p.maxSeamCrossings, 0);
  }
});
