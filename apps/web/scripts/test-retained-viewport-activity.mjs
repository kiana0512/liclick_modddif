import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  const viewportSource = await readFile(
    new URL('../src/engine/viewport/ViewportCanvas.tsx', import.meta.url),
    'utf8',
  );
  const sceneRootSource = await readFile(
    new URL('../src/engine/viewport/SceneRoot.tsx', import.meta.url),
    'utf8',
  );
  const {
    getRetainedViewportFrameloop,
    getRetainedRuntimeFrameLeaseMode,
    shouldMountRetainedViewportRenderer,
    shouldWakeRetainedViewport,
  } =
    await server.ssrLoadModule('/src/engine/viewport/viewportActivityPolicy.ts');

  assert.equal(getRetainedViewportFrameloop(true), 'always');
  assert.equal(
    getRetainedViewportFrameloop(false, true),
    'demand',
    'an active hidden pipeline must stay renderable for async material publication',
  );
  assert.equal(getRetainedViewportFrameloop(false, false), 'never');
  assert.equal(getRetainedRuntimeFrameLeaseMode(true, false), 'none');
  assert.equal(getRetainedRuntimeFrameLeaseMode(false, false), 'invalidate');
  assert.equal(
    getRetainedRuntimeFrameLeaseMode(true, true),
    'advance',
    'the active texture route still needs an explicit frame lease when its browser tab is hidden',
  );
  assert.equal(getRetainedRuntimeFrameLeaseMode(false, true), 'advance');
  assert.equal(shouldWakeRetainedViewport(false, true), true);
  assert.equal(shouldWakeRetainedViewport(true, true), false);
  assert.equal(shouldWakeRetainedViewport(true, false), false);
  assert.equal(shouldMountRetainedViewportRenderer(true), true);
  assert.equal(
    shouldMountRetainedViewportRenderer(false),
    false,
    'a released project workflow must release the texture renderer GPU context',
  );
  assert.match(
    viewportSource,
    /RetainedRuntimeFrameDriver[\s\S]*?enabled=\{keepRuntimeActive\}[\s\S]*?workspaceActive=\{isActive\}/,
  );
  assert.match(
    viewportSource,
    /getRetainedRuntimeFrameLeaseMode\([\s\S]*?document\.visibilityState !== 'visible' \|\| !document\.hasFocus\(\)[\s\S]*?advance\(performance\.now\(\), true\)[\s\S]*?invalidate\(\)/,
    'Hidden tabs and unfocused/occluded windows must advance R3F subscribers without waiting for rAF.',
  );
  assert.match(viewportSource, /document\.addEventListener\('visibilitychange', restart\)/);
  assert.match(viewportSource, /window\.addEventListener\('blur', restart\)/);
  assert.match(viewportSource, /window\.addEventListener\('focus', restart\)/);
  assert.doesNotMatch(
    sceneRootSource,
    /await new Promise<\s*void\s*>\(\(resolve\) =>\s*window\.requestAnimationFrame/,
    'Projection preparation and GPU fence polling must use the background-safe paint scheduler.',
  );
  assert.match(
    sceneRootSource,
    /compositor\.request\(\{[\s\S]*?\}\);[\s\S]*?invalidate\(\);/,
    'A retained UV request must wake its first demand-mode compositor step.',
  );
  assert.match(
    sceneRootSource,
    /compositor\.request\(\{[\s\S]*?const drive = \(\) => \{[\s\S]*?compositor\.step\(\)[\s\S]*?queueMicrotask\(drive\)/,
    'Resident UV computation must start from an algorithm task instead of waiting for useFrame.',
  );
  assert.match(
    sceneRootSource,
    /document\.visibilityState !== 'visible' \|\| !document\.hasFocus\(\)[\s\S]*?backgrounded \? 250 : 50/,
    'The task-driven compositor lease must remain active in hidden or occluded tabs.',
  );

  stdout.write('Retained viewport activity regression test passed.\n');
} finally {
  await server.close();
}
