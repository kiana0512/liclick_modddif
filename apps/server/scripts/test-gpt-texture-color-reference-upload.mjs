import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import sharp from 'sharp';
import { isGptRepaintColorGuide, isGptTextureColorGuide } from '../dist/services/liclickGenerationService.js';
import { prepareRepaintColorUploadArguments } from '../dist/services/repaintColorReferenceUpload.js';
import { atlasReferenceDataUrlBudget, losslessReferenceDataUrl } from '../dist/services/pixelExactReferenceUpload.js';

const input = { workflow: 'texture-map', model: 'gpt-image-2.5-flare', framing: { version: 2 }, references: [
  { name: 'Current model view - 左前', url: 'fixture' },
  { name: 'material.png', url: 'fixture' },
] };
for (const model of ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']) {
  assert.equal(isGptTextureColorGuide({ ...input, model }, 0), true);
}
assert.equal(isGptTextureColorGuide({ ...input, references: [{ ...input.references[0], name: 'Current model view - custom' }, input.references[1]] }, 0), true);
assert.equal(isGptRepaintColorGuide(input, 0), false, 'The existing repaint classifier remains narrow');
for (const index of [1, 2, -1]) assert.equal(isGptTextureColorGuide(input, index), false, 'Only the current colour guide may adapt RGB');
for (const patch of [
  { workflow: 'local-repaint' }, { workflow: 'liclick' }, { model: 'nano_banana_2' },
  { framing: undefined }, { referencePipeline: 'six-view-delight-v1' },
  { references: [input.references[0]] }, { references: [] },
  ...['mask.png', 'image-2-geometry-view-normal.png', 'material.png', 'Current model view - '].map(name =>
    ({ references: [{ ...input.references[0], name }, input.references[1]] })),
]) assert.equal(isGptTextureColorGuide({ ...input, ...patch }, 0), false);
// Full-size textured view: the existing exact path exhausts its inline budget.
// Adaptive RGB changes only the upload copy, never its shape or transparency.
const width = 4096, height = 3072;
const noise = randomBytes(width / 2 * height / 2);
const pixels = Buffer.alloc(width / 2 * height / 2 * 3);
for (let i = 0; i < noise.length; i++) pixels[i * 3] = pixels[i * 3 + 1] = pixels[i * 3 + 2] = noise[i];
const png = await sharp(pixels, { raw: { width: width / 2, height: height / 2, channels: 3 } })
  .resize(width, height, { kernel: 'nearest' }).png().toBuffer();
const original = `data:image/png;base64,${png.toString('base64')}`;
assert.ok((await losslessReferenceDataUrl(original)).length > atlasReferenceDataUrlBudget);
const uploaded = await prepareRepaintColorUploadArguments(original);
assert.ok(uploaded.file_path.startsWith('data:image/webp;'));
const envelope = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'upload_asset', arguments: { asset_type: 'image', ...uploaded } } };
assert.ok(Buffer.byteLength(JSON.stringify(envelope)) < 4_000_000);
const after = await sharp(Buffer.from(uploaded.file_path.split(',')[1], 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
assert.equal(after.info.width, width); assert.equal(after.info.height, height);
for (let i = 3; i < after.data.length; i += 4) assert.equal(after.data[i], 255);
process.stdout.write(`GPT single/multiview colour upload passed: ${original.length} -> ${uploaded.file_path.length} Base64 bytes, original ${width}x${height}, exact alpha and <4MB JSON. Normal/mask/material contracts isolated; no remote generation.\n`);
