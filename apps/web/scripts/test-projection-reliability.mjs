import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reliableProjectionSupport, projectionGapMaskFromAlpha, PROJECTION_RELIABILITY_CUTOFF } from '../src/engine/projection/projectionCoverageContract.mjs';

assert.equal(PROJECTION_RELIABILITY_CUTOFF, 0.98);
for (const support of [0, 0.12, 0.5, 0.97999, NaN, -1]) assert.equal(reliableProjectionSupport(support), 0);
for (const support of [0.98, 0.999, 1]) assert.equal(reliableProjectionSupport(support), 1);
for (let i = 0; i <= 255; i++) {
  const authoredAlpha = i / 255;
  assert.equal(authoredAlpha * reliableProjectionSupport(1), authoredAlpha, 'author opacity/eraser feather stays continuous');
  assert.equal(authoredAlpha * reliableProjectionSupport(0.5), 0);
}
const object = { width: 4, height: 2, data: new Uint8Array([255,255,255,0,255,255,255,255]) };
const image = { width: 4, height: 2, data: new Uint8ClampedArray(32) };
const alpha = [255,254,0,0,255,255,0,255];
for (let i = 0; i < 8; i++) image.data.set([i % 2 ? 255 : 0, i * 30, 17, alpha[i]], i * 4);
assert.deepEqual([...projectionGapMaskFromAlpha(image, object).data], [0,255,255,0,0,0,255,0]);
const expected = projectionGapMaskFromAlpha(image, object).data;
for (let i = 0; i < 8; i++) image.data.fill(0, i * 4, i * 4 + 3);
assert.deepEqual(projectionGapMaskFromAlpha(image, object).data, expected, 'black material is never mistaken for a gap');
assert.throws(() => projectionGapMaskFromAlpha(image, { ...object, width: 1 }), /dimensions/);

for (const file of ['projection/ProjectedLayerMaterial.ts','projection/ProjectedLayerPreviewCompositor.ts','bake/gpuUvBakeRenderer.ts']) {
  const text = await readFile(new URL(`../src/engine/${file}`, import.meta.url), 'utf8');
  assert.match(text, /RELIABLE_PROJECTION_GLSL/);
  assert.match(text, /reliableProjectionSupport\(angleCoverage \*/);
  assert.match(text, /mix\(continuousCoverage,\s*lockedCoverage,\s*surfaceLockedVisibility\)|mix\(\s*continuousCoverage,\s*lockedCoverage,\s*compactSurfaceLocks/);
}
const shader = await readFile(new URL('../src/engine/projection/ProjectedLayerMaterial.ts', import.meta.url), 'utf8');
assert.equal((shader.match(/reliableProjectionSupport\(angleCoverage/g) ?? []).length, 4, 'single, direct candidate, direct overlay and compact array share the gate');
assert.equal((shader.match(/float captureAlpha = showEmptyProjectionHatch > 1.5/g) ?? []).length, 3, 'single, multi and UV-only expose independent alpha coverage');
assert.match(shader, /capturedCoverage = 1.0 - \(1.0 - capturedCoverage\) \* compactOverlayTransmission/);
assert.match(shader, /capturedCoverage = mix\(capturedCoverage, 1.0, pendingOverlayAlpha/);
console.log('Projection reliability: geometric cutoff, authored alpha, all shader branches, real alpha gap mask, black RGB/hole/MSAA protection passed.');
