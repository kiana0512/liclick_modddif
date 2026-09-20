/* global Buffer, console, AbortController */
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { prepareSingleViewResultBlend, blendSingleViewResult } from '../dist/services/singleViewResultBlend.js';

const camera = { projection: 'orthographic', projectionMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1] };
const png = (pixels, width = pixels.length / 4) => sharp(Buffer.from(pixels), {
  raw: { width, height: pixels.length / 4 / width, channels: 4 },
}).png().toBuffer();
const rgba = buffer => sharp(buffer).ensureAlpha().raw().toBuffer();
const normalPng = (pixels, width = pixels.length / 4) => png(pixels.map((value, i) => {
  if (i % 4 === 3) return value;
  const x = value / 255;
  return Math.round(255 * (x <= .0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - .055));
}), width);
const current = await png([
  10, 20, 30, 255, 40, 50, 60, 255, 0, 0, 0, 255,
  80, 90, 100, 0, 0, 0, 0, 255, 110, 120, 130, 254,
]);
const object = await png(Array.from({ length: 6 }, (_, i) => i === 4 ? [0, 0, 0, 255] : [255, 255, 255, 255]).flat());
const normals = await normalPng([
  128, 128, 0, 255, 128, 128, 255, 255, 238, 128, 191, 255,
  128, 128, 0, 255, 128, 128, 255, 255, 128, 128, 0, 255,
]);
const prepared = await prepareSingleViewResultBlend(current, object, normals, camera);
assert.deepEqual([...prepared.weights].filter((_, i) => i !== 2), [0, 255, 255, 0, 255]);
assert(Math.abs(prepared.weights[2] - 127) <= 1, 'Black textured material still gets the angular weight');
const returned = await png(Array(6).fill([200, 150, 100, 255]).flat());
const output = await rgba(await blendSingleViewResult(returned, prepared));
assert.deepEqual([...output.subarray(0, 4)], [10, 20, 30, 255]);
assert.deepEqual([...output.subarray(4, 8)], [200, 150, 100, 255]);
assert.deepEqual([...output.subarray(8, 12)], [99, 74, 49, 255]); // quantized sRGB normal gives weight 126
assert.deepEqual([...output.subarray(12, 16)], [200, 150, 100, 255]);
assert.deepEqual([...output.subarray(16, 20)], [0, 0, 0, 255]);
assert.deepEqual([...output.subarray(20, 24)], [200, 150, 100, 255]);
const small = await png([255, 255, 255, 255]);
await assert.rejects(prepareSingleViewResultBlend(current, small, normals, camera), /尺寸/);
await assert.rejects(blendSingleViewResult(small, prepared), /尺寸/);
await assert.rejects(prepareSingleViewResultBlend(current, object, normals, { ...camera, projectionMatrix: [] }), /相机/);
await assert.rejects(prepareSingleViewResultBlend(Buffer.from('bad'), object, normals, camera));
// A front-facing plane has lower N·V at perspective image corners, no Y flip.
const flat = await normalPng(Array(9).fill([128, 128, 255, 255]).flat(), 3);
const white = await png(Array(9).fill([255, 255, 255, 255]).flat(), 3);
const perspective = await prepareSingleViewResultBlend(white, white, flat, { ...camera, projection: 'perspective' });
assert.equal(perspective.weights[4], 255);
assert(perspective.weights[0] < 200);
// Reusing immutable prepared data yields the same bytes: no cumulative blending.
assert.deepEqual(await blendSingleViewResult(returned, prepared), await blendSingleViewResult(returned, prepared));
const cancelled = new AbortController(); cancelled.abort();
await assert.rejects(prepareSingleViewResultBlend(current, object, normals, camera, cancelled.signal), { name: 'AbortError' });
await assert.rejects(blendSingleViewResult(returned, prepared, cancelled.signal), { name: 'AbortError' });
console.log('Single-view blend: endpoints, grey mix, black material, gaps, holes, perspective, dimensions and repeatability passed.');
