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
  server: { middlewareMode: true, watch: { ignored: () => true } },
});

try {
  const { fitImagePreview } = await server.ssrLoadModule(
    '/src/components/panels/imagePreviewFit.ts',
  );

  assert.deepEqual(fitImagePreview({ width: 2000, height: 1000 }, { width: 800, height: 600 }), {
    width: 800,
    height: 400,
    fitScale: 0.4,
  });
  assert.deepEqual(fitImagePreview({ width: 1000, height: 2000 }, { width: 800, height: 600 }), {
    width: 300,
    height: 600,
    fitScale: 0.3,
  });
  assert.deepEqual(
    fitImagePreview({ width: 2000, height: 1000 }, { width: 800, height: 600 }, 1.5),
    { width: 1200, height: 600, fitScale: 0.4 },
  );

  stdout.write('Reference preview adaptive fit regression test passed.\n');
} finally {
  await server.close();
}
