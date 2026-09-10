/* global structuredClone */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const read = (file) => readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
const [policySource, panel, editor, generate] = await Promise.all([
  read('engine/layers/generationLayerDeletionPolicy.ts'),
  read('components/panels/LayersPanel.tsx'), read('routes/EditorPage.tsx'),
  read('components/panels/GeneratePanel.tsx'),
]);
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const policy = {};
new Function('exports', compile(policySource))(policy);
const unlocked = { contentAwareRepairRunning: false, snapshotPreparing: false,
  localInputsPreparing: false, localRequestPending: false };
assert.equal(policy.isGenerationLayerDeletionLocked(unlocked), false);
for (const key of Object.keys(unlocked)) {
  assert.equal(policy.isGenerationLayerDeletionLocked({ ...unlocked, [key]: true }), true, key);
}
for (const allowed of [true, false]) {
  const target = { closest: () => ({ matches: () => allowed }) };
  assert.equal(policy.isLayerDeletionInteractionTarget(target), allowed);
}
assert.equal(policy.isLayerDeletionInteractionTarget({ closest: () => null }), false);
assert.match(editor, /!layerDeletionLocked && isLayerDeletionInteractionTarget\(target\)/);
assert.equal((editor.match(/deletionLocked=\{layerDeletionLocked\}/g) ?? []).length, 2);
assert.match(editor, /layerDeletionLocked \|\| !\(target instanceof HTMLElement\)[\s\S]*?data-layer-delete-scope/);
assert.match(panel, /if \(mutationLocked &&[\s\S]*?data-layer-delete-scope/);
assert.equal((panel.match(/blockMutation\('清空当前模型图层', deletionLocked\)/g) ?? []).length, 2);
assert.equal((panel.match(/<MenuButton taskDeletion onClick=\{\(\) => run\(onDelete\)\}/g) ?? []).length, 2);
assert.match(generate, /layerInputsPreparing: Boolean\(localRepaintPreparation\)/);

function findNode(source, predicate) {
  const ast = ts.createSourceFile('test.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  const visit = (node) => { if (predicate(node)) found = node; else ts.forEachChild(node, visit); };
  visit(ast);
  assert(found, 'Production node must exist');
  return found.getText(ast);
}
const deleteBinding = findNode(panel, (node) =>
  ts.isVariableDeclaration(node) && node.name.getText() === 'deleteSelectedLayers');
const makeDelete = (scope) => new Function(...Object.keys(scope),
  `${compile(`const ${deleteBinding};`)}; return deleteSelectedLayers;`)(...Object.values(scope));
for (const locked of [true, false]) {
  for (const local of [true, false]) {
    let rows = [{ id: 'keep' }, { id: 'delete', local }, ...(local ? [{ id: 'draft' }] : [])];
    const history = [], frames = [], visibility = [], resets = [];
    const scene = {
      localRepaintProjectionSource: { targetLayerId: 'draft' },
      setLocalRepaintPreviewLayer: () => resets.push('preview'),
      setLocalRepaintProjectionSource: () => resets.push('source'),
      setPaintTool: () => resets.push('tool'), clearPaintMask: () => resets.push('mask'),
    };
    const scope = {
      useCallback: (fn) => fn, deletionLocked: locked,
      blockMutation: (_action, lock = true) => lock,
      layerIdSet: new Set(['keep', 'delete']),
      captureHistory: () => history.push(structuredClone(rows)),
      describeLayerSelection: () => 'delete',
      useSceneStore: { getState: () => scene },
      useLayerStore: { getState: () => ({ layers: rows }) },
      expandLocalRepaintVisibilityIds: (_rows, ids) => local ? [...ids, 'draft'] : ids,
      isLocalRepaintVisibilityLayer: (row) => Boolean(row.local),
      setLayerVisibility: (ids) => visibility.push(ids),
      deleteLayers: (ids) => { rows = rows.filter((row) => !ids.includes(row.id)); },
      setMenu: () => {}, setSelectedLayerIds: () => {}, setLastSelectedLayerId: () => {},
      startTransition: (fn) => fn(), window: { requestAnimationFrame: (fn) => frames.push(fn) },
    };
    makeDelete(scope)(['delete', 'delete', 'missing']);
    frames.forEach((fn) => fn());
    assert.equal(history.length, locked ? 0 : 1);
    if (!locked) {
      assert.deepEqual(rows, [{ id: 'keep' }]);
      assert.equal(resets.length, local ? 4 : 0);
      assert.equal(visibility.length, local ? 1 : 0);
      // Existing one-operation undo snapshot retains every deleted row.
      assert.equal(history[0].length, local ? 3 : 2);
    } else assert.equal(rows.length, local ? 3 : 2);
  }
}

// Extract the real CAS payload producer: retries must observe intervening deletes.
const saveFunction = findNode(generate, (node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'saveCriticalProjectStateNow');
const saveAst = ts.createSourceFile('save.ts', saveFunction, ts.ScriptTarget.Latest, true);
let producer;
const visit = (node) => {
  if (ts.isCallExpression(node) && node.expression.getText(saveAst) === 'updateLatestProject') {
    producer = node.arguments[1].getText(saveAst);
  }
  ts.forEachChild(node, visit);
};
visit(saveAst);
assert(producer);
let liveRows = [{ id: 'old' }, { id: 'new' }];
const projectState = { currentProjectId: 'project' };
const scope = {
  targetProjectId: 'project', project: { name: 'p', settings: {} }, objects: [], layers: [{ id: 'stale' }],
  references: [], generations: [], captures: [],
  useProjectStore: { getState: () => projectState },
  useLayerStore: { getState: () => ({ layers: liveRows }) },
};
const payload = new Function(...Object.keys(scope), `${compile(`const produce = ${producer};`)}; return produce;`)(...Object.values(scope));
assert.deepEqual(payload({}).layers, liveRows);
liveRows = [{ id: 'new' }];
assert.deepEqual(payload({}).layers, [{ id: 'new' }], 'CAS retry must not resurrect deleted old row');
liveRows = [];
assert.deepEqual(payload({}).layers, [], 'clear-all during upload must remain empty');
projectState.currentProjectId = 'other';
assert.deepEqual(payload({}).layers, [{ id: 'stale' }], 'do not leak another project layers');
assert.match(generate, /if \(existingLayer && !currentExisting\) return undefined/);
console.log('Generation layer deletion passed: scoped controls, protected inputs, selected/local deletion, history and CAS retry freshness.');
