import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import * as THREE from 'three';

const sourceRoot = new URL('../src/', import.meta.url);
assert.match(await readFile(new URL('components/localRepaint/LocalRepaintDialog.tsx', sourceRoot), 'utf8'),
  /const DEFAULT_LOCAL_REPAINT_BRUSH_SIZE = 30;/, 'Standalone repaint canvas also defaults to 30');
const [
  sessionLayer,
  generatePanel,
  editorPage,
  viewportCanvas,
  bottomToolDock,
  backgroundPrewarmPolicy,
  sceneStore,
] = await Promise.all([
  readFile(new URL('engine/localRepaint/sessionLayer.ts', sourceRoot), 'utf8'),
  readFile(new URL('components/panels/GeneratePanel.tsx', sourceRoot), 'utf8'),
  readFile(new URL('routes/EditorPage.tsx', sourceRoot), 'utf8'),
  readFile(new URL('engine/viewport/ViewportCanvas.tsx', sourceRoot), 'utf8'),
  readFile(new URL('components/editor/BottomToolDock.tsx', sourceRoot), 'utf8'),
  readFile(new URL('engine/localRepaint/backgroundPrewarmPolicy.ts', sourceRoot), 'utf8'),
  readFile(new URL('stores/sceneStore.ts', sourceRoot), 'utf8'),
]);

