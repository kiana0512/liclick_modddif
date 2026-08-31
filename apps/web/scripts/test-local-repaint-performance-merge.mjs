import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [panel, dock, editor, viewport, workflow, home, asset, app, serverInpaint] =
  await Promise.all([
    read('../src/components/panels/GeneratePanel.tsx'),
    read('../src/components/editor/BottomToolDock.tsx'),
    read('../src/routes/EditorPage.tsx'),
    read('../src/engine/viewport/ViewportCanvas.tsx'),
    read('../src/features/workflow/WorkflowModuleSwitcher.tsx'),
    read('../src/routes/HomePage.tsx'),
    read('../src/routes/AssetProcessingPage.tsx'),
    read('../src/App.tsx'),
    read('../../server/src/services/modelviewInpaintService.ts'),
  ]);

assert.doesNotMatch(panel, /createFullFrameMaskDataUrl/);
assert.doesNotMatch(panel, /full-frame-default/);
assert.match(panel, /local-repaint-mask-required/);
assert.match(panel, /onLocalImageGenerationSettled/);
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

assert.doesNotMatch(viewport, /hasCanvasAlpha\(/);
assert.match(viewport, /maskInverted/);
assert.match(viewport, /deferred-until-button2/);
assert.match(viewport, /new WeakMap<THREE\.Object3D, PaintableSurfaceCache>/);
const immediateLayerRowPublish = viewport.indexOf("perfLocalRepaintPhase = 's6-layer-row-publish'");
const projectedPersistenceIdleWait = viewport.indexOf(
  'const canCommit = await waitForPaintCommitIdle(publishWasSuperseded);',
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
