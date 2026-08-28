import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
  const { shouldCollapseSurfaceStrokeToLatestSample, shouldDeferSurfaceStrokeCommit } =
    await server.ssrLoadModule('/src/engine/paint/surfaceStrokeLatencyPolicy.ts');

  assert.equal(
    shouldCollapseSurfaceStrokeToLatestSample({
      isMaskStroke: true,
      isProjectedLayerEraser: false,
    }),
    true,
    'Selection and local repaint masks must keep their latest-sample-per-frame path.',
  );
  assert.equal(
    shouldCollapseSurfaceStrokeToLatestSample({
      isMaskStroke: false,
      isProjectedLayerEraser: true,
    }),
    true,
    'Projected-layer erasing must collapse raw pointer samples like mask painting.',
  );
  assert.equal(
    shouldCollapseSurfaceStrokeToLatestSample({
      isMaskStroke: false,
      isProjectedLayerEraser: false,
    }),
    false,
    'UV painting and UV erasing must retain dense surface resampling.',
  );

  assert.equal(
    shouldDeferSurfaceStrokeCommit({ operation: 'eraser', target: 'projected-mask' }),
    true,
    'Projected eraser persistence must yield to interactive input.',
  );
  assert.equal(
    shouldDeferSurfaceStrokeCommit({ operation: 'eraser', target: 'uv-image' }),
    false,
    'UV erasing must keep its existing immediate handoff because it has no projected live mask.',
  );

  const viewportSource = fs.readFileSync(
    path.join(root, 'src/engine/viewport/ViewportCanvas.tsx'),
    'utf8',
  );
  assert.match(
    viewportSource,
    /const isProjectedLayerEraser\s*=\s*[\s\S]*?getEraserTargetPolicy\(activePaintLayer\)\.kind === 'projected-mask'/,
    'Viewport input must classify only ordinary projected-layer erasing for latest-sample collapse.',
  );
  assert.match(
    viewportSource,
    /const usesProjectedLiveStroke = shouldCollapseSurfaceStrokeToLatestSample\(\{[\s\S]*?isProjectedLayerEraser/,
    'Viewport input must consume the shared latency policy.',
  );
  assert.match(
    viewportSource,
    /waitForPaintCommitIdle\(\s*undefined,\s*PROJECTED_ERASER_INTERACTIVE_COMMIT_IDLE_MS/,
    'Projected eraser commit must wait for an interaction-free idle window.',
  );

  process.stdout.write('surface stroke latency policy tests passed\n');
} finally {
  await server.close();
}