assert.match(
  sceneStore,
  /projectionLayerId\?: string/,
  'persisted repaint editing must carry the exact selected row identity',
);
assert.match(
  viewportCanvas,
  /source\.projectionLayerId \?\? ''/,
  'live composite keys must be isolated per selected repaint row',
);
assert.match(
  viewportCanvas,
  /source\.projectionLayerId && source\.projectionLayerId !== layer\.id/,
  'a restored source must not claim another repaint row',
);
assert.match(
  viewportCanvas,
  /projectionLayerId: activePaintLayer\.id/,
  'selecting a persisted repaint must publish its exact row identity',
);
assert.match(
  viewportCanvas,
  /const hotSourceOwnsActiveLayer = Boolean\([\s\S]*?localRepaintCompositeRef\.current\?\.layerId === activePaintLayer\.id[\s\S]*?localRepaintCompositeRef\.current\.sourceKey === currentSourceKey[\s\S]*?currentSource\?\.projectionLayerId === activePaintLayer\.id \|\| hotSourceOwnsActiveLayer/,
  'switching directly from a newly applied repaint to eraser must retain its already prepared runtime source',
);
assert.match(
  editorPage,
  /paintTool === 'inpaint-apply' \|\|\s*paintTool === 'eraser'/,
  'newest-generation background prewarm must not steal an active eraser session',
);

assert.match(sessionLayer, /preserveActiveProjection\?: boolean/);
assert.match(
  sessionLayer,
  /if \(!input\.preserveActiveProjection && !sourceOwnsTarget\)/,
  'passive layer creation must not tear down the visible repaint projection',
);
assert.match(sessionLayer, /preserveActiveLayer\?: boolean/);
assert.match(
  generatePanel,
  /ensureLocalRepaintSessionLayer\(undefined,\s*\{[\s\S]*?preserveActiveProjection: true,[\s\S]*?preserveActiveLayer: true/,
  'starting a generation must retain the visible repaint layer',
);
assert.match(
  generatePanel,
  /ensureLocalRepaintSessionLayer\(completedGeneration\.id,\s*\{[\s\S]*?preserveActiveProjection: true,[\s\S]*?preserveActiveLayer: true/,
  'generation writeback must retain the previous repaint layer',
);
assert.match(
  editorPage,
  /generationId: latestLocalRepaintGeneration\.id,\s*preserveActiveProjection: true,\s*preserveActiveLayer: true/,
  'idle preparation must not steal renderer ownership',
);
assert.match(editorPage, /resolveLocalRepaintBackgroundPrewarmDisposition\(\{/);
assert.match(
  backgroundPrewarmPolicy,
  /pendingGenerationId === nextSource\.generationId[\s\S]*?'stage-latest-generation'[\s\S]*?'preserve-current-source'/,
  'only a newly completed result may take renderer ownership from the visible repaint source',
);
assert.match(
  sessionLayer,
  /!item\.generationId && !item\.imageUrl && !claimedTargetIds\.has\(item\.id\)/,
  'an empty target already owned by an in-flight generation must not be rebound',
);
assert.match(
  viewportCanvas,
  /localRepaintProjectedPublishRequestsRef = useRef\(\s*new Map<string, \(\) => Promise<void>>\(\)/,
  'deferred repaint publication must keep one request slot per source',
);
assert.match(
  viewportCanvas,
  /localRepaintProjectedPublishRevisionsRef\.current\.get\(publishSourceKey\)/,
  'latest-wins cancellation must be scoped to the current source',
);
assert.doesNotMatch(
  viewportCanvas,
  /localRepaintProjectedPublishRequestRef\b/,
  'a component-wide request slot can cancel an unrelated in-flight repaint task',
);
assert.match(
  viewportCanvas,
  /activeLayerIdBeforePublish = existingProjectionLayer[\s\S]*?layerState\.setLayers\(nextLayers\);[\s\S]*?if \(existingProjectionLayer\) \{\s*restoreLocalRepaintLayerSelection\(activeLayerIdBeforePublish\)/,
  'a newly published repaint must become active while background refreshes preserve the current selection',
);
assert.match(
  viewportCanvas,
  /const exactOverlayVisible =[\s\S]*?liveFeedbackRequested[\s\S]*?setLocalRepaintGpuOverlayVisibility\(overlay, exactOverlayVisible, layers\)/,
  'the exact overlay must own interactive apply feedback and hand off outside that phase',
);
assert.ok(
  (viewportCanvas.match(/const previewOwnsOverlay =/g) ?? []).length >= 4,
  'every overlay activation and resident-rebind path must preserve renderer ownership',
);
assert.match(
  viewportCanvas,
  /syncLocalRepaintGpuOverlayBinding\(currentOverlay, \{[\s\S]*?composite\.hasContent &&[\s\S]*?previewOwnsOverlay \|\|[\s\S]*?!hasPersistedLayer/,
  'reusing a resident GPU program must not hide the owning repaint layer',
);
assert.match(
  viewportCanvas,
  /previewOwnsComposite\s*&&\s*\(sceneStateAtCommit\.paintTool === 'none'[\s\S]*?sceneStateAtCommit\.paintTool === 'inpaint-add'[\s\S]*?sceneStateAtCommit\.paintTool === 'inpaint-subtract'/,
  'a deferred publish must not fade the repaint while the mask tool is toggled closed',
);
assert.match(
  viewportCanvas,
  /sceneState\.paintTool === 'inpaint-apply' \|\|\s*sceneState\.paintTool === 'none' \|\|\s*stillEditingLocalRepaintMask/,
  'the completed repaint composite must stay warm after a second mask-button click',
);
assert.match(
  bottomToolDock,
  /if \(!isMaskPaintTool\) \{\s*onPaintToolChange\('inpaint-add'\)/,
  'the mask button must select the mask tool idempotently',
);
assert.doesNotMatch(
  bottomToolDock,
  /onPaintToolChange\(willSelectMaskTool \? 'inpaint-add' : 'none'\)/,
  'a repeated mask-button click must not unload the active repaint presentation',
);

const sceneRoot = await readFile(new URL('engine/viewport/SceneRoot.tsx', sourceRoot), 'utf8');
const idleGate = sceneRoot.slice(
  sceneRoot.indexOf('const isViewportInteractionBusy = () =>'),
  sceneRoot.indexOf('const precompileProjectedMaterial ='),
);
assert.doesNotMatch(
  idleGate,
  /paintTool === 'inpaint-(?:add|subtract)'/,
  'a selected mask brush must not starve resident publication while the pointer is idle',
);
assert.match(
  idleGate,
  /isSharedViewportInteractionBusy\(\)/,
  'actual pointer interactions must still defer uploads and compilation',
);
assert.match(
  viewportCanvas,
  /await releasePreviousPreview\(\)/,
  'switching sources must wait for the old layer to become resident',
);
assert.match(
  viewportCanvas,
  /previousOverride\?\.sourceKey \?\? previousOverlay\?\.sourceKey[\s\S]*?await releasePreviousPreview\(\)/,
  'switching repaint sources must hand off a resident override even when no fallback overlay exists',
);
assert.match(
  viewportCanvas,
  /releasePreviousPreview\(\)\.then/,
  'clearing a source must also wait for resident handoff',
);

const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } },
});
try {
  const { ensureLocalRepaintSessionLayer, restoreLocalRepaintLayerSelection } = await server.ssrLoadModule(
    '/src/engine/localRepaint/sessionLayer.ts',
  );
  const { useLayerStore } = await server.ssrLoadModule('/src/stores/layerStore.ts');
  const { useSceneStore } = await server.ssrLoadModule('/src/stores/sceneStore.ts');
  const initialBrushState = useSceneStore.getState();
  assert.equal(initialBrushState.paintMaskSettings.brushSize, 45);
  assert.equal(initialBrushState.localRepaintBrushSettings.brushSize, 30);
  assert.equal(initialBrushState.paintToolSettings.brushSize, 32);
  assert.equal(initialBrushState.paintToolSettings.eraserSize, 42);
  initialBrushState.setPaintMaskSettings({ brushSize: 20 });
  assert.equal(useSceneStore.getState().paintMaskSettings.brushSize, 20);
  assert.equal(useSceneStore.getState().localRepaintBrushSettings.brushSize, 30);
  initialBrushState.setLocalRepaintBrushSettings({ brushSize: 24 });
  assert.equal(useSceneStore.getState().localRepaintBrushSettings.brushSize, 24,
    'Default 30 must not override later user adjustments');
  initialBrushState.setLocalRepaintBrushSettings({ brushSize: 30 });
  initialBrushState.setPaintMaskSettings({ brushSize: 45 });
  const uvRow = useLayerStore.getState().addEmptyLayer({ objectId: 'selection-model' });
  const projectionRow = { ...uvRow, id: 'hidden-projection', type: 'projected', visible: false };
  for (const selectedId of [uvRow.id, projectionRow.id, undefined]) {
    useLayerStore.setState({ layers: [uvRow, projectionRow], activeProjectedLayerId: selectedId });
    const first = ensureLocalRepaintSessionLayer({ objectId: 'selection-model', generationId: 'selection-generation' });
    assert.equal(useLayerStore.getState().activeProjectedLayerId, selectedId,
      'creating an internal repaint target must preserve UV, hidden projection, and empty selection');
    assert.notEqual(first.layer.id, uvRow.id);
    assert.notEqual(first.layer.id, projectionRow.id);
    const reused = ensureLocalRepaintSessionLayer({ objectId: 'selection-model', generationId: 'selection-generation' });
    assert.equal(reused.layer.id, first.layer.id);
    assert.equal(useLayerStore.getState().activeProjectedLayerId, selectedId,
      'reusing the same generation must not select its hidden target');
    useLayerStore.getState().setLayers(useLayerStore.getState().layers);
    restoreLocalRepaintLayerSelection(selectedId);
    assert.equal(useLayerStore.getState().activeProjectedLayerId, selectedId,
      'the selection-restoration helper must preserve an empty selection too');
  }
  const previousRow = { ...uvRow, id: 'previous-visible-row', visible: true };
  const newRepaintRow = { ...uvRow, id: 'new-visible-repaint-row', type: 'projected', visible: true };
  useLayerStore.setState({ layers: [previousRow], activeProjectedLayerId: previousRow.id });
  useLayerStore.getState().setLayers([newRepaintRow, previousRow]);
  assert.equal(
    useLayerStore.getState().activeProjectedLayerId,
    newRepaintRow.id,
    'publishing a new repaint first in the visible layer stack must select it',
  );
  const guard = viewportCanvas.match(/if \(([^\n]+)\) \{\s*warnMissingPaintLayer\(\);\s*return;/)?.[1];
  assert.ok(guard, 'test the actual pointer-down layer guard');
  const maskStrokeDeclaration = viewportCanvas.match(/const isMaskStroke = isInpaintMode \|\| isLocalRepaintApplyMode;/)?.[0];
  assert.ok(maskStrokeDeclaration);
  const blocksStroke = new Function('isInpaintMode', 'isLocalRepaintApplyMode', 'canUseSurfacePaint', `${maskStrokeDeclaration}\nreturn ${guard}`);
  assert.equal(blocksStroke(false, true, false), false, 'repaint bypasses ordinary layer selection requirements');
  assert.equal(blocksStroke(true, false, false), false, 'mask authoring remains independent');
  assert.equal(blocksStroke(false, false, false), true, 'ordinary brush/eraser still require an eligible layer');
  assert.equal(blocksStroke(false, false, true), false);
  const {
    getTransientLocalRepaintLayerId,
    isLocalRepaintHandoffForObject,
    isLocalRepaintLayerResident,
    waitForLocalRepaintResidentHandoff,
  } = await server.ssrLoadModule('/src/engine/viewport/localRepaintResidentHandoff.ts');
  const { createProjectedLayerMaterial, syncProjectedLayerResidentMaskTextureInObject } = await server.ssrLoadModule(
    '/src/engine/projection/ProjectedLayerMaterial.ts',
  );
  const { registerLiveProjectedCanvasTexture } = await server.ssrLoadModule(
    '/src/engine/projection/liveProjectedCanvasTextureRegistry.ts',
  );
  const sourceUrl = registerLiveProjectedCanvasTexture('handoff-source-test', { width: 2, height: 2 });
  const maskUrl = registerLiveProjectedCanvasTexture('handoff-mask-test', { width: 2, height: 2 });
  const cameraMatrix = new THREE.Matrix4().toArray();
  const singleMaterial = await createProjectedLayerMaterial({
    layerId: 'single-repaint', imageUrl: sourceUrl, maskUrl, objectId: 'model',
    camera: { position: [0, 0, 2], projectionMatrix: cameraMatrix, viewMatrix: cameraMatrix, matrixWorld: cameraMatrix },
    opacity: 1, visible: true, depthTest: true, useMask: true,
  });
  const singleRoot = new THREE.Group();
  singleRoot.add(new THREE.Mesh(new THREE.BoxGeometry(), singleMaterial));
  const replacementMask = new THREE.Texture();
  assert.equal(syncProjectedLayerResidentMaskTextureInObject(
    singleRoot, 'single-repaint', maskUrl, replacementMask,
  ).bound, true, 'the real single-layer factory must permit immediate resident handoff');
  assert.equal(singleMaterial.uniforms.maskMap.value, replacementMask);
  assert.equal(syncProjectedLayerResidentMaskTextureInObject(
    singleRoot, 'single-repaint', 'wrong-mask', replacementMask,
  ).bound, false, 'mask identity must remain checked');
  for (const flag of ['liclickViewportHelper', 'liclickSelectionGlow', 'liclickWireframeOverlay']) {
    const helper = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    helper.userData[flag] = true;
    singleRoot.add(helper);
    assert.equal(isLocalRepaintLayerResident(singleRoot, 'single-repaint'), true,
      `${flag} must not keep a ready model pending forever`);
  }
  assert.equal(getTransientLocalRepaintLayerId('A', []), 'A');
  assert.equal(
    getTransientLocalRepaintLayerId('A', [{ id: 'A', contentRevision: 1 }]),
    undefined,
    'first published row must become resident even when the live marker still has no revision',
  );
  assert.equal(getTransientLocalRepaintLayerId('B', [{ id: 'A' }]), 'B');
  assert.equal(getTransientLocalRepaintLayerId(undefined, [{ id: 'A' }]), undefined);
  assert.equal(isLocalRepaintHandoffForObject('model-a', 'model-a'), true);
  assert.equal(
    isLocalRepaintHandoffForObject('model-a', 'model-b'),
    false,
    'a stale preview from another object must not block the next repaint session',
  );
  assert.equal(
    isLocalRepaintHandoffForObject(undefined, 'model-b'),
    true,
    'legacy unscoped layers must retain the conservative same-object handoff',
  );

  const group = new THREE.Group();
  const material = new THREE.ShaderMaterial();
  const geometry = new THREE.BoxGeometry();
  const body = new THREE.Mesh(geometry, material);
  group.add(body);
  assert.equal(isLocalRepaintLayerResident(group, 'A'), false);
  material.userData.liclickProjectedLayerStackState = { bindings: [{ layerId: 'A' }] };
  const overlay = new THREE.Mesh(geometry, new THREE.ShaderMaterial());
  overlay.userData.liclickPaintOverlay = true;
  group.add(overlay);
  assert.equal(
    isLocalRepaintLayerResident(group, 'A'),
    true,
    'transparent twin must not count as a background mesh',
  );
  assert.equal(isLocalRepaintLayerResident(group, 'B'), false);
  const secondMesh = new THREE.Mesh(geometry, overlay.material);
  group.add(secondMesh);
  assert.equal(
    isLocalRepaintLayerResident(group, 'A'),
    false,
    'partially assigned materials cannot release the old overlay',
  );
  secondMesh.removeFromParent();
  material.userData.liclickDisposedMaterial = true;
  assert.equal(isLocalRepaintLayerResident(group, 'A'), false);
  assert.equal(isLocalRepaintLayerResident(new THREE.Group(), 'A'), false);

  const residentGroup = new THREE.Group();
  const residentMaterial = new THREE.ShaderMaterial({
    uniforms: { maskMap0: { value: new THREE.Texture() } },
  });
  residentMaterial.userData.liclickProjectedLayerStackState = {
    bindings: [
      {
        layerId: 'older-repaint',
        maskUrl: 'liclick-live-projected-canvas:older-repaint:inward-crossfade',
        maskMapUniform: 'maskMap0',
      },
    ],
  };
  residentGroup.add(new THREE.Mesh(new THREE.BoxGeometry(), residentMaterial));
  const latestMaskTexture = new THREE.Texture();
  const residentPromotion = syncProjectedLayerResidentMaskTextureInObject(
    residentGroup,
    'older-repaint',
    'liclick-live-projected-canvas:older-repaint:inward-crossfade',
    latestMaskTexture,
  );
  assert.equal(residentPromotion.bound, true);
  assert.equal(
    residentMaterial.uniforms.maskMap0.value,
    latestMaskTexture,
    'an older repaint must retain its own latest erased mask after the shared preview moves on',
  );
  residentMaterial.userData.liclickProjectedLayerStackState.bindings[0].maskMapUniform = undefined;
  assert.equal(
    syncProjectedLayerResidentMaskTextureInObject(
      residentGroup,
      'older-repaint',
      'liclick-live-projected-canvas:older-repaint:inward-crossfade',
      latestMaskTexture,
    ).bound,
    false,
    'an array-backed stale mask must not be mistaken for a completed resident handoff',
  );

  let frames = 0;
  let now = 0;
  const input = {
    ready: () => frames >= 3,
    cancelled: () => false,
    now: () => now,
    nextFrame: async () => {
      frames += 1;
      now += 16;
    },
  };
  assert.equal(await waitForLocalRepaintResidentHandoff(input), true);
  assert.equal(frames, 3, 'pending handoff must yield frames instead of busy-spinning');
  frames = 0;
  assert.equal(
    await waitForLocalRepaintResidentHandoff({ ...input, cancelled: () => true }),
    false,
  );
  assert.equal(frames, 0, 'superseded source must not wait or publish');
  assert.equal(
    await waitForLocalRepaintResidentHandoff({
      ...input,
      ready: () => false,
      cancelled: () => frames >= 1,
    }),
    false,
  );
  frames = 0;
  assert.equal(
    await waitForLocalRepaintResidentHandoff({
      ...input,
      ready: () => false,
      nextFrame: async () => {
        frames += 1;
        now += 5000;
      },
    }),
    false,
  );
  assert.equal(
    frames,
    2,
    'failed material preparation must time out without blanking the old layer',
  );
  geometry.dispose();
  material.dispose();
  overlay.material.dispose();
} finally {
  await server.close();
}
console.log('Local repaint layer retention regression checks passed.');
