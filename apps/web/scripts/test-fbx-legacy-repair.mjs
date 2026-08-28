import assert from 'node:assert/strict';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  const loader = await server.ssrLoadModule('/src/engine/loaders/loadFbxModel.ts');
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const unchanged = encoder.encode('ordinary-fbx-payload').buffer;
  assert.equal(
    loader.repairLegacyEmbeddedTextureFileNames(unchanged),
    unchanged,
    'A modern FBX must remain zero-copy.',
  );

  const legacy = encoder.encode(
    'head/liclick_image_0_png/middle/liclick_image_0_png/tail',
  ).buffer;
  const repaired = loader.repairLegacyEmbeddedTextureFileNames(legacy);
  assert.notEqual(repaired, legacy, 'A legacy payload must preserve the original buffer.');
  assert.equal(
    decoder.decode(repaired),
    'head/liclick_image_0.png/middle/liclick_image_0.png/tail',
  );
  assert.equal(
    decoder.decode(legacy),
    'head/liclick_image_0_png/middle/liclick_image_0_png/tail',
  );
  stdout.write('FBX legacy embedded-texture repair regression test passed.\n');
} finally {
  await server.close();
}
import { TextDecoder, TextEncoder } from 'node:util';
