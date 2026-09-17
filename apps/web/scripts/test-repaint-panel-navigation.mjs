import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (file) => fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
const panel = read('components/panels/GeneratePanel.tsx');
const effect = panel.match(/useEffect\(\(\) => \{\s*if \(!openLocalRepaintPanelRequestKey\) return;([\s\S]*?)\}, \[openLocalRepaintPanelRequestKey\]\);/);
assert.ok(effect, 'navigation must react only to its own request key');
const run = new Function('openLocalRepaintPanelRequestKey', 'setTab', 'setTexturePreviewMode',
  'if (!openLocalRepaintPanelRequestKey) return;' + effect[1]);
const calls = [];
for (const key of [0, 1, 2]) run(key, (v) => calls.push(['tab',v]), (v) => calls.push(['preview',v]));
assert.deepEqual(calls, [['tab','repaint'],['preview','repaint'],['tab','repaint'],['preview','repaint']]);
assert.doesNotMatch(effect[1], /Generation|Prompt|Reference|paintTool/);
const dock = read('components/editor/BottomToolDock.tsx');
assert.equal((dock.match(/onOpenLocalRepaintPanel\?\.\(\)/g) || []).length, 3);
assert.match(
  dock,
  /onOpenLocalRepaintPanel\?\.\(\);[\s\S]*?onPaintToolChange\(isMaskPaintTool \? paintTool : 'inpaint-add'\)/,
  'repeated mask-panel requests must also rearm the current viewport paint session',
);
const editor = read('routes/EditorPage.tsx');
assert.match(editor, /onOpenLocalRepaintPanel=\{handleOpenLocalRepaintPanel\}/);
assert.match(editor, /openLocalRepaintPanelRequestKey=\{openLocalRepaintPanelRequestKey\}/);
const handler = editor.match(/const handleOpenLocalRepaintPanel = useCallback\(\(\) => \{([\s\S]*?)\}, \[showPanel, setPanelCollapsed\]\);/)?.[1];
assert.ok(handler);
assert.match(handler, /showPanel\('generate'\)/);
assert.match(handler, /setPanelCollapsed\('generate', false\)/);
assert.match(handler, /setOpenLocalRepaintPanelRequestKey/);
assert.doesNotMatch(handler, /setLocalImageGenerationRequestKey|setPaintTool/);
console.log('Repaint panel navigation: three buttons, repeated requests, panel expansion and generation isolation passed.');
