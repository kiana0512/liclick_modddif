import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import ts from 'typescript';
import * as THREE from 'three';
import './test-inpaint-prewarm-ownership.mjs';
import './test-view-aligned-brush.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } },
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
    false,
    'Projected-layer erasing needs intermediate UV hits, not just the final circle.',
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
  // Execute the production resampler, not a reimplementation. A fast drag
  // over many triangles must still leave overlapping brush stamps even when
  // getStrokeSourceUv correctly refuses to connect different UV triangles.
  const ast = ts.createSourceFile('ViewportCanvas.tsx', viewportSource,
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const resampler = ast.statements.find(node =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'resampleClientPath');
  assert(resampler);
  const resample = new Function('THREE', ts.transpileModule(resampler.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText + '\nreturn resampleClientPath;')(THREE);
  const start = { x: 0, y: 0, pressure: 0.2 };
  const end = { x: 180, y: 0, pressure: 1 };
  const radius = 10;
  const strokeSamples = resample(start, [end], 96, radius * 0.4).samples;
  assert(strokeSamples.length > 1);
  assert(strokeSamples.length <= 96);
  assert.deepEqual(strokeSamples.at(-1), end);
  let previous = start;
  for (const point of strokeSamples) {
    assert(Math.hypot(point.x - previous.x, point.y - previous.y) <= radius * 0.4 + 1e-8);
    assert(point.pressure >= previous.pressure && point.pressure <= 1);
    previous = point;
  }
  const curved = resample(start, [
    { x: 80, y: 0, pressure: 0.5 }, { x: 80, y: 80, pressure: 1 },
  ], 96, 4).samples;
  assert(curved.some(point => point.x === 80 && point.y === 0),
    'Coalesced bends must not be replaced by the diagonal between frame endpoints.');
  assert.equal(resample(start, [{ ...end, x: 10000 }], 96, 3).samples.length, 96,
    'Pathological input must retain the existing per-frame work bound.');
  assert.deepEqual(resample(start, [start], 96, 3).samples, [start]);
  assert.deepEqual(resample(undefined, [], 96, 3).samples, []);
  assert.match(viewportSource, /return sameFace \? previous\.uv : undefined;/,
    'Do not connect UV strokes across different triangles to hide the sampling bug.');
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
    /getUvPaintLayer\(model, true\)[\s\S]*?prepareProjectedEraserGpuPreview\(layer, model\)\.then\([\s\S]*?beginLiveEraserPreview\(layer, model\.group, false\)/,
    'The active projected layer must keep its neutral GPU mask warm without replacing the verified idle UV display.',
  );
  assert.match(
    viewportSource,
    /if \(paintTool === 'eraser'\)[\s\S]*?beginLiveEraserPreview\(layer, model\.group\)[\s\S]*?prepareProjectedEraserGpuPreview\(layer, model\)/,
    'Selecting the eraser must arm the exact live display before accepting the first stroke.',
  );
  assert.match(
    viewportSource,
    /const backlog = layer\.eraserGpuBacklog \?\? \[\];[\s\S]*?engine\.begin\(false\);[\s\S]*?backlog\.forEach\(\(stamp\) => engine\.stamp\(stamp\)\)[\s\S]*?if \(!continuing\) void engine\.end\(\)/,
    'Samples received during asynchronous GPU warmup must be replayed, with the active gesture left open for following frames.',
  );
  assert.match(
    viewportSource,
    /const canvasRect = strokeCanvasRectRef\.current \?\? canvas\.getBoundingClientRect\(\);/,
    'Paint batches must reuse pointer-down canvas bounds instead of forcing layout every frame.',
  );
  assert.match(
    viewportSource,
    /updateCursorFromHit\(\s*latestResult,\s*strokeCanvasRectRef\.current,\s*strokeCursorOverlayRectRef\.current,\s*\);/,
    'Active paint cursor updates must reuse both frozen layout rectangles and handle misses.',
  );
  assert.match(
    viewportSource,
    /strokeCursorOverlayRectRef\.current\s*=\s*cursorOverlayRef\.current\?\.getBoundingClientRect\(\) \?\? strokeCanvasRect;/,
    'The cursor overlay rectangle must be captured once when the stroke is accepted.',
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
