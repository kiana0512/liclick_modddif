import assert from 'node:assert/strict';
import sharp from 'sharp';
import { atlasReferenceDataUrlBudget, losslessReferenceDataUrl, preparePixelExactUploadArguments, prepareMaterialReferenceUploadArguments } from '../dist/services/pixelExactReferenceUpload.js';
import { serverConfig } from '../dist/config.js';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import console from 'node:console';
import { isMaterialReference } from '../dist/services/liclickGenerationService.js';

assert.equal(isMaterialReference({ referencePipeline: 'delight-only-v1', references: [{ url: 'material' }] }, 0), true);
assert.equal(isMaterialReference({ referencePipeline: 'six-view-delight-v1', references: [{ url: 'material' }] }, 0), true);
assert.equal(isMaterialReference({ workflow: 'liclick', references: [{ url: 'material' }] }, 0), true);
for (const input of [{ workflow: 'local-repaint', references: [{ url: 'normal' }] },
  { workflow: 'texture-map', references: [{ url: 'capture' }] },
  { referencePipeline: 'delight-only-v1', references: [{ url: 'material' }, { url: 'normal' }] }]) {
  assert.equal(isMaterialReference(input, 0), false, 'Never apply material policy to geometry or a mixed reference set');
}

const dataUrl = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
const decode = async url => sharp(Buffer.from(url.split(',')[1], 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const width = 2048, height = 1536;
const pixels = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const i = (y * width + x) * 4;
  pixels[i] = x % 256; pixels[i + 1] = y % 256; pixels[i + 2] = (x + y) % 256; pixels[i + 3] = (x % 7 === 0 ? 128 : 255);
}
const original = dataUrl(await sharp(pixels, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer());
assert.ok(original.length > atlasReferenceDataUrlBudget);
const compressed = await losslessReferenceDataUrl(original);
assert.ok(compressed.length < atlasReferenceDataUrlBudget);
const before = await decode(original), after = await decode(compressed);
assert.deepEqual(after.info, before.info);
assert.ok(after.data.equals(before.data), 'RGBA, alpha, dimensions and alignment must remain exact');
assert.deepEqual(await preparePixelExactUploadArguments(original, {}), { file_path: compressed });
assert.equal(await losslessReferenceDataUrl(compressed), compressed, 'Small images pass through unchanged');

// Exercise full 4K PNG data with an oversized, valid ancillary text chunk.
// Removing metadata must preserve every decoded texel at the original size.
const fourKBytes = await sharp({ create: { width: 4096, height: 4096, channels: 4, background: '#497ba3' } }).png().toBuffer();
const text = Buffer.from(`Fixture\0${'x'.repeat(4 * 1024 * 1024)}`);
const chunk = Buffer.alloc(text.length + 12);
chunk.writeUInt32BE(text.length); chunk.write('tEXt', 4); text.copy(chunk, 8);
let crc = 0xffffffff;
for (const byte of chunk.subarray(4, -4)) {
  crc ^= byte;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
}
chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
const fourK = dataUrl(Buffer.concat([fourKBytes.subarray(0, -12), chunk, fourKBytes.subarray(-12)]));
assert.ok(fourK.length > atlasReferenceDataUrlBudget);
const fourKAfter = await decode(await losslessReferenceDataUrl(fourK));
assert.equal(fourKAfter.info.width, 4096);
assert.equal(fourKAfter.info.height, 4096);
assert.ok(fourKAfter.data.equals((await decode(fourK)).data));

// Incompressible pixels cannot be forced into the Atlas envelope. The cloud
// path uses only a verified, owned object and the download URL; no real upload.
const { randomBytes } = await import('node:crypto');
// Structured texture noise exceeds the inline budget as PNG, while lossless
// WebP fits. Exercise the codec choice without relying on user project files.
const textureSize = 1536, textureNoise = randomBytes(textureSize * textureSize);
const texturePixels = Buffer.alloc(textureSize * textureSize * 4);
for (let i = 0; i < textureNoise.length; i++) {
  texturePixels[i * 4] = texturePixels[i * 4 + 1] = texturePixels[i * 4 + 2] = textureNoise[i];
  texturePixels[i * 4 + 3] = 255;
}
const texturePng = dataUrl(await sharp(texturePixels, { raw: { width: textureSize, height: textureSize, channels: 4 } }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer());
assert.ok(texturePng.length > atlasReferenceDataUrlBudget);
const textureWebp = await losslessReferenceDataUrl(texturePng);
assert.ok(textureWebp.startsWith('data:image/webp;'));
assert.ok(textureWebp.length <= atlasReferenceDataUrlBudget);
assert.ok((await decode(textureWebp)).data.equals(texturePixels));
assert.deepEqual(await preparePixelExactUploadArguments(texturePng, {}), { file_path: textureWebp });

// RGB underneath transparent pixels is part of the exact contract too.
const transparentPixels = Buffer.from(texturePixels);
for (let i = 0; i < textureNoise.length; i++) transparentPixels[i * 4 + 3] = 0;
const transparentPng = dataUrl(await sharp(transparentPixels, { raw: { width: textureSize, height: textureSize, channels: 4 } }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer());
const transparentResult = await losslessReferenceDataUrl(transparentPng);
assert.ok((await decode(transparentResult)).data.equals(transparentPixels), 'Transparent RGB must not be discarded by a lossless codec');
const noisy = dataUrl(await sharp(randomBytes(1024 * 1024 * 4), { raw: { width: 1024, height: 1024, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer());
const previousEnabled = serverConfig.objectStorage.enabled;
serverConfig.objectStorage.enabled = false;
try {
  await assert.rejects(() => preparePixelExactUploadArguments(noisy, {}), /未配置大图对象存储上传/);
  await assert.rejects(() => losslessReferenceDataUrl(`data:image/png;base64,${'A'.repeat(24 * 1024 * 1024)}`), /16 MiB/);
} finally { serverConfig.objectStorage.enabled = previousEnabled; }

// Execute the real helper with isolated object storage adapters, checking
// ownership and verified URL resolution without credentials or external I/O.
const source = readFileSync(new URL('../src/services/pixelExactReferenceUpload.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const calls = [], fixtureModule = { exports: {} };
let verified = true;
new Function('module', 'exports', 'require', code)(fixtureModule, fixtureModule.exports, name => {
  if (name === 'sharp') return { default: sharp };
  if (name === '../config.js') return { serverConfig: { objectStorage: { enabled: true } } };
  if (name === './assetTransferService.js') return {
    saveProxiedObjectStorageAsset: async input => {
      assert.equal(input.userId, 'owned-user'); assert.equal(input.projectId, 'owned-project');
      assert.equal(input.category, 'captures'); assert.equal(input.mimeType, 'image/png');
      assert.ok((await decode(dataUrl(input.buffer))).data.equals((await decode(noisy)).data));
      calls.push('verified upload');
      return { relativePath: 'objects/asset-fixture' };
    },
    createAssetDownloadUrl: async (user, project, asset) => {
      assert.deepEqual([user, project, asset], ['owned-user', 'owned-project', 'asset-fixture']);
      calls.push('owned download'); return verified ? 'https://objects.fixture/guide?signature=fixture' : undefined;
    },
  };
  throw new Error(`Unexpected import ${name}`);
});
const cloud = fixtureModule.exports.preparePixelExactUploadArguments;
assert.deepEqual(await cloud(noisy, { userId: 'owned-user', projectId: 'owned-project' }), { url: 'https://objects.fixture/guide?signature=fixture' });
assert.deepEqual(calls, ['verified upload', 'owned download']);
verified = false;
await assert.rejects(() => cloud(noisy, { userId: 'owned-user', projectId: 'owned-project' }), /对象资产未验证/);
const callCount = calls.length;
await assert.rejects(() => cloud(noisy, { projectId: 'owned-project' }), /未配置/);
assert.equal(calls.length, callCount, 'Missing ownership must not upload');

// Material-only transport: preserve the source, all dimensions/alpha, bound
// every RGB channel and the actual JSON-RPC envelope, including Base64.
serverConfig.objectStorage.enabled = false;
try {
  assert.deepEqual(await prepareMaterialReferenceUploadArguments(original, {}), { file_path: compressed });
  for (const format of ['jpeg', 'webp']) {
    const encoded = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#689ab3' } }).toFormat(format).toBuffer();
    const file = Buffer.concat([encoded, Buffer.alloc(3 * 1024 * 1024)]);
    const input = `data:image/${format};base64,${file.toString('base64')}`;
    assert.ok(input.length > 4_000_000);
    const converted = await prepareMaterialReferenceUploadArguments(input, {});
    assert.ok(converted.file_path.length < 4_000_000 - 64 * 1024);
    assert.ok((await decode(converted.file_path)).data.equals((await decode(input)).data), 'JPEG/WebP material sources can be recompressed without PNG-only errors');
  }
  const materialWidth = 1536, materialHeight = 1536;
  const materialPixels = Buffer.alloc(materialWidth * materialHeight * 4);
  let seed = 0x9164517;
  for (let i = 0; i < materialPixels.length; i += 4) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    materialPixels[i] = 120 + (seed & 15);
    materialPixels[i + 1] = 120 + ((seed >>> 8) & 15);
    materialPixels[i + 2] = 120 + ((seed >>> 16) & 15);
    materialPixels[i + 3] = 255;
  }
  const material = dataUrl(await sharp(materialPixels, { raw: { width: materialWidth, height: materialHeight, channels: 4 } }).png().toBuffer());
  const result = await prepareMaterialReferenceUploadArguments(material, {});
  const decoded = await decode(result.file_path);
  assert.equal(decoded.info.width, materialWidth); assert.equal(decoded.info.height, materialHeight);
  let maxError = 0, squaredError = 0;
  for (let i = 0; i < materialPixels.length; i++) {
    const delta = Math.abs(decoded.data[i] - materialPixels[i]);
    if (i % 4 === 3) assert.equal(delta, 0, 'Alpha stays exact');
    else { maxError = Math.max(maxError, delta); squaredError += delta * delta; }
  }
  assert.ok(maxError > 0 && maxError <= 2, 'Exercise bounded near-lossless, not an already-small fixture');
  assert.ok(10 * Math.log10(255 ** 2 / (squaredError / (materialWidth * materialHeight * 3))) >= 45);
  const envelope = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'upload_asset', arguments: { asset_type: 'image', ...result } } };
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) < 4_000_000);
  assert.ok((await decode(material)).data.equals(materialPixels), 'Original remains immutable');
  const highEntropy = await prepareMaterialReferenceUploadArguments(noisy, {});
  assert.ok(highEntropy.file_path.length < 4_000_000 - 64 * 1024);
  const noisyBefore = await decode(noisy), noisyAfter = await decode(highEntropy.file_path);
  assert.deepEqual(noisyAfter.info, noisyBefore.info);
  for (let i = 3; i < noisyBefore.data.length; i += 4) assert.equal(noisyAfter.data[i], noisyBefore.data[i]);
  console.log(`Material upload: exact alpha/dimensions, max RGB error ${maxError}/255, envelope ${Buffer.byteLength(JSON.stringify(envelope))} bytes.`);
} finally { serverConfig.objectStorage.enabled = previousEnabled; }
assert.deepEqual(await fixtureModule.exports.prepareMaterialReferenceUploadArguments(noisy, { userId: 'owned-user', projectId: 'owned-project' }).catch(error => error.message), '结构引导图对象资产未验证或工程不可访问；未提交生成任务。', 'Cloud keeps verified exact transport instead of silently falling back');
console.log(`Pixel-exact upload passed: ${original.length} -> ${compressed.length} data URL bytes, identical RGBA; 4K retained; oversized failure precedes paid submission.`);
