import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
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

// Execute the actual listener effect, including dismissal before canvas input.
const menuEffect = dock.match(/useEffect\(\(\) => \{\s*if \(mode !== 'texture' \|\| paintTool !== 'inpaint-apply'\) return;([\s\S]*?)\}, \[mode, paintTool\]\);/);
assert(menuEffect);
const body = ts.transpileModule(`if (mode !== 'texture' || paintTool !== 'inpaint-apply') return;${menuEffect[1]}`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const install = new Function('window', 'mode', 'paintTool', 'repaintContextMenuRef', 'dockRef', 'setActiveMenu', body);
const listeners = new Map();
const win = {
  addEventListener(name, fn) { listeners.set(name, fn); },
  removeEventListener(name, fn) { assert.equal(listeners.get(name), fn); listeners.delete(name); },
};
const context = { current: false }, dockNode = {}, menus = [];
const ref = { current: { contains: node => node === dockNode } };
const cleanup = install(win, 'texture', 'inpaint-apply', context, ref, v => menus.push(v));
const event = (button = 0, target = {}) => ({ button, target, prevented: false, stopped: false,
  preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
const open = () => listeners.get('liclick:repaint-brush-menu')();
open(); open(); assert.equal(menus.at(-1), 'inpaint-apply');
const slider = event(0, dockNode); listeners.get('pointerdown')(slider);
assert(!slider.stopped && context.current, 'panel controls remain interactive');
const right = event(2); listeners.get('pointerdown')(right);
assert(context.current && !right.stopped, 'repeated RMB does not dismiss');
const left = event(); listeners.get('pointerdown')(left);
assert(left.prevented && left.stopped && !context.current && menus.at(-1) === undefined);
const click = event(); listeners.get('click')(click); assert(click.stopped, 'dismissal click must not select');
const next = event(); listeners.get('pointerdown')(next); assert(!next.stopped, 'next stroke remains enabled');
open(); cleanup(); assert(!context.current && menus.at(-1) === undefined && listeners.size === 0);
for (const [mode, tool] of [['uv', 'inpaint-apply'], ['texture', 'eraser'], ['texture', 'inpaint-add']]) {
  assert.equal(install(win, mode, tool, context, ref, v => menus.push(v)), undefined);
  assert.equal(listeners.size, 0);
}
const viewport = read('engine/viewport/ViewportCanvas.tsx');
const guard = viewport.match(/if \(paintTool === 'inpaint-apply' && event.pointerType === 'mouse' && event.button === 2\) \{([\s\S]*?)\n {6}\}/);
assert(guard);
const dispatch = new Function('paintTool', 'event', 'window',
  `if(event.altKey || event.button===1)return 'navigation';${guard[0]}return 'paint';`);
const requests = [];
const mouseRight = { ...event(2), pointerType: 'mouse' };
assert.equal(dispatch('inpaint-apply', mouseRight, { dispatchEvent: e => requests.push(e.type) }), undefined);
assert(mouseRight.stopped && mouseRight.prevented);
assert.deepEqual(requests, ['liclick:repaint-brush-menu']);
assert.equal(dispatch('inpaint-apply', {...mouseRight, altKey:true}, win), 'navigation');
assert.equal(dispatch('eraser', mouseRight, win), 'paint');
assert.equal(dispatch('inpaint-apply', {...event(2), pointerType:'pen'}, win), 'paint');
assert(viewport.indexOf(guard[0]) < viewport.indexOf('const rightModelEraseContact'), 'menu exits before erase routing');
console.log('Repaint RMB menu: controls, repeated open, consumed dismissal, next stroke, navigation/eraser isolation and cleanup passed.');
