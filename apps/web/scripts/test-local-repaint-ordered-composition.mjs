import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, logLevel: 'silent', server: { middlewareMode: true } });

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const camera = {
  type: 'perspective',
  projection: 'perspective',
  position: [0, 0, 3],
  quaternion: [0, 0, 0, 1],
  target: [0, 0, 0],
  near: 0.1,
  far: 100,
  fov: 45,
  zoom: 1,
  projectionMatrix: identity,
  matrixWorld: identity,
  viewMatrix: identity,
  aspect: 1,
};

const makeLayer = (overrides) => ({
  id: 'layer',
  name: 'Layer',
  type: 'projected',
  imageUrl: 'memory://layer',
  objectId: 'object-a',
  camera,
  visible: true,
  opacity: 1,
  strength: 1,
  blendMode: 'normal',
  order: 0,
  createdAt: '2026-08-22T00:00:00.000Z',
  ...overrides,
});

try {
  const ordered = await server.ssrLoadModule(
    '/src/engine/localRepaint/orderedPreviewComposition.ts',
  );
  const priority = await server.ssrLoadModule(
    '/src/engine/projection/priorityProjectionComposition.ts',
  );

  const single = makeLayer({
    id: 'single',
    order: 0,
    projectionCompositeMode: 'single-view-priority-v1',
  });
  const persistedRepaint = makeLayer({
    id: 'local-repaint-result',
    imageUrl: 'memory://saved-repaint',
    maskUrl: 'memory://saved-mask',
    replacementTargetLayerId: 'local-repaint-draft',
    order: 1,
    opacity: 0.7,
  });
  const liveRepaint = makeLayer({
    ...persistedRepaint,
    imageUrl: 'surface-edit:local-repaint:preview',
    maskUrl: 'surface-edit:local-repaint:mask',
    order: 0,
    opacity: 1,
  });

  const resolved = ordered.resolveLocalRepaintPreviewPresentation(liveRepaint, [
    single,
    persistedRepaint,
  ]);
  assert.equal(resolved.order, 1, 'persisted panel order must control the live preview');
  assert.equal(resolved.opacity, 0.7, 'persisted presentation must control the live preview');
  assert.equal(resolved.maskUrl, liveRepaint.maskUrl, 'live mutable mask must remain bound');
  assert.equal(
    ordered.shouldPresentLocalRepaintInOrderedStack([single, persistedRepaint], liveRepaint),
    true,
    'a visible priority single-view above repaint must disable the always-on-top fast path',
  );
  assert.equal(
    ordered.shouldMuteLocalRepaintResidentLayer(
      [single, persistedRepaint],
      liveRepaint,
      persistedRepaint.id,
    ),
    false,
    'ordered-stack ownership must keep the resident repaint binding visible',
  );
  assert.equal(
    ordered.shouldUseDedicatedLocalRepaintOverlay(
      [single, persistedRepaint],
      liveRepaint,
      true,
    ),
    true,
    'the precompiled exact overlay must own frame-by-frame apply feedback',
  );
  assert.equal(
    ordered.shouldMuteLocalRepaintResidentLayer(
      [single, persistedRepaint],
      liveRepaint,
      persistedRepaint.id,
      true,
    ),
    true,
    'the resident twin must be muted while the exact live overlay owns apply feedback',
  );

  const bottomUp = ordered.mergeOrderedLocalRepaintPreview(
    [single, persistedRepaint],
    resolved,
  );
  assert.deepEqual(
    bottomUp.map((layer) => layer.id),
    ['local-repaint-result', 'single'],
    'ordered renderer inputs must evaluate the lower repaint before the upper single-view',
  );

  const repaintOnTop = { ...persistedRepaint, order: 0 };
  const singleBelow = { ...single, order: 1 };
  assert.equal(
    ordered.shouldPresentLocalRepaintInOrderedStack([repaintOnTop, singleBelow], {
      ...liveRepaint,
      order: 0,
    }),
    false,
    'moving repaint above the single-view must restore the clear low-latency foreground path',
  );
  assert.equal(
    ordered.shouldMuteLocalRepaintResidentLayer(
      [repaintOnTop, singleBelow],
      { ...liveRepaint, order: 0 },
      repaintOnTop.id,
    ),
    true,
    'the fast exact overlay must mute its resident twin outside ordered-stack presentation',
  );
  assert.equal(
    ordered.shouldMuteLocalRepaintResidentLayer(
      [single, persistedRepaint],
      liveRepaint,
      'another-layer',
    ),
    false,
    'preview ownership must never mute an unrelated resident layer',
  );
  assert.equal(
    ordered.shouldPresentLocalRepaintInOrderedStack(
      [{ ...single, visible: false }, persistedRepaint],
      liveRepaint,
    ),
    false,
    'a hidden upper single-view must not suppress the repaint fast path',
  );
  assert.equal(
    ordered.shouldPresentLocalRepaintInOrderedStack(
      [{ ...single, objectId: 'object-b' }, persistedRepaint],
      liveRepaint,
    ),
    false,
    'layers from another object must not affect repaint presentation',
  );

  const over = (source, alpha, destination) => source * alpha + destination * (1 - alpha);
  const repaintColor = 0.85;
  const singleColor = 0.2;
  const coreAlpha = priority.getPriorityProjectionAlpha(0.95, 0.95);
  const edgeAlpha = priority.getPriorityProjectionAlpha(0.3, 0.08);
  const singleAboveCore = over(singleColor, coreAlpha, repaintColor);
  const localAboveCore = over(repaintColor, 1, over(singleColor, coreAlpha, 0));
  const singleAboveEdge = over(singleColor, edgeAlpha, repaintColor);
  assert(Math.abs(singleAboveCore - singleColor) < 0.01, 'single-view core must cover repaint');
  assert.equal(localAboveCore, repaintColor, 'repaint above single-view must remain clear');
  assert(
    singleAboveEdge > singleColor && singleAboveEdge < repaintColor,
    'single-view feather must attenuate and blend the repaint underneath',
  );

  const sceneRoot = readFileSync(
    new URL('../src/engine/viewport/SceneRoot.tsx', import.meta.url),
    'utf8',
  );
  const viewport = readFileSync(
    new URL('../src/engine/viewport/ViewportCanvas.tsx', import.meta.url),
    'utf8',
  );
  const projectedMaterial = readFileSync(
    new URL('../src/engine/projection/ProjectedLayerMaterial.ts', import.meta.url),
    'utf8',
  );
  assert.match(sceneRoot, /mergeOrderedLocalRepaintPreview/);
  assert.match(sceneRoot, /getOrderedLocalRepaintPreviewLayer/);
  assert.match(
    sceneRoot,
    /previewProjectionInputs\.slice\(liveRepaintIndex\)/,
    'ordered live repaint must retain every upper layer in its foreground suffix',
  );
  assert.match(
    viewport,
    /while \(!cancelled && !residentOverrideBound[\s\S]*?bindLocalRepaintResidentMaskOverride[\s\S]*?ensureLocalRepaintGpuOverlay/,
    'readiness must prepare the resident handoff and the exact live overlay before input',
  );
  assert.match(
    viewport,
    /liclick:projected-material-resident[\s\S]*?syncLocalRepaintGpuOverlayActivity/,
    'the first-row handoff must retry its live-mask binding after the final material commits',
  );
  const residentActivityStart = viewport.indexOf(
    'const syncLocalRepaintGpuOverlayActivity = useCallback',
  );
  const residentActivityEnd = viewport.indexOf(
    'syncLocalRepaintGpuOverlayActivityRef.current',
    residentActivityStart,
  );
  const residentActivity = viewport.slice(residentActivityStart, residentActivityEnd);
  const residentBindingActivity = residentActivity.slice(
    residentActivity.indexOf('const residentOverrideBound = Boolean('),
    residentActivity.indexOf('let changed = false;'),
  );
  assert.match(
    residentActivity,
    /const presentationLayer = persistedLayer \?\? livePreviewLayer;[\s\S]*?presentationLayer\?\.visible[\s\S]*?bindLocalRepaintResidentMaskOverride/,
    'a late material replacement must rebind the empty transient preview before the first stroke',
  );
  assert.doesNotMatch(
    residentBindingActivity,
    /composite\.hasContent/,
    'resident rebinding must not wait for pointer-up to turn the first empty preview into a persisted row',
  );
  assert.match(
    residentActivity,
    /const exactOverlayVisible =[\s\S]*?liveFeedbackRequested[\s\S]*?setLocalRepaintGpuOverlayVisibility/,
    'apply feedback must activate the precompiled overlay on the first accepted stamp',
  );
  assert.match(
    viewport,
    /composite\.blendMaskTexture\.needsUpdate = true;[\s\S]*?syncLocalRepaintGpuOverlayActivity\(\);/,
    'the first mask stamp must upload before the exact overlay becomes visible',
  );
  assert.match(viewport, /phase: 'verifying-render-frame'/);
  assert.match(
    sceneRoot,
    /window\.dispatchEvent\([\s\S]*?liclick:projected-material-resident/,
    'SceneRoot must announce the exact point at which a rebuilt projected material is resident',
  );
  assert.match(
    viewport,
    /isLocalRepaintLayerResident\(override\.root, override\.layerId\)[\s\S]*?clearLocalRepaintResidentMaskOverride\(\)/,
    'leaving apply mode must release the live mask only after the formal layer is resident',
  );
  assert.doesNotMatch(
    viewport,
    /liveLocalRepaintFastPreview|fastPreviewVisible|fastPreviewCanRender/,
    'the depthless duplicate-mesh preview must stay out of the renderer path',
  );
  const pointerHandlerStart = viewport.indexOf(
    'const handlePointerDown = (event: globalThis.PointerEvent) =>',
  );
  const pointerStart = viewport.indexOf(
    'const paintStartedAt = performance.now()',
    pointerHandlerStart,
  );
  const pointerEnd = viewport.indexOf('isPaintingRef.current = true', pointerStart);
  assert.ok(pointerStart >= 0 && pointerEnd > pointerStart);
  assert.doesNotMatch(
    viewport.slice(pointerStart, pointerEnd),
    /bindLocalRepaintResidentMaskOverride|ensureLocalRepaintGpuOverlay/,
    'pointer-down may request session recovery but must never repair GPU resources itself',
  );
  assert.match(projectedMaterial, /uniform float liveMaskUsesProjection/);
  assert.match(
    projectedMaterial,
    /syncProjectedLayerLiveMaskOverrideInObject[\s\S]*?const nextMode = enabled \? 1 : 0[\s\S]*?liveMaskUsesProjection\.value = nextMode/,
    'resident materials must switch the reserved live mask to projection-space replacement mode',
  );
  assert.match(
    projectedMaterial,
    /maskAlpha = mix\(maskAlpha, liveMaskAlpha, liveMaskActive\)/,
    'the shared stack shader must replace only the selected layer mask',
  );
  assert.match(
    sceneRoot,
    /authoritativeMutedPreviewLayerId[\s\S]*?shouldMuteLocalRepaintResidentLayer/,
    'late display synchronization must not mute a row merely because a preview id exists',
  );
  assert.match(
    sceneRoot,
    /visibleProjectedContentChanged[\s\S]*?previousLayer\.contentRevision !== layer\.contentRevision[\s\S]*?requiresMaterialReconciliation = true/,
    'durable projected content revisions must still rebuild the formal presentation',
  );
  assert.match(
    viewport,
    /contentRevision:\s*existingProjectionLayer\?\.contentRevision \?\? 0/,
    'interactive repaint commits must retain their structural revision and avoid a full stack rebuild',
  );
  assert.match(
    viewport,
    /residentLayer\.maskUrl !== liveMaskComposite\.blendMaskUrl[\s\S]*?切换实时蒙版通道[\s\S]*?maskUrl: liveMaskComposite\.blendMaskUrl[\s\S]*?localRepaintMaskUrl: liveMaskComposite\.maskUrl/,
    'durable masks must move to their stable live URLs during prewarm instead of on first pointer-up',
  );
  assert.doesNotMatch(
    viewport,
    /contentRevision:\s*\(existingProjectionLayer\?\.contentRevision \?\? 0\) \+ 1/,
    'pointer-up must not invalidate the projected material structure',
  );

  console.log('Local repaint ordered composition invariants passed.');
} finally {
  await server.close();
}
