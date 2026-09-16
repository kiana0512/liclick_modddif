import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { createStore } from 'zustand/vanilla';

const read = (name) => fs.readFileSync(new URL(`../src/engine/viewport/${name}`, import.meta.url), 'utf8');
const viewport = read('ViewportCanvas.tsx');
const scene = read('SceneRoot.tsx');
const compile = (source, scope) => new Function(...Object.keys(scope), ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText)(...Object.values(scope));
const effect = (source, marker) => {
  const file = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect' &&
        node.arguments[0]?.getText(file).includes(marker)) matches.push(node.arguments[0].getText(file));
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.equal(matches.length, 1, marker);
  return matches[0];
};
const editingFlags = viewport.slice(viewport.indexOf('  const isEditingPersistedLocalRepaint ='),
  viewport.indexOf('\n  useEffect', viewport.indexOf('  const isEditingPersistedLocalRepaint =')));
const restoreEffect = effect(viewport, 'const restoreSource = async');
const layerA = { id: 'repaint-a', visible: true, camera: {}, imageUrl: 'color-a', maskUrl: 'mask-a',
  replacementTargetLayerId: 'uv', objectId: 'object', generationId: 'gen-a' };
const layerB = { ...layerA, id: 'repaint-b', imageUrl: 'color-b', maskUrl: 'mask-b', generationId: 'gen-b' };
const uv = { id: 'uv', type: 'uv', visible: true };
const layerStore = createStore(() => ({ layers: [uv, layerA, layerB], activeProjectedLayerId: 'uv' }));
const sceneState = { paintTool: 'none', localRepaintProjectionSource: undefined };
const sourceWrites = [];
sceneState.setLocalRepaintProjectionSource = (source) => {
  sourceWrites.push(source);
  sceneState.localRepaintProjectionSource = source;
};
let encode = async () => 'encoded-mask';
let liveMask;
const runRestore = compile(`return (paintTool, activePaintLayer) => {
  const localRepaintProjectionSource = useSceneStore.getState().localRepaintProjectionSource;
  ${editingFlags}\nreturn (${restoreEffect})(); };`, {
  useLayerStore: layerStore, useSceneStore: { getState: () => sceneState }, selectedObjectId: 'object',
  isEditableLocalRepaintProjectionLayer: (layer) => Boolean(layer?.camera && layer?.maskUrl),
  isNativeUvRepaintLayer: (layer) => layer.type === 'uv' && layer.id.startsWith('local-repaint-uv-native-v1'),
  getLocalRepaintSeamMode: () => 'enhanced', hasEditableEnhancedLocalRepaintSource: () => true,
  createLocalRepaintSourceKey: (source) => source.imageUrl,
  isLocalRepaintSourceForLayer: (source, layer) => source?.projectionLayerId === layer.id,
  localRepaintCompositeRef: { current: undefined },
  getLiveProjectedCanvasState: () => liveMask ? { canvas: liveMask } : undefined,
  canvasToPngDataUrl: () => encode(), console,
});
let cleanup;
const select = (layer, tool = 'none') => {
  cleanup?.();
  sceneState.paintTool = tool;
  layerStore.setState({ activeProjectedLayerId: layer.id });
  cleanup = runRestore(tool, layer);
};

// Selection, not eye visibility: none/apply/mask tools must not replace the
// generation-owned source or release its already presented GPU overlay.
for (const tool of ['none', 'inpaint-apply', 'inpaint-add', 'inpaint-subtract']) {
  for (let i = 0; i < 100; i++) select([uv, layerA, layerB][i % 3], tool);
}
assert.equal(sourceWrites.length, 0, '400 ordinary selections must not publish an editing source');
select(layerA, 'eraser');
assert.equal(sourceWrites.length, 1, 'Explicit eraser selection restores the persisted source');
assert.equal(sourceWrites[0].allowedMaskUrl, 'mask-a');
select(layerA, 'eraser');
assert.equal(sourceWrites.length, 1, 'An already-owned source remains resident');
select(layerB, 'eraser');
assert.equal(sourceWrites.length, 2, 'Eraser target selection must still switch ownership');
assert.equal(sourceWrites[1].projectionLayerId, layerB.id);
liveMask = {};
let finishEncode;
encode = () => new Promise((resolve) => { finishEncode = resolve; });
select(layerA, 'eraser');
sceneState.paintTool = 'none'; // Before React can run cleanup.
finishEncode('late-mask');
await Promise.resolve();
assert.equal(sourceWrites.length, 2, 'An encode completing after leaving eraser cannot steal ownership');
select(layerA, 'eraser');
select(uv);
finishEncode('cancelled-mask');
await Promise.resolve();
assert.equal(sourceWrites.length, 2, 'A superseded target cannot publish late');
cleanup?.();

