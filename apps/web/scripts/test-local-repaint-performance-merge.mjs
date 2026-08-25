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
assert.match(panel, /image: \{ path: 'white-model\.png'/);
assert.match(
  panel,
  /materialImage: \{[\s\S]*path: `\$\{generationId\}-\$\{materialReference\.id\}-material-reference\.png`/,
);
assert.match(panel, /const \[whiteModelDataUrl, materialReferenceDataUrl, viewportReferenceDataUrl\]/);
assert.match(
  panel,
  /viewportReference: \{[\s\S]*path: `\$\{generationId\}-viewport-reference\.png`[\s\S]*dataUrl: viewportReferenceDataUrl/,
);
assert.match(serverInpaint, /if \(!input\.viewportReference\?\.dataUrl\)/);
assert.match(serverInpaint, /field: 'viewport_reference'/);
assert.doesNotMatch(panel, /generateInpaint\(\s*\{[\s\S]*paintMask:/);
assert.match(panel, /cancelledTextureBatchIdsRef/);
assert.match(panel, /generationBelongsToObject/);

assert.match(dock, /localImageGenerationSuccessKey/);
assert.match(dock, /guideWorkflowButton/);
assert.match(editor, /localImageGenerationRequested \|\| localImageGenerationStoreRunning/);

assert.doesNotMatch(viewport, /hasCanvasAlpha\(/);
assert.match(viewport, /maskInverted/);
assert.match(viewport, /deferred-until-button2/);
assert.match(viewport, /new WeakMap<THREE\.Object3D, PaintableSurfaceCache>/);

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
