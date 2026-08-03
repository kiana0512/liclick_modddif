import { stableAsciiAssetIdentity } from '../apps/web/src/services/assetProcessingIdentifiers.ts';

const asciiValue = 'li3d:model:uv:123';
if ((await stableAsciiAssetIdentity(asciiValue)) !== asciiValue) {
  throw new Error('Printable ASCII identity was changed.');
}

const originalCrypto = globalThis.crypto;
Object.defineProperty(globalThis, 'crypto', {
  value: undefined,
  configurable: true,
});

try {
  const source = 'li3d:中文模型:uv:123';
  const first = await stableAsciiAssetIdentity(source);
  const second = await stableAsciiAssetIdentity(source);
  if (first !== second) throw new Error('LAN HTTP fallback is not deterministic.');
  if (!/^[\x21-\x7e]+$/.test(first)) {
    throw new Error('LAN HTTP fallback still contains non-ASCII characters.');
  }
  if (!first.startsWith('li3d-hash128-')) {
    throw new Error(`Unexpected LAN HTTP fallback format: ${first}`);
  }
  process.stdout.write(`Asset identity smoke passed: ${first}\n`);
} finally {
  Object.defineProperty(globalThis, 'crypto', {
    value: originalCrypto,
    configurable: true,
  });
}