// Execute the production subscription with a real Zustand store. UI selection
// notifications are not presentation transitions; actual layer edits still are.
let syncs = 0;
const unsubscribe = compile(`return (${effect(viewport, 'const unsubscribeLayers = useLayerStore.subscribe')})();`, {
  useLayerStore: layerStore, useSceneStore: { getState: () => sceneState },
  syncLocalRepaintGpuOverlayActivity: () => { syncs++; },
});
assert.equal(syncs, 1);
for (let i = 0; i < 100; i++) layerStore.setState({ activeProjectedLayerId: i % 2 ? layerA.id : uv.id });
assert.equal(syncs, 1, 'Idle selection must not restart the resident/overlay handoff');
for (const patch of [{ visible: false }, { visible: true }, { maskUrl: 'erased' }, { opacity: 0.5 }]) {
  layerStore.setState((state) => ({ layers: state.layers.map((layer) => layer.id === layerA.id ? { ...layer, ...patch } : layer) }));
}
assert.equal(syncs, 5, 'Eye toggles, eraser commits and adjustments still synchronize');
sceneState.paintTool = 'eraser';
layerStore.setState({ activeProjectedLayerId: layerB.id });
assert.equal(syncs, 6, 'Selecting an eraser target remains a presentation transition');
layerStore.setState({ unrelatedUi: true });
assert.equal(syncs, 6);
layerStore.setState((state) => ({ layers: state.layers.filter((layer) => layer.id !== layerB.id) }));
assert.equal(syncs, 7, 'Deleting the active layer must withdraw its overlay');
unsubscribe();
layerStore.setState({ layers: [] });
assert.equal(syncs, 7, 'Unmount detaches the listener');

// Use actual React memo bodies/dependencies rather than a copy of the policy.
const start = scene.indexOf('  const progressiveBackgroundInputs =');
const memos = scene.slice(start, scene.indexOf('  const progressiveBackgroundSignature =', start));
const inputs = [layerA, layerB].map((layer) => ({ layerId: layer.id, visible: true }));
let cursor = 0;
const slots = [];
const runMemos = compile(`return (activeLayerId, canUseProgressiveUvFallback, previewProjectionInputs) => {
  ${memos}\nreturn { progressiveBackgroundInputs }; };`, {
  useMemo: (fn, deps) => {
    const index = cursor++;
    if (!slots[index] || deps.some((value, i) => value !== slots[index].deps[i])) {
      slots[index] = { deps, value: fn() };
    }
    return slots[index].value;
  },
});
const render = (id, enabled = false, layers = inputs) => { cursor = 0; return runMemos(id, enabled, layers); };
const first = render(uv.id);
for (let i = 0; i < 100; i++) {
  const next = render([uv, layerA, layerB][i % 3].id);
  assert.equal(next.progressiveBackgroundInputs, first.progressiveBackgroundInputs);
}
const enabled = render(layerA.id, true);
assert.deepEqual(enabled.progressiveBackgroundInputs, inputs, 'Selection must leave every layer in the resident UV buffer');
assert.notEqual(render(layerA.id, false, [...inputs]).progressiveBackgroundInputs, first.progressiveBackgroundInputs,
  'Real stack changes still invalidate material inputs');
console.log('Repaint layer selection passed: 400 source-stable selections, 100 presentation-stable selections, 100 UV-input-stable selections; eraser ownership, stale completion, visibility, edits, deletion and cleanup preserved.');
