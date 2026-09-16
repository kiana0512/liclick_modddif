import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import sharp from 'sharp';
import { prepareRepaintColorUploadArguments } from '../dist/services/repaintColorReferenceUpload.js';
import { atlasReferenceDataUrlBudget, losslessReferenceDataUrl } from '../dist/services/pixelExactReferenceUpload.js';
import { isGptRepaintColorGuide } from '../dist/services/liclickGenerationService.js';

const pngUrl = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
const decode = url => sharp(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
  .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const input = { workflow: 'local-repaint', model: 'gpt-image-2.5-flare', references: [
  { name: 'image-1-current-view-clay-selection.png', url: 'fixture' },
  { name: 'image-2-geometry-view-normal.png', url: 'fixture' },
  { name: 'material.png', url: 'fixture' },
] };
for (const model of ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']) {
  assert.equal(isGptRepaintColorGuide({ ...input, model }, 0), true);
}
assert.equal(isGptRepaintColorGuide(input, 1), false, 'Normal must remain pixel exact');
assert.equal(isGptRepaintColorGuide(input, 2), false);
assert.equal(isGptRepaintColorGuide({ ...input, workflow: 'texture-map' }, 0), false);
assert.equal(isGptRepaintColorGuide({ ...input, model: 'nano_banana_2' }, 0), false);
assert.equal(isGptRepaintColorGuide({ ...input, references: [{ ...input.references[0], name: 'mask.png' }, input.references[1]] }, 0), false);
assert.equal(isGptRepaintColorGuide({ ...input, references: [input.references[0]] }, 0), false);

const small = pngUrl(await sharp({ create: { width: 64, height: 48, channels: 4, background: '#497ba3' } }).png().toBuffer());
assert.deepEqual(await prepareRepaintColorUploadArguments(small), { file_path: small });
const width = 1536, height = 1536, pixels = randomBytes(width * height * 4);
for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = offset % 11 ? 255 : 128;
const original = pngUrl(await sharp(pixels, { raw: { width, height, channels: 4 } })
  .png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer());
const lossless = await losslessReferenceDataUrl(original);
assert.ok(lossless.length > atlasReferenceDataUrlBudget, 'Fixture must reproduce exhausted lossless budget');
const uploaded = await prepareRepaintColorUploadArguments(original);
assert.ok(uploaded.file_path.startsWith('data:image/webp;base64,'));
assert.ok(uploaded.file_path.length <= atlasReferenceDataUrlBudget);
const envelope = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'upload_asset', arguments: { asset_type: 'image', ...uploaded } } };
assert.ok(Buffer.byteLength(JSON.stringify(envelope)) < 4_000_000, 'Complete upload JSON must be below 4MB');
const after = await decode(uploaded.file_path);
assert.equal(after.info.width, width);
assert.equal(after.info.height, height);
assert.equal(after.info.channels, 4);
for (let offset = 3; offset < pixels.length; offset += 4) assert.equal(after.data[offset], pixels[offset], 'Alpha is exact');
assert.ok(!after.data.equals(pixels), 'Only the colour-guide path may change RGB');
// The original PNG and lossless normal path retain every texel.
assert.ok((await decode(original)).data.equals(pixels));
assert.ok((await decode(lossless)).data.equals(pixels));
// Random transparency alone exceeds the inline budget. The cap must win
// without changing alpha, shrinking the image or calling an upload adapter.
const alphaWidth = 2048, alphaHeight = 1536;
const alphaNoise = randomBytes(alphaWidth * alphaHeight);
const alphaPixels = Buffer.alloc(alphaNoise.length * 4, 128);
for (let i = 0; i < alphaNoise.length; i++) alphaPixels[i * 4 + 3] = alphaNoise[i];
const alphaPng = pngUrl(await sharp(alphaPixels, { raw: { width: alphaWidth, height: alphaHeight, channels: 4 } }).png().toBuffer());
await assert.rejects(() => prepareRepaintColorUploadArguments(alphaPng), /透明度压缩后仍超过 4MB/);
await assert.rejects(() => prepareRepaintColorUploadArguments(`data:image/png;base64,${'A'.repeat(24 * 1024 * 1024)}`), /16 MiB/);
process.stdout.write(`Repaint colour upload passed: ${original.length} -> ${uploaded.file_path.length} Base64 bytes, <4MB JSON, ${width}x${height} and exact alpha; normal/mask guards passed. No remote generation.\n`);
