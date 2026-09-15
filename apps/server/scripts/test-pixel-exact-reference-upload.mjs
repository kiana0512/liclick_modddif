import assert from 'node:assert/strict';
import sharp from 'sharp';
import { atlasReferenceDataUrlBudget, losslessReferenceDataUrl, preparePixelExactUploadArguments } from '../dist/services/pixelExactReferenceUpload.js';
import { serverConfig } from '../dist/config.js';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import console from 'node:console';

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
console.log(`Pixel-exact upload passed: ${original.length} -> ${compressed.length} data URL bytes, identical RGBA; 4K retained; oversized failure precedes paid submission.`);
