import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourceRoot = new URL('../src/', import.meta.url);
const [sessionLayer, generatePanel, editorPage, viewportCanvas, bottomToolDock] = await Promise.all([
  readFile(new URL('engine/localRepaint/sessionLayer.ts', sourceRoot), 'utf8'),
  readFile(new URL('components/panels/GeneratePanel.tsx', sourceRoot), 'utf8'),
  readFile(new URL('routes/EditorPage.tsx', sourceRoot), 'utf8'),
  readFile(new URL('engine/viewport/ViewportCanvas.tsx', sourceRoot), 'utf8'),
  readFile(new URL('components/editor/BottomToolDock.tsx', sourceRoot), 'utf8'),
]);

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
assert.match(editorPage, /visibleProjectionSource\.targetLayerId !== currentTarget\.id/);
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
  /activeLayerIdBeforePublish[\s\S]*?setActiveLayer\(activeLayerIdBeforePublish\)/,
  'a delayed publication must preserve the layer selected by a newer task',
);
assert.match(
  viewportCanvas,
  /previewOwnsOverlay\s*&&\s*\(sceneState\.paintTool === 'none'[\s\S]*?sceneState\.paintTool === 'inpaint-add'[\s\S]*?sceneState\.paintTool === 'inpaint-subtract'/,
  'closing the mask tool must keep the resident local repaint GPU preview visible',
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

console.log('Local repaint layer retention regression checks passed.');
