import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [policy, viewport, dock, layerStore, shortcuts, editor] = await Promise.all([
  readFile(new URL('../src/engine/paint/eraserTargetPolicy.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/engine/viewport/ViewportCanvas.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/editor/BottomToolDock.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/stores/layerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/stores/shortcutStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/routes/EditorPage.tsx', import.meta.url), 'utf8'),
]);

assert.match(policy, /ERASER_ALGORITHM_ID = 'ALG-ERASE-001'/);
assert.match(policy, /ERASER_ALGORITHM_VERSION = 1/);
assert.match(
  policy,
  /isContentAwareEraserUnderlay\(layer\)[\s\S]*?kind: 'convert-content-aware'[\s\S]*?requiresEditableUvCopy: true/,
  'Generated content-aware underlays must be converted before erasing.',
);
assert.match(
  policy,
  /isLocalRepaintEraserLayer\(layer\)[\s\S]*?kind: 'local-repaint-coverage'/,
  'Local repaint rows must edit their authored coverage.',
);
assert.match(
  policy,
  /layer\.type === 'projected'[\s\S]*?kind: 'projected-mask'/,
  'Projected layers must route erasing through a keep-mask.',
);
assert.match(
  policy,
  /layer\.type === 'uv'[\s\S]*?kind: 'uv-coverage'/,
  'Ordinary and merged UV layers must erase their own coverage.',
);
assert.match(
  viewport,
  /paintTool === 'eraser'[\s\S]*?getEraserTargetPolicy\(activePaintLayer\)\.canActivate/,
  'The pointer engine must consume the shared target policy.',
);
assert.match(
  viewport,
  /target === 'projected-mask'[\s\S]*?UV_TEXTURE_RESOLUTION\[textureResolutionSetting\]/,
  'Projected eraser masks must commit at the selected project resolution.',
);
assert.match(dock, /getEraserTargetPolicy\(activeLayer\)/);
assert.match(dock, /shortcut="E"/);
const localRepaintApplyIndex = dock.indexOf('data-local-repaint-apply="true"');
const textureEraserIconIndex = dock.indexOf('<Eraser className="h-5 w-5"');
assert.ok(localRepaintApplyIndex >= 0 && textureEraserIconIndex > localRepaintApplyIndex);
assert.equal(
  dock.indexOf('<Eraser className="h-5 w-5"', textureEraserIconIndex + 1),
  -1,
  'The texture eraser must remain a single button placed to the right of local repaint.',
);
assert.match(
  layerStore,
  /duplicateContentAwareLayerAsEditableUv[\s\S]*?isContentAwareEraserUnderlay\(source\)[\s\S]*?role: undefined,[\s\S]*?generationId: undefined/,
  'Content-aware conversion must preserve the source row and create an ordinary UV copy.',
);
assert.match(shortcuts, /'texture\.eraser'[\s\S]*?binding\('KeyE'\)/);
assert.match(editor, /shortcutMatches\(event, 'texture\.eraser'\)/);

console.log('eraser target-policy regression passed');
