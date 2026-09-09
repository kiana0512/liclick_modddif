import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, transformWithEsbuild } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, logLevel: 'silent', server: { middlewareMode: true, watch: { ignored: () => true } } });

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
  const single = makeLayer({
    id: 'single',
    order: 0,
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

  assert.equal(
    ordered.shouldMuteLocalRepaintResidentLayer(
      [single, persistedRepaint],
      liveRepaint,
      persistedRepaint.id,
    ),
    false,
    'idle repaint rows stay resident outside live apply feedback',
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

  const repaintOnTop = { ...persistedRepaint, order: 0 };
  const singleBelow = { ...single, order: 1 };
  const needsResident = ordered.shouldWaitForLocalRepaintResidentMaterial;
  const merged = makeLayer({ id: 'merged', type: 'uv', role: 'merged-uv', order: 0 });
  assert.equal(needsResident([merged, persistedRepaint], liveRepaint, liveRepaint.id), false,
    'a repaint below the merged UV boundary has no resident binding to wait for');
  for (const upper of [
    { ...merged, visible: false }, { ...merged, imageUrl: '' },
    { ...merged, objectId: 'other' }, { ...merged, role: 'paint' }, { ...merged, order: 2 },
  ]) {
    assert.equal(needsResident([upper, persistedRepaint], liveRepaint, liveRepaint.id), true,
      'only the actual visible same-object merged UV boundary can remove the wait');
  }
  assert.equal(needsResident([singleBelow], liveRepaint, liveRepaint.id), false,
    'a new topmost preview must not spend 10 seconds waiting for an unpublished row');
  assert.equal(needsResident([single], { ...liveRepaint, order: 1 }, liveRepaint.id), false,
    'ordinary single views must not create an ordered resident wait');
  assert.equal(needsResident([persistedRepaint], undefined, persistedRepaint.id), true,
    'reopening an existing repaint must retain its resident readiness barrier');
  assert.equal(needsResident([{ ...single, objectId: "other" }],
    { ...liveRepaint, order: 1 }, liveRepaint.id), false,
    'an unrelated model must not add a resident wait');
  assert.equal(needsResident([{ ...single, visible: false }],
    { ...liveRepaint, order: 1 }, liveRepaint.id), false,
    'a hidden ordinary projection must not add a resident wait');
  assert.equal(needsResident([single], { ...liveRepaint, order: 1 }, 'other'), false,
    'a different preview cannot satisfy this preparation target');
  assert.equal(
    ordered.shouldMuteLocalRepaintResidentLayer(
      [repaintOnTop, singleBelow],
      { ...liveRepaint, order: 0 },
      repaintOnTop.id,
    ),
    false,
    'a persisted repaint outside apply mode must remain resident for erasing and eye toggles',
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
  // Execute the source-switch handoff predicate, not a reimplementation of it.
  const releaseBlock = viewport.slice(viewport.indexOf('const releasePreviousPreview = async'));
  const readyBody = releaseBlock.match(/ready: \(\) => \{([\s\S]*?)\n {8}\},/);
  assert.ok(readyBody);
  const { isLocalRepaintHandoffForObject } = await server.ssrLoadModule(
    '/src/engine/viewport/localRepaintResidentHandoff.ts',
  );
  const evaluateRelease = new Function('storedLayers', 'isLocalRepaintBelowMergedUv', 'resident',
    'isLocalRepaintHandoffForObject', 'previousRoot', 'nextObjectId', `
    const previousLayerId = 'local-repaint-result';
    const previousOverride = { root: previousRoot, layerId: previousLayerId };
    const useLayerStore = { getState: () => ({ layers: storedLayers }) };
    const isLocalRepaintLayerResident = () => resident;
    const promoteLocalRepaintResidentMaskTexture = () => resident;
    ${readyBody[1]}
  `);
  const canRelease = (layers, policy, resident, previousRoot = { visible: true, userData: {} }, nextObjectId = 'object-a') =>
    evaluateRelease(layers, policy, resident, isLocalRepaintHandoffForObject, previousRoot, nextObjectId);
  assert.equal(canRelease([merged, persistedRepaint], ordered.isLocalRepaintBelowMergedUv, false), true);
  assert.equal(canRelease([persistedRepaint], ordered.isLocalRepaintBelowMergedUv, false), false);
  assert.equal(canRelease([persistedRepaint], ordered.isLocalRepaintBelowMergedUv, true), true);
  assert.equal(canRelease([persistedRepaint], ordered.isLocalRepaintBelowMergedUv, false,
    { visible: false, userData: {} }), true, 'Hidden roots cannot block preview release');
  assert.equal(canRelease([persistedRepaint], ordered.isLocalRepaintBelowMergedUv, false,
    { userData: {} }), false, 'An unspecified visible flag is not an explicitly hidden root');
  assert.equal(canRelease([persistedRepaint], ordered.isLocalRepaintBelowMergedUv, false,
    { visible: true, userData: {} }, 'object-b'), true, 'A previous object cannot block the next object');
  assert.equal(canRelease([{ ...persistedRepaint, objectId: undefined }], ordered.isLocalRepaintBelowMergedUv, false),
    false, 'Legacy unscoped visible roots retain the conservative resident barrier');
  // Current renderer boundary is authoritative, including equal order and global UV rows.
  const boundaryStart = sceneRoot.indexOf('function getVisibleMergedUvBoundaryOrder');
  const boundaryEnd = sceneRoot.indexOf('function useStableValueBySignature', boundaryStart);
  const boundaryJs = (await transformWithEsbuild(
    sceneRoot.slice(boundaryStart, boundaryEnd), 'boundary.ts', { loader: 'ts' },
  )).code;
  const rendererExcludes = new Function('layers', 'target', `${boundaryJs}
    return !isProjectedLayerAboveMergedUv(target, getVisibleMergedUvBoundaryOrder(layers, target.objectId));`);
  for (const uv of [merged, { ...merged, objectId: undefined }, { ...merged, order: 1 },
    { ...merged, visible: false }, { ...merged, imageUrl: '' }, { ...merged, objectId: 'other' },
    { ...merged, role: 'paint' }, { ...merged, order: 2 }]) {
    assert.equal(ordered.isLocalRepaintBelowMergedUv([uv, persistedRepaint], persistedRepaint),
      rendererExcludes([uv, persistedRepaint], persistedRepaint));
  }
  assert.doesNotMatch(sceneRoot, /mergeOrderedLocalRepaintPreview/);
  assert.doesNotMatch(sceneRoot, /getOrderedLocalRepaintPreviewLayer/);
  // Execute the actual viewport wait block with a deterministic frame clock.
  // This catches accidental reintroduction of the 10s wait, beyond policy tests.
  const waitStart = viewport.indexOf('const requiresResidentMaterial =');
  const waitEnd = viewport.indexOf('const readyOverlay =', waitStart);
  assert.ok(waitStart >= 0 && waitEnd > waitStart);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const runResidentWait = new AsyncFunction('layers', 'preview', 'bindAfterMs', 'policy', `
    let elapsed = 0, residentOverrideBound = false;
    const cancelled = false, preparationDeadline = 20000;
    const model = {}, source = {}, sourceKey = 'test';
    const composite = { layerId: preview.id };
    const performance = { now: () => elapsed };
    const document = { body: { dataset: {} } };
    const useLayerStore = { getState: () => ({ layers }) };
    const useSceneStore = { getState: () => ({ localRepaintPreviewLayer: preview }) };
    const shouldWaitForLocalRepaintResidentMaterial = policy;
    const ensureLiveLocalRepaintComposite = () => composite;
    const invalidate = () => {};
    const waitForFrame = async () => { elapsed += 16; };
    const bindLocalRepaintResidentMaskOverride = () => elapsed >= bindAfterMs;
    ${viewport.slice(waitStart, waitEnd)}
    return { elapsed, residentOverrideBound };
  `);
  assert.deepEqual(await runResidentWait([singleBelow], liveRepaint, Infinity, needsResident),
    { elapsed: 0, residentOverrideBound: false }, 'unpublished foreground must have zero resident wait');
  assert.deepEqual(await runResidentWait([persistedRepaint], liveRepaint, 48, needsResident),
    { elapsed: 48, residentOverrideBound: true }, 'saved rows must wait until binding succeeds');
  assert.deepEqual(await runResidentWait([single], { ...liveRepaint, order: 1 }, 64, needsResident),
    { elapsed: 0, residentOverrideBound: false }, 'ordinary single views must not create a binding barrier');
  assert.deepEqual(await runResidentWait([persistedRepaint], liveRepaint, Infinity, needsResident),
    { elapsed: 10000, residentOverrideBound: false }, 'existing target timeout must remain bounded');
  assert.deepEqual(await runResidentWait([merged, persistedRepaint], liveRepaint, Infinity, needsResident),
    { elapsed: 0, residentOverrideBound: false }, 'merged-away targets must not burn the 10s deadline');
  assert.doesNotMatch(
    sceneRoot,
    /previewProjectionInputs\.slice\(liveRepaintIndex\)/,
    'the retired priority stack must not split ordinary projections around a repaint preview',
  );
  assert.match(
    viewport,
    /while \(\s*requiresResidentMaterial && !cancelled &&\s*!residentOverrideBound[\s\S]*?bindLocalRepaintResidentMaskOverride[\s\S]*?ensureLocalRepaintGpuOverlay/,
    'readiness must prepare eligible resident targets and always prepare the exact live overlay before input',
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
  // Replay the production callback across the real report's first-row build gap:
  // apply -> button 1 -> material arrives -> presented handoff -> idle.
  const activityJs = await transformWithEsbuild(residentActivity, 'activity.ts', { loader: 'ts' });
  const sceneState = { paintTool: 'inpaint-apply', displayMode: 'flat', localRepaintPreviewLayer: liveRepaint,
    setLocalRepaintPreviewLayer(value) { this.localRepaintPreviewLayer = value; } };
  const layerState = { layers: [single, persistedRepaint] };
  const overlay = { layerId: persistedRepaint.id, sourceKey: 'source', visible: true };
  const composite = { layerId: persistedRepaint.id, sourceKey: 'source', hasContent: true, restoredMaskReady: true };
  const pendingPresentation = { current: undefined };
  let bound = false;
  let handoffs = 0;
  const scope = {
    useCallback: (fn) => fn, localRepaintGpuOverlayRef: { current: overlay },
    localRepaintCompositeRef: { current: composite },
    localRepaintResidentPresentationLayerRef: pendingPresentation,
    useSceneStore: { getState: () => sceneState }, useLayerStore: { getState: () => layerState },
    isLocalRepaintLayerEraserActive: () => false,
    shouldUseDedicatedLocalRepaintOverlay: ordered.shouldUseDedicatedLocalRepaintOverlay,
    getTargetModel: () => ({}), bindLocalRepaintResidentMaskOverride: () => bound,
    isLocalRepaintOverlayVisible: (mode, visible) => mode === 'flat' && visible,
    readLocalRepaintGpuOverlayLayerVisibility: () => true,
    setLocalRepaintGpuOverlayVisibility: (item, visible) => { item.visible = visible; return true; },
    invalidate() {}, document: { body: { dataset: {} } },
    scheduleLocalRepaintResidentPresentation: (id) => { pendingPresentation.current = id; handoffs++; },
  };
  const syncActivity = new Function(...Object.keys(scope), `${activityJs.code}; return syncLocalRepaintGpuOverlayActivity;`)(...Object.values(scope));
  syncActivity();
  assert.equal(overlay.visible, true);
  for (const tool of ['none', 'inpaint-add', 'inpaint-subtract', 'none']) {
    sceneState.paintTool = tool;
    syncActivity();
    assert.equal(overlay.visible, true, `${tool}: switching tools must retain the only owner until the resident mask binds`);
    assert.equal(handoffs, 0, 'an unfinished material cannot complete the handoff');
  }
  bound = true;
  syncActivity();
  assert.equal(handoffs, 1);
  assert.equal(overlay.visible, true, 'retain the exact overlay during the presentation barrier');
  assert.equal(sceneState.localRepaintPreviewLayer, undefined);
  pendingPresentation.current = undefined;
  syncActivity();
  assert.equal(overlay.visible, false, 'the resident row takes over after presentation');
  sceneState.paintTool = 'inpaint-apply';
  sceneState.localRepaintPreviewLayer = liveRepaint;
  persistedRepaint.visible = false;
  syncActivity();
  assert.equal(overlay.visible, false, 'eye-off still hides the repaint during handoff');
  persistedRepaint.visible = true;
  composite.hasContent = false;
  syncActivity();
  assert.equal(overlay.visible, false, 'an empty restored preview must not replace saved content');
  const ownershipExpression = viewport.match(/const overlayCanOwnPresentation =([\s\S]*?);/)[1];
  const owns = new Function('existingLayer', 'sceneState', 'currentPreviewLayer', 'projectedLayer', 'composite',
    `return (${ownershipExpression});`);
  assert.equal(owns(persistedRepaint, { paintTool: 'none' }, liveRepaint, persistedRepaint, { hasContent: true }), true,
    'reusing the prepared composite must not clear a pending first-row owner');
  assert.equal(owns(persistedRepaint, { paintTool: 'none' }, liveRepaint, persistedRepaint, { hasContent: false }), false);
  assert.equal(owns(persistedRepaint, { paintTool: 'none' }, { id: 'other' }, persistedRepaint, { hasContent: true }), false);
  const gpuPreparation = viewport.slice(viewport.indexOf('const ensureLocalRepaintGpuOverlay = useCallback'),
    viewport.indexOf('const ensureLocalRepaintGpuOverlay = useCallback') + 18000);
  const visibilityGates = [...gpuPreparation.matchAll(/shouldUseDedicatedLocalRepaintOverlay\([\s\S]*?sceneState\.paintTool === 'inpaint-apply'[^\n]*/g)];
  assert.equal(visibilityGates.length, 3, 'cover reuse, resident program rebinding and the visibility listener');
  for (const gate of visibilityGates) {
    const expression = gate[0].split('\n').at(-1).trim().replace(/,$/, '');
    const evaluate = new Function('sceneState', 'previewOwnsOverlay', `return ${expression};`);
    assert.equal(evaluate({ paintTool: 'inpaint-add' }, true), true);
    assert.equal(evaluate({ paintTool: 'none' }, false), false);
  }
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
