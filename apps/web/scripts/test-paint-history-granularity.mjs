import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

const sourceRoot = new URL('../src/', import.meta.url);
const [viewport, dock, editor, actions] = await Promise.all([
  readFile(new URL('engine/viewport/ViewportCanvas.tsx', sourceRoot), 'utf8'),
  readFile(new URL('components/editor/BottomToolDock.tsx', sourceRoot), 'utf8'),
  readFile(new URL('routes/EditorPage.tsx', sourceRoot), 'utf8'),
  readFile(new URL('engine/paint/paintMaskHistoryActions.ts', sourceRoot), 'utf8'),
]);

assert.match(viewport, /localRepaintHistoryBefore/);
assert.match(viewport, /label: draft\.localRepaintHistoryBeforeHasContent[\s\S]*?'局部重绘笔画'/);
assert.match(viewport, /undo: \(\) => applyTiles\('before'\)/);
assert.match(viewport, /redo: \(\) => applyTiles\('after'\)/);
assert.match(viewport, /inpaintHistoryBefore/);
assert.match(viewport, /archiveCurrentInpaintProjection\([\s\S]*?captureInpaintMaskHistoryState/);
assert.match(viewport, /label:[\s\S]*?'蒙版减选笔画'[\s\S]*?'蒙版加选笔画'/);
assert.match(viewport, /label: action === 'clear' \? '清空蒙版' : '反转蒙版'/);
assert.match(viewport, /restoreInpaintAccumulationPixels/);

assert.match(actions, /activeHandler\?\.\(action\) \?\? false/);
assert.match(dock, /runPaintMaskHistoryAction\('clear'\)/);
assert.match(dock, /runPaintMaskHistoryAction\('invert'\)/);
assert.match(dock, /Ctrl Y \/ Ctrl Shift Z/);
assert.match(editor, /runPaintMaskHistoryAction\('clear'\)/);
assert.match(editor, /runPaintMaskHistoryAction\('invert'\)/);
assert.match(
  editor,
  /closest\('input, textarea, select, \[contenteditable="true"\], \[role="textbox"\]'\)/,
  'Text editing must retain native undo instead of entering editor history.',
);

process.stdout.write('Paint history granularity regression checks passed.\n');
