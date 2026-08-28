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
  const {
    getRetainedViewportFrameloop,
    shouldMountRetainedViewportRenderer,
    shouldWakeRetainedViewport,
  } =
    await server.ssrLoadModule('/src/engine/viewport/viewportActivityPolicy.ts');

  assert.equal(getRetainedViewportFrameloop(true), 'always');
  assert.equal(
    getRetainedViewportFrameloop(false),
    'demand',
    'the retained editor must stay renderable for async material publication',
  );
  assert.equal(shouldWakeRetainedViewport(false, true), true);
  assert.equal(shouldWakeRetainedViewport(true, true), false);
  assert.equal(shouldWakeRetainedViewport(true, false), false);
  assert.equal(shouldMountRetainedViewportRenderer(true), true);
  assert.equal(
    shouldMountRetainedViewportRenderer(false),
    false,
    'a hidden companion workspace must release the texture renderer GPU context',
  );

  stdout.write('Retained viewport activity regression test passed.\n');
} finally {
  await server.close();
}
