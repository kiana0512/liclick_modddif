import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [
  panel,
  dock,
  editor,
  viewport,
  workflow,
  home,
  asset,
  app,
  serverInpaint,
  backgroundPrewarmPolicy,
  activationRequestPolicy,
  globals,
  interactiveState,
  sceneStore,
] = await Promise.all([
  read('../src/components/panels/GeneratePanel.tsx'),
  read('../src/components/editor/BottomToolDock.tsx'),
  read('../src/routes/EditorPage.tsx'),
  read('../src/engine/viewport/ViewportCanvas.tsx'),
  read('../src/features/workflow/WorkflowModuleSwitcher.tsx'),
  read('../src/routes/HomePage.tsx'),
  read('../src/routes/AssetProcessingPage.tsx'),
  read('../src/App.tsx'),
  read('../../server/src/services/modelviewInpaintService.ts'),
  read('../src/engine/localRepaint/backgroundPrewarmPolicy.ts'),
  read('../src/engine/localRepaint/activationRequestPolicy.ts'),
  read('../src/styles/globals.css'),
  read('../src/engine/localRepaint/localRepaintInteractiveState.ts'),
  read('../src/stores/sceneStore.ts'),
]);

assert.doesNotMatch(panel, /createFullFrameMaskDataUrl/);
assert.doesNotMatch(panel, /full-frame-default/);
assert.match(panel, /local-repaint-mask-required/);
assert.match(panel, /onLocalImageGenerationSettled/);
assert.doesNotMatch(panel, /GPU 纹理准备失败/);
assert.match(panel, /displayedTexturePreviewMode/);
assert.match(panel, /createModelviewApiClient\(\)\.generateInpaint\(/);
assert.match(panel, /image: \{ path: 'current-effect\.png'/);
assert.match(
  panel,
  /materialImage: \{[\s\S]*path: `\$\{generationId\}-\$\{materialReference!\.id\}-material-reference\.png`/,
);
assert.match(panel, /mask: \{ path: `\$\{generationId\}-mask\.png`, dataUrl: maskDataUrl \}/);
assert.match(panel, /const \[currentEffectDataUrl, materialReferenceDataUrl, maskDataUrl\]/);
assert.match(panel, /prompt: effectivePrompt/);
assert.match(panel, /prepareLocalRepaintGenerationInput\(\{/);
assert.match(panel, /currentEffectUrl: flatCurrentEffectUrl/);
assert.match(panel, /clayPreviewUrl/);
assert.match(panel, /authoredMaskUrl: currentPaintMaskDataUrl/);
assert.match(panel, /urlToDataUrl\(preparedGenerationInput\.submittedMaskUrl\)/);
assert.match(
  panel,
  /prepareLocalRepaintPromptPolishInputs\(\{[\s\S]*?currentEffectUrl: promptAnalysisCurrentEffectUrl,[\s\S]*?maskUrl: currentPaintMaskDataUrl/,
);
assert.match(panel, /generations\.find\([\s\S]*?metadata\.promptFingerprint === promptFingerprint/);
assert.match(panel, /生成时优化提示词/);
assert.doesNotMatch(panel, /生成时自动分析并优化|留空则自动分析/);
assert.match(
  panel,
  /maxLength=\{[\s\S]*?isLocalRepaintTab \|\|[\s\S]*?singleViewProvider === 'remote'\)[\s\S]*?\? 4096[\s\S]*?: undefined[\s\S]*?\}/,
);
assert.doesNotMatch(panel, /viewportReference: \{/);
assert.doesNotMatch(serverInpaint, /input\.viewportReference/);
assert.doesNotMatch(serverInpaint, /field: 'viewport_reference'/);
assert.match(serverInpaint, /field: 'image' \| 'material_image' \| 'mask'/);
assert.match(serverInpaint, /inpaint:4input-rseed-r1/);
assert.match(panel, /resultComposition: 'direct-v1'/);
assert.match(panel, /cancelledTextureBatchIdsRef/);
assert.match(panel, /generationBelongsToObject/);

assert.match(dock, /localImageGenerationSuccessKey/);
assert.match(dock, /guideWorkflowButton/);
assert.match(editor, /localImageGenerationRequested \|\| localImageGenerationStoreRunning/);
assert.match(
  editor,
  /pendingLocalRepaintBackgroundGenerationIdRef\.current = result\.generationId/,
);
assert.match(
  editor,
  /pendingLocalRepaintBackgroundGenerationIdRef\.current !== latestLocalRepaintGeneration\.id[\s\S]*?return undefined;/,
  'persisted local repaint generations must not restart speculative GPU preparation on every model or workspace switch',
);
assert.match(editor, /resolveLocalRepaintBackgroundPrewarmDisposition\(\{/);
assert.match(backgroundPrewarmPolicy, /pendingGenerationId === nextSource\.generationId/);
assert.match(backgroundPrewarmPolicy, /'preserve-current-source'/);
assert.match(editor, /createLocalRepaintActivationRequest\(\{/);
assert.match(editor, /'replayed-after-gpu-ready'/);
assert.match(editor, /requestLocalRepaintGpuPrepare\(\)/);
assert.match(editor, /'renderer-retry'/);
assert.doesNotMatch(editor, /LOCAL_REPAINT_ACTIVATION_WATCHDOG_MS/);
assert.doesNotMatch(editor, /watchdog-released/);
assert.match(sceneStore, /localRepaintGpuPrepareRevision/);
assert.match(sceneStore, /requestLocalRepaintGpuPrepare/);
assert.match(viewport, /localRepaintGpuPrepareRevision/);
assert.match(editor, /localRepaintGenerationReady && localRepaintInteractiveReady/);
assert.doesNotMatch(editor, /localRepaintInteractiveWaitersRef/);
assert.doesNotMatch(editor, /local-repaint-interactive-ready-timeout/);
assert.match(editor, /queueMicrotask\(\(\) => \{/);
assert.match(editor, /'background-prewarm-queued'/);
assert.doesNotMatch(
  editor,
  /while \([\s\S]{0,240}!isGpuReady\(\)[\s\S]{0,240}requestAnimationFrame/,
);
assert.match(viewport, /publishLocalRepaintInteractiveState\(\{/);
assert.match(interactiveState, /'liclick:local-repaint-interactive-state'/);
assert.match(interactiveState, /LocalRepaintSessionPhase/);
assert.match(interactiveState, /current\?\.sessionId !== update\.sessionId/);
assert.doesNotMatch(
  editor,
  /localRepaintGpuReadyGeneration === generationId/,
  'button readiness must come from the session owner, not DOM diagnostics',
);

const compiledInteractiveState = ts.transpileModule(interactiveState, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const interactiveStateModule = await import(
  `data:text/javascript;base64,${Buffer.from(compiledInteractiveState).toString('base64')}`
);
const firstSession = interactiveStateModule.beginLocalRepaintSession({
  generationId: 'generation-1',
  targetLayerId: 'target-1',
});
const secondSession = interactiveStateModule.beginLocalRepaintSession({
  generationId: 'generation-2',
  targetLayerId: 'target-2',
});
assert.equal(
  interactiveStateModule.publishLocalRepaintInteractiveState({
    sessionId: firstSession.sessionId,
    generationId: 'generation-1',
    targetLayerId: 'target-1',
    status: 'ready',
  }),
  false,
  'a stale async task must not publish readiness into the current session',
);
assert.equal(
  interactiveStateModule.getLocalRepaintSessionSnapshot().sessionId,
  secondSession.sessionId,
);
assert.equal(
  interactiveStateModule.publishLocalRepaintInteractiveState({
    sessionId: secondSession.sessionId,
    generationId: 'generation-2',
    targetLayerId: 'target-2',
    status: 'ready',
    phase: 'ready',
  }),
  true,
);
assert.equal(interactiveStateModule.getLocalRepaintSessionSnapshot().status, 'ready');
const preparingSession = interactiveStateModule.beginLocalRepaintSession({
  generationId: 'generation-preparing', targetLayerId: 'target-preparing',
});
const isPreparing = () => interactiveStateModule.isLocalRepaintPreparationInFlight(
  'generation-preparing', 'target-preparing',
);
assert.equal(isPreparing(), false, 'an abandoned preparing snapshot must allow a retry');
const finishDecode = interactiveStateModule.trackLocalRepaintPreparation(preparingSession.sessionId);
const finishGpu = interactiveStateModule.trackLocalRepaintPreparation(preparingSession.sessionId);
interactiveStateModule.requestLocalRepaintSessionActivation('generation-preparing', 'target-preparing');
assert.equal(isPreparing(), true, 'clicking must join active background preparation');
assert.equal(interactiveStateModule.isLocalRepaintPreparationInFlight('generation-preparing', 'other'), false);
finishDecode();
finishDecode();
assert.equal(isPreparing(), true, 'decode cleanup must not release the overlapping GPU task');
finishGpu();
assert.equal(isPreparing(), false, 'cancelled effects must allow an immediate renderer retry');
const finishRetry = interactiveStateModule.trackLocalRepaintPreparation(preparingSession.sessionId);
finishGpu();
assert.equal(isPreparing(), true, 'late cleanup must not remove a replacement task');
interactiveStateModule.publishLocalRepaintInteractiveState({
  sessionId: preparingSession.sessionId,
  generationId: 'generation-preparing', targetLayerId: 'target-preparing', status: 'failed',
});
assert.equal(isPreparing(), false, 'failed work must not block retry before cleanup runs');
finishRetry();
const finishOld = interactiveStateModule.trackLocalRepaintPreparation(preparingSession.sessionId);
const nextSession = interactiveStateModule.beginLocalRepaintSession({
  generationId: 'generation-next', targetLayerId: 'target-next',
});
const finishNext = interactiveStateModule.trackLocalRepaintPreparation(nextSession.sessionId);
finishOld();
assert.equal(interactiveStateModule.isLocalRepaintPreparationInFlight('generation-next', 'target-next'), true);
interactiveStateModule.cancelLocalRepaintSession(nextSession.sessionId);
assert.equal(interactiveStateModule.isLocalRepaintPreparationInFlight('generation-next', 'target-next'), false);
finishNext();
assert.match(editor, /if \(!isLocalRepaintPreparationInFlight\(latestLocalRepaintGeneration\.id, preparedTargetId\)\) \{\s*useSceneStore\.getState\(\)\.requestLocalRepaintGpuPrepare\(\)/);
assert.match(viewport, /while \(\s*requiresResidentMaterial && !cancelled &&/);
assert.match(viewport, /finally\(finishAssetPreparation\)/);
assert.match(viewport, /finally\(finishGpuPreparation\)/);
assert.match(
  viewport,
  /projectedBackgroundMaterialRevision[\s\S]{0,500}backgroundDisplayMode === 'flat'[\s\S]{0,120}backgroundDisplayMode === 'pbr'/,
  'ordinary flat/PBR materials must satisfy the repaint background readiness barrier',
);
assert.match(dock, /data-local-repaint-apply="true"/);
assert.match(dock, /localRepaintActivationDisposition === 'queue-until-unlocked'/);
assert.match(dock, /localRepaintActivationQueued && \(/);
assert.match(dock, /role="progressbar"/);
assert.match(globals, /@keyframes local-repaint-activation-progress/);

const compiledBackgroundPrewarmPolicy = ts.transpileModule(backgroundPrewarmPolicy, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const backgroundPrewarmPolicyModule = await import(
  `data:text/javascript;base64,${Buffer.from(compiledBackgroundPrewarmPolicy).toString('base64')}`
);
const resolveBackgroundPrewarm =
  backgroundPrewarmPolicyModule.resolveLocalRepaintBackgroundPrewarmDisposition;
const nextSource = {
  generationId: 'generation-2',
  objectId: 'object-1',
  targetLayerId: 'target-2',
};

assert.equal(
  resolveBackgroundPrewarm({ nextSource }),
  'stage-latest-generation',
  'the first generation should prewarm without a visible source',
);
assert.equal(
  resolveBackgroundPrewarm({ currentSource: nextSource, nextSource }),
  'already-staged',
  'an exact resident source should not be decoded again',
);
assert.equal(
  resolveBackgroundPrewarm({
    currentSource: {
      generationId: 'generation-1',
      objectId: 'object-1',
      targetLayerId: 'target-1',
    },
    nextSource,
    pendingGenerationId: 'generation-2',
  }),
  'stage-latest-generation',
  'a newly completed second generation should replace the previous visible source once',
);
assert.equal(
  resolveBackgroundPrewarm({
    currentSource: {
      generationId: 'generation-1',
      objectId: 'object-1',
      targetLayerId: 'target-1',
      autoActivate: false,
    },
    nextSource,
  }),
  'stage-latest-generation',
  'a passive renderer-restored source must not block the newest generation after reload',
);
assert.equal(
  resolveBackgroundPrewarm({
    currentSource: {
      generationId: 'generation-1',
      objectId: 'object-1',
      targetLayerId: 'target-1',
    },
    nextSource,
  }),
  'preserve-current-source',
  'ordinary background scans should preserve a historical source being edited',
);
assert.equal(
  resolveBackgroundPrewarm({
    currentSource: {
      generationId: 'generation-1',
      objectId: 'object-1',
      targetLayerId: 'target-1',
      projectionLayerId: 'local-repaint-projection-1',
      autoActivate: false,
    },
    nextSource,
    pendingGenerationId: 'generation-2',
  }),
  'stage-latest-generation',
  'a newly completed generation must stage once instead of deadlocking behind the selected row',
);
assert.equal(
  resolveBackgroundPrewarm({
    currentSource: {
      generationId: 'generation-1',
      objectId: 'object-1',
      targetLayerId: 'target-1',
      projectionLayerId: 'local-repaint-projection-1',
      autoActivate: false,
    },
    nextSource,
  }),
  'preserve-current-source',
  'ordinary scans must preserve the exact selected repaint row',
);
assert.match(
  editor,
  /canQueueLocalRepaintActivation &&\s*\(generationOperationLocked \|\| !localRepaintGenerationReady\)/,
  'a ready generation with a cold GPU source must start preparation on click instead of only spinning',
);
assert.match(
  editor,
  /!localRepaintGenerationReady \|\|\s*!pendingLocalRepaintActivationRequestRef\.current[\s\S]*?'replayed-to-start-gpu-prepare'/,
  'an unlocked queued click must replay into GPU preparation without waiting for a circular ready event',
);

const compiledActivationRequestPolicy = ts.transpileModule(activationRequestPolicy, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const activationRequestPolicyModule = await import(
  `data:text/javascript;base64,${Buffer.from(compiledActivationRequestPolicy).toString('base64')}`
);
const resolveActivation = activationRequestPolicyModule.resolveLocalRepaintActivationDisposition;
const createActivationRequest =
  activationRequestPolicyModule.createLocalRepaintActivationRequest;
const activationRequestMatches =
  activationRequestPolicyModule.localRepaintActivationRequestMatches;
const selectPreferredGeneration =
  activationRequestPolicyModule.selectPreferredLocalRepaintGeneration;

assert.equal(
  resolveActivation({
    localRepaintReady: true,
    operationLocked: true,
    localGenerationRunning: true,
    canQueueDuringTransition: true,
  }),
  'queue-until-unlocked',
  'the first click after result publication must survive the short generation-unlock window',
);
assert.equal(
  resolveActivation({
    localRepaintReady: false,
    operationLocked: false,
    localGenerationRunning: false,
    canQueueDuringTransition: true,
  }),
  'queue-until-unlocked',
  'a successful result callback must preserve the click until the generation store publishes readiness',
);
assert.equal(
  resolveActivation({
    localRepaintReady: true,
    operationLocked: false,
    localGenerationRunning: false,
    canQueueDuringTransition: false,
  }),
  'activate-now',
  'a resident result must still activate immediately',
);
assert.equal(
  resolveActivation({
    localRepaintReady: false,
    operationLocked: true,
    localGenerationRunning: true,
    canQueueDuringTransition: false,
  }),
  'blocked-generation-running',
  'a generation with no usable result must remain locked',
);
assert.equal(
  resolveActivation({
    localRepaintReady: true,
    operationLocked: true,
    localGenerationRunning: false,
    canQueueDuringTransition: false,
  }),
  'blocked-operation',
  'unrelated editor operations must not be bypassed by the repaint queue',
);

const exactActivationRequest = createActivationRequest({
  generationId: 'generation-2',
  targetLayerId: 'target-2',
  now: 100,
});
assert.equal(exactActivationRequest.requestedAt, 100);
assert.equal(
  activationRequestMatches(exactActivationRequest, {
    generationId: 'generation-2',
    targetLayerId: 'target-2',
  }),
  true,
  'the renderer event for the queued generation and destination must release the request',
);
assert.equal(
  activationRequestMatches(exactActivationRequest, {
    generationId: 'generation-1',
    targetLayerId: 'target-1',
  }),
  false,
  'a stale renderer event must not release the current activation request',
);

const generated = (id, completedAt) => ({
  id,
  mode: 'inpaint',
  prompt: '',
  referenceIds: [],
  resultUrl: `/${id}.png`,
  status: 'succeeded',
  metadata: { workflow: 'local-repaint', completedAt },
});
const generation1 = generated('generation-1', '2026-09-02T01:00:00.000Z');
const generation2 = generated('generation-2', '2026-09-02T02:00:00.000Z');
assert.equal(
  selectPreferredGeneration([generation1, generation2], () => true)?.id,
  'generation-2',
  'fallback selection must deterministically choose the newest completed repaint',
);
assert.equal(
  selectPreferredGeneration([generation1, generation2], () => true, 'generation-1')?.id,
  'generation-1',
  'an explicit generation from the settle callback must remain authoritative',
);

assert.doesNotMatch(viewport, /hasCanvasAlpha\(/);
assert.match(viewport, /maskInverted/);
assert.match(viewport, /deferred-until-button2/);
assert.match(viewport, /new WeakMap<THREE\.Object3D, PaintableSurfaceCache>/);
const immediateLayerRowPublish = viewport.indexOf("perfLocalRepaintPhase = 's6-layer-row-publish'");
const projectedPersistenceIdleWait = viewport.indexOf(
  'const canCommit = await waitForPaintCommitIdle(',
);
assert.ok(immediateLayerRowPublish >= 0, 'local repaint must publish its layer row');
assert.ok(projectedPersistenceIdleWait >= 0, 'local repaint must retain its persistence idle wait');
assert.ok(
  immediateLayerRowPublish < projectedPersistenceIdleWait,
  'the complete layer row must publish before the deferred persistence idle wait',
);
assert.match(
  viewport.slice(immediateLayerRowPublish, projectedPersistenceIdleWait),
  /layerState\.setLayers\(nextLayers\)/,
  'the immediate path must update the authoritative layer store',
);
assert.match(
  viewport.slice(projectedPersistenceIdleWait, projectedPersistenceIdleWait + 1800),
  /setProjectLayers\(useLayerStore\.getState\(\)\.layers\)/,
  'a reused layer row must still wake latest-revision project persistence after idle',
);
assert.match(
  viewport.slice(immediateLayerRowPublish, projectedPersistenceIdleWait),
  /if \(!layerRowAlreadyCurrent\) \{[\s\S]*layerState\.setLayers\(nextLayers\)/,
  'an unchanged live-canvas layer row must not republish every pointer-up',
);

assert.doesNotMatch(workflow, /id: 'retopology'/);
assert.doesNotMatch(workflow, /ChevronRight/);
assert.match(home, /4 个工作模块/);
assert.doesNotMatch(home, /AI RETOPOLOGY|自动拓扑 V6|onOpenRetopology/);
assert.match(asset, /直接传入烘焙/);
assert.match(app, /segments\[0\] === 'retopology'[\s\S]*name: 'autoUv'/);

assert.match(app, /<AppAuthGate\s*\/>/);
assert.match(panel, /requireFeishuLogin/);
assert.match(panel, /createLiclickApiClient/);
assert.doesNotMatch(`${app}\n${panel}`, /\/api\/comfyui\/status|Atlas CLI/i);

console.log('Zero-install local repaint/product regression test passed.');

assert.match(viewport, /prewarmLocalRepaintProgram\(gl, geometry, camera\)/);
assert.match(viewport, /localRepaintGenerationPresentationActive \? state\.paintMaskDataUrl/);
assert.match(viewport, /\[falloffCanvas, liveSource\] = await Promise\.all/);
assert.match(viewport, /if \(currentOverlay\.compilePromise\) await currentOverlay\.compilePromise/);
assert.match(viewport, /throw new Error\('上一重绘图层的蒙版尚未完成材质绑定/);
assert.match(viewport, /withLocalRepaintSessionTimeout\(\s*ensureLocalRepaintGpuOverlay/);
