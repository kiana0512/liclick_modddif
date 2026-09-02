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
  /materialImage: \{[\s\S]*path: `\$\{generationId\}-\$\{materialReference\.id\}-material-reference\.png`/,
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
assert.match(panel, /生成时自动分析并优化/);
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
assert.match(editor, /resolveLocalRepaintBackgroundPrewarmDisposition\(\{/);
assert.match(backgroundPrewarmPolicy, /pendingGenerationId === nextSource\.generationId/);
assert.match(backgroundPrewarmPolicy, /'preserve-current-source'/);
assert.match(editor, /pendingLocalRepaintActivationRequestRef\.current = true/);
assert.match(editor, /'replayed-after-gpu-ready'/);
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
assert.match(interactiveState, /userInitiated\?: boolean/);
assert.match(viewport, /userInitiated: source\.autoActivate !== false/);
assert.match(editor, /if \(!foregroundFailure\) return/);
assert.match(editor, /canQueueLocalRepaintActivation &&[\s\S]{0,100}!localRepaintInteractiveFailed/);
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
    },
    nextSource,
  }),
  'preserve-current-source',
  'ordinary background scans should preserve a historical source being edited',
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
