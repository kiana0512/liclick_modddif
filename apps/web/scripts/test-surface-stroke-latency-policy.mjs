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
  const {
    shouldCollapseSurfaceStrokeToLatestSample,
    shouldDeferSurfaceStrokeCommit,
    shouldRetainProjectedEraserPreview,
    shouldUploadSurfaceStrokeProjectionTexture,
  } = await server.ssrLoadModule('/src/engine/paint/surfaceStrokeLatencyPolicy.ts');

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

  assert.equal(
    shouldUploadSurfaceStrokeProjectionTexture({
      operation: 'eraser',
      target: 'projected-mask',
    }),
    false,
    'Projected eraser frames must not upload the refinement-only projection texture.',
  );
  assert.equal(
    shouldUploadSurfaceStrokeProjectionTexture({ operation: 'brush', target: 'projected-mask' }),
    true,
    'Projected brush feedback must continue uploading its visible projection texture.',
  );

  assert.equal(
    shouldRetainProjectedEraserPreview({ target: 'projected-mask', pendingPaintCommits: 1 }),
    true,
    'A queued projected-mask commit must retain the shared live preview across UI rebuilds.',
  );
  assert.equal(
    shouldRetainProjectedEraserPreview({ target: 'projected-mask', pendingPaintCommits: 0 }),
    false,
    'The shared live preview may be released after the resident projected mask is authoritative.',
  );
  assert.equal(
    shouldRetainProjectedEraserPreview({
      target: 'projected-mask',
      pendingPaintCommits: 0,
      residentMaskBound: false,
      layerVisible: true,
    }),
    true,
    'A visible projected layer must retain the live mask until the rebuilt resident material binds it.',
  );
  assert.equal(
    shouldRetainProjectedEraserPreview({
      target: 'projected-mask',
      pendingPaintCommits: 0,
      residentMaskBound: false,
      layerVisible: false,
    }),
    false,
    'A hidden projected layer may release the live sampler because its stored live mask is authoritative when reopened.',
  );
  assert.equal(
    shouldRetainProjectedEraserPreview({ target: 'uv-image', pendingPaintCommits: 1 }),
    false,
    'UV-image erasing does not use the projected live-mask handoff.',
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
    /waitForPaintCommitIdle\(\s*isCancelled,\s*PROJECTED_ERASER_INTERACTIVE_COMMIT_IDLE_MS,\s*\(\) =>\s*paintHistoryBoundary\.busy \|\|[\s\S]*?paintCommitHandoffLayerIdRef\.current === layer\.layerId[\s\S]*?false,/,
    'Projected eraser commit must yield during a stroke burst, flush immediately for a layer handoff, and avoid a long requestIdleCallback wait.',
  );
  assert.match(
    viewportSource,
    /shouldUploadSurfaceStrokeProjectionTexture\(\{\s*operation: 'eraser',[\s\S]*?target: layer\.target,[\s\S]*?\}\)[\s\S]*?scheduleTextureUpdate\(layer\.projectionTexture\)/,
    'Projected eraser frames must guard the refinement-only GPU upload with the latency policy.',
  );
  assert.match(
    viewportSource,
    /const canvasRect = strokeCanvasRectRef\.current \?\? canvas\.getBoundingClientRect\(\);/,
    'Paint batches must reuse pointer-down canvas bounds instead of forcing layout every frame.',
  );
  assert.match(
    viewportSource,
    /previousLayer\.objectId !== model\.objectId \|\|[\s\S]*?previousLayer\.layerId !== activePaintLayerId[\s\S]*?previousLayer\.pendingPaintCommits > 0 \|\|[\s\S]*?previousLayer\.liveEraserPreviewActive \|\|[\s\S]*?previousLayer\.projectedEraserResidentHandoffPromise[\s\S]*?await handoffPromise;[\s\S]*?endLiveEraserPreview\(previousLayer\);[\s\S]*?await previousLayer\.projectedEraserResidentHandoffPromise;[\s\S]*?const layer = getUvPaintLayer\(model\);/,
    'Layer or model selection must wait for both the queued pixel commit and the resident material handoff before reusing the single live eraser sampler.',
  );
  assert.match(
    viewportSource,
    /layer\.pendingPaintCommits \+= 1;[\s\S]*?layer\.paintCommitChain = queuedCommit[\s\S]*?\.finally\(\(\) => \{\s*layer\.pendingPaintCommits = Math\.max\(0, layer\.pendingPaintCommits - 1\);/,
    'Projected paint commits must expose an exact pending count for the layer handoff barrier.',
  );
  assert.match(
    viewportSource,
    /function endLiveEraserPreview[\s\S]*?shouldRetainProjectedEraserPreview\([\s\S]*?return;[\s\S]*?promoteProjectedEraserMaskToResidentMaterial[\s\S]*?shouldRetainProjectedEraserPreview\([\s\S]*?projectedEraserResidentHandoffs\?\.add\(layer\)[\s\S]*?clearLiveSurfacePaintPreview/,
    'Tool, layer and preview switches must retain the shared live authority through both pixel commit and resident-material handoff.',
  );
  assert.match(
    viewportSource,
    /liclick:projected-material-resident[\s\S]*?projectedEraserResidentHandoffsRef\.current[\s\S]*?endLiveEraserPreview\(layer\)/,
    'A resident material publication must retry and complete pending projected eraser handoffs.',
  );
  const claimStart = viewportSource.indexOf('if (!result) return;\n      setViewportPaintPointer');
  assert(claimStart >= 0);
  const claimEnd = viewportSource.indexOf('if (isInpaintMode)', claimStart);
  const claim = new Function('result', 'canvas', 'event', 'setViewportPaintPointer',
    'paintLayerHandoffPromiseRef', 'paintHistoryBoundary',
    `${viewportSource.slice(claimStart, claimEnd)} return 'paint';`);
  for (const hit of [false, true]) for (const handoff of [false, true]) for (const busy of [false, true]) {
    const calls = [];
    const canvas = {};
    const event = { pointerId: 7, preventDefault: () => calls.push('prevent'), stopImmediatePropagation: () => calls.push('stop') };
    const outcome = claim(hit, canvas, event, (target, id) => {
      assert.equal(target, canvas);
      assert.equal(id, 7);
      calls.push('claim');
    }, { current: handoff }, { busy });
    assert.deepEqual(calls, hit ? ['claim', 'prevent', 'stop'] : []);
    assert.equal(outcome, hit && !handoff && !busy ? 'paint' : undefined,
      'Handoff/history barriers must keep the old mask authoritative and block new paint.');
  }

  process.stdout.write('surface stroke latency policy tests passed\n');
} finally {
  await server.close();
}
