import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const read = (file) => readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
const panel = await read('components/panels/GeneratePanel.tsx');
const compile = (source) => ts.transpileModule(pipelineTraceDisabled(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const policy = {};
new Function('exports', compile(await read('engine/generation/singleViewAutoProjection.ts')))(policy);
new Function('exports', compile(await read('engine/generation/textureProjectionPolicy.ts')))(policy);
new Function('exports', compile(await read('services/isServerWorkspace.ts')))(policy);
const base = { id: 'g1', mode: 'single', status: 'succeeded', resultUrl: 'data:image/png;base64,result',
  captureId: 'capture', metadata: { projectId: 'p', workflow: 'texture-map' } };
assert(policy.needsSingleViewAutoProjection(base, 'p'));
const interruptedMultiview = { ...base, mode: 'multiview', metadata: { ...base.metadata, multiview: true, autoProjectExpected: true } };
assert(policy.needsSingleViewAutoProjection(interruptedMultiview, 'p'));
assert.equal(policy.needsSingleViewAutoProjection(policy.withProjectionCommit(interruptedMultiview, 'consumed-layer'), 'p'), false);
assert.equal(policy.needsSingleViewAutoProjection({ ...interruptedMultiview, metadata: { ...interruptedMultiview.metadata, cancelled: true } }, 'p'), false);
for (const patch of [{ mode: 'multiview' }, { status: 'running' }, { resultUrl: undefined },
  ...[{ projectId: 'other' }, { workflow: 'liclick' }, { workflow: 'local-repaint' },
    { multiview: true }, { cancelled: true }, { projectedLayerId: 'deleted' },
    { projectionCommittedAt: 'yesterday' }].map((metadata) => ({ metadata: { ...base.metadata, ...metadata } }))]) {
  assert.equal(policy.needsSingleViewAutoProjection({ ...base, ...patch }, 'p'), false);
}

// Execute the production transaction/recovery functions, not copies of their logic.
const ast = ts.createSourceFile('GeneratePanel.tsx', panel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['stageGenerationAsProjectedLayer', 'persistGenerationAsProjectedLayer', 'addGenerationAsProjectedLayer'];
const declarations = [];
let recovery;
const batchGuards = [];
let recoveryEffect;
let completeViewSource, checkpointSource;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) declarations.push(node.getText(ast));
  if (ts.isBinaryExpression(node) && node.left.getText(ast) === 'recoverSingleViewProjectionsRef.current') recovery = node.getText(ast);
  if (ts.isIfStatement(node) && node.expression.getText(ast) === 'isMultiviewRequest' &&
    /(?:begin|end)ProjectedPreviewBatch/.test(node.thenStatement.getText(ast))) batchGuards.push(node.getText(ast));
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' &&
    node.arguments[0]?.getText(ast).includes('let wakePending')) recoveryEffect = node.arguments[0].getText(ast);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'completeView') completeViewSource = node.initializer.getText(ast);
  if (ts.isIfStatement(node) && node.expression.getText(ast).startsWith('needsTextureCompletionCheckpoint(')) checkpointSource = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(declarations.length, 3);
assert(recovery);
assert.equal(batchGuards.length, 2, 'only multiview may defer preview until its batch save completes');
assert.match(panel, /wakeSingleViewProjectionsRef.current\?\.\(\);\s*\}, \[generations, workflowSubmissionLocked\]\)/);
assert.match(panel, /await recoverSingleViewProjectionsRef.current\?\.\(\)/);
assert.match(panel, /setTimeout\(\(\) => void recover\(\), wakePending \? 0 : 5000\)/);
assert.match(panel, /removeEventListener\('online', recover\)/);
assert.match(panel, /await persistProjectionCommit\(generation, layer.id, syncGeneration/);
assert(completeViewSource && checkpointSource, 'exercise the actual completion and checkpoint wiring');

// Execute the actual effect: a result arriving during recovery queues an
// immediate next pass, not a five-second delay or concurrent asset upload.
assert(recoveryEffect);
const timers = new Map(), listeners = new Map();
let timerId = 0, recoverCalls = 0, releaseRecovery;
const recoveryGate = new Promise((resolve) => { releaseRecovery = resolve; });
const wakeRef = {};
const effectScope = {
  currentProjectId: 'p', wakeSingleViewProjectionsRef: wakeRef,
  recoverSingleViewProjectionsRef: { current: () => { recoverCalls++; return recoverCalls === 1 ? recoveryGate : Promise.resolve(); } },
  window: {
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
  },
};
const startEffect = new Function(...Object.keys(effectScope), compile(`return (${recoveryEffect});`))(...Object.values(effectScope));
const stopEffect = startEffect();
wakeRef.current(); wakeRef.current();
assert.equal(recoverCalls, 1);
releaseRecovery();
await Promise.resolve(); await Promise.resolve();
const nextPass = [...timers.values()][0];
assert.equal(nextPass.delay, 0);
nextPass.callback();
await Promise.resolve(); await Promise.resolve();
assert.equal(recoverCalls, 2);
assert.equal([...timers.values()][0].delay, 5000);
stopEffect();
assert.equal(timers.size, 0);
assert.equal(listeners.size, 0);
assert.equal(wakeRef.current, undefined);

function fixture(allowUpdates = false, multiview = false) {
  let rows = [], generations = [base], failureCount = 0, sequence = 0;
  let cleanedImages = 0;
  let onAsset, onSave, previewRows;
  const state = { currentProjectId: 'p' };
  const capture = { id: 'capture', objectId: 'o', camera: { frozen: true }, maskUrl: 'mask', depthUrl: 'depth' };
  const project = { id: 'p', workspaceMode: 'download-fallback', captures: [capture] };
  const notices = [], saves = [], progress = [];
  const sync = (g) => { generations = [g, ...generations.filter((item) => item.id !== g.id)]; };
  const scope = {
    ...policy, console: { warn() {}, error() {} },
    signal: undefined, throwIfTexturePipelineCancelled() {}, textureBatchWasCancelled: () => false,
    isMultiviewRequest: multiview,
    pendingGenerations: [{ generationId: base.id, capture }], submittedGenerations: [base],
    updateTexturePipelineProgress: (value, title) => progress.push({ value, title }),
    setGenerateNotice: (notice) => notices.push(notice),
    currentProject: project, currentProjectId: 'p', workflowSubmissionLocked: false,
    submitLocksRef: { current: new Set() }, recoverSingleViewProjectionsRef: {},
    autoProjectionFailureNoticeRef: { current: new Map() },
    projectedLayerCommitQueueRef: { current: Promise.resolve() },
    useGenerationStore: { getState: () => ({ generations }) },
    useProjectStore: { getState: () => ({ ...state, projects: [project] }) },
    useLayerStore: { getState: () => ({ layers: rows,
      beginProjectedPreviewBatch: () => { previewRows = rows; },
      endProjectedPreviewBatch: () => { previewRows = undefined; },
      updateLayer: (id, patch) => { assert(allowUpdates, 'automatic result must not replace an existing layer'); rows = rows.map((row) => row.id === id ? { ...row, ...patch } : row); } }) },
    isTextureMapGeneration: (g) => g.metadata.workflow === 'texture-map',
    isCancelledGeneration: () => false,
    lastCapture: undefined, createId: () => `layer-${++sequence}`,
    createCaptureMaskedProjectionImage: async (url, mask) => { cleanedImages++; assert.equal(mask, 'mask'); return url; },
    persistGeneratedImage: async (_category, url) => {
      if (onAsset) { const callback = onAsset; onAsset = undefined; callback(); }
      if (failureCount > 0) { failureCount--; throw new Error('transient asset upload error'); }
      return url;
    },
    addProjectedLayerFromGeneration: (g, c, objectId, id) => {
      assert.deepEqual(c.camera, { frozen: true }); assert.equal(objectId, 'o');
      const layer = { id, generationId: g.id, camera: c.camera }; rows = [...rows, layer]; return layer;
    },
    syncGeneration: sync, setProjectLayers: () => {},
    saveCriticalProjectState: async () => {
      saves.push({ rows: [...rows], generations: [...generations] });
      await onSave?.();
    },
    pushToast: (notice) => notices.push(notice), dismissToastByDedupeKey: () => {},
    SINGLE_VIEW_MINIMUM_PROJECTION_FACING: 0.18, t: (key) => key,
  };
  const api = new Function(...Object.keys(scope), compile(`${declarations.join('\n')}\n${recovery};
    let singleViewProjectionSaved = false, completedTextureViewCount = 0;
    const completeView = ${completeViewSource};
    const saveGenerationStateBestEffort = () => saveCriticalProjectState();
    return { add: addGenerationAsProjectedLayer, recover: recoverSingleViewProjectionsRef.current,
      complete: (generation) => completeView(generation, generation),
      checkpoint: async (results, failureMessages = []) => {
        const completedGenerations = results.map((result) => result.generation);
        const projectedGenerationCount = useLayerStore.getState().layers.filter((layer) =>
          completedGenerations.some((generation) => layer.generationId === generation.id)).length;
        ${checkpointSource}
      }
    };`))(...Object.values(scope));
  return { ...api, rows: () => rows, generations: () => generations, notices, saves, state, progress,
    cleanedImages: () => cleanedImages,
    previewRows: () => previewRows ?? rows, onSave: (callback) => { onSave = callback; },
    batch: (multi, phase) => new Function('isMultiviewRequest', 'useLayerStore', compile(batchGuards[phase]))(multi, scope.useLayerStore),
    fail: (count) => { failureCount = count; }, deleteAll: () => { rows = []; },
    setGenerations: (value) => { generations = value; }, onAsset: (callback) => { onAsset = callback; } };
}
// Actual single-view completion remains pending until the projection save ACK,
// then reuses that exact generation receipt instead of a second project save.
for (const provider of ['modelview-single-view', 'liclick-atlas']) {
  const completed = fixture();
  let releaseSave, enteredSave;
  const saving = new Promise((resolve) => { enteredSave = resolve; });
  const gate = new Promise((resolve) => { releaseSave = resolve; });
  completed.onSave(() => { enteredSave(); return gate; });
  let settled = false;
  const operation = completed.complete({ ...base, metadata: { ...base.metadata, provider } })
    .then((result) => { settled = true; return result; });
  await saving;
  assert.equal(settled, false, 'rendered is not yet durably completed');
  assert.equal(completed.previewRows().length, 1);
  assert.equal(completed.progress.at(-1).title, '回贴完成，正在保存');
  releaseSave();
  const result = await operation;
  assert.deepEqual(result.generation, completed.saves[0].generations[0], 'no timestamp/metadata rewrite after ACK');
  await completed.checkpoint([result]);
  assert.equal(completed.saves.length, 1, `${provider}: two serial post-projection checkpoints reduced to one`);
}
// No ACK (save failure or pre-existing in-memory receipt) cannot bypass the
// terminal checkpoint. Deletion/failure/multiview also retain that checkpoint.
const saveFailure = fixture();
let failSave = true;
saveFailure.onSave(() => { if (failSave) { failSave = false; throw new Error('save failed'); } });
const failedProjection = await saveFailure.complete(base);
assert.equal(failedProjection.projected, false);
await saveFailure.checkpoint([failedProjection]);
assert.equal(saveFailure.saves.length, 2);
const reused = fixture();
await reused.add(base, { automatic: true });
const existing = await reused.complete(reused.generations()[0]);
await reused.checkpoint([existing]);
assert.equal(reused.saves.length, 2, 'metadata alone is not a fresh save ACK');
for (const scenario of ['multiview', 'deleted', 'failed']) {
  const completing = fixture(false, scenario === 'multiview');
  const result = await completing.complete(base);
  if (scenario === 'deleted') completing.deleteAll();
  await completing.checkpoint([result], scenario === 'failed' ? ['failure'] : []);
  assert.equal(completing.saves.length, 2, scenario);
}
// Execute both production transaction branches with the same single/multiview input.
for (const mode of ['single', 'multiview']) {
  const projection = fixture(true);
  const result = { ...base, mode, metadata: { ...base.metadata, multiview: mode === 'multiview' } };
  projection.setGenerations([result]);
  await projection.add(result, { automatic: true });
  assert.equal(projection.cleanedImages(), 1, `${mode} must use capture-mask edge cleanup`);
  await projection.add(result, { automatic: false });
  assert.equal(projection.cleanedImages(), 2);
  const row = projection.rows()[0];
  assert.equal(row.projectionCoverageMode, 'capture-mask');
  assert.equal(row.minimumProjectionFacing, 0.18);
  assert.equal(row.projectionVisibilityPolicy, 'standard');
  assert.equal(row.ignoreSourceAlpha, true);
  assert.equal(row.maskUrl, 'mask');
  assert.equal(row.maskSpace, 'projection');
  assert.equal(row.depthUrl, 'depth');
}
// Hold the actual transaction at its project-save await. A single-view layer
// must already be eligible for viewport rendering; multiview stays batched.
for (const multi of [false, true]) {
  const rendering = fixture();
  let releaseSave, enteredSave;
  const saving = new Promise((resolve) => { enteredSave = resolve; });
  const gate = new Promise((resolve) => { releaseSave = resolve; });
  rendering.onSave(() => { enteredSave(); return gate; });
  rendering.batch(multi, 0);
  const operation = rendering.add(base, { automatic: true });
  await saving;
  assert.equal(rendering.rows().length, 1, 'assets are durable before a layer is published');
  assert.equal(rendering.previewRows().length, multi ? 0 : 1, 'single-view display is independent of slow CAS persistence');
  releaseSave();
  await operation;
  rendering.batch(multi, 1);
  assert.equal(rendering.previewRows().length, 1);
}
// All completed views recover even if they are not the currently selected preview.
const restored = fixture();
restored.setGenerations([base, { ...base, id: 'g2' }]);
await restored.recover();
assert.equal(restored.rows().length, 2);
assert(restored.saves.every((save) => save.generations.some((g) => policy.hasProjectionCommit(g))));
await restored.recover();
assert.equal(restored.rows().length, 2);
// Direct completion and recovery racing share the same serialized commit.
const concurrent = fixture();
await Promise.all([concurrent.add(base, { automatic: true }), concurrent.recover(), concurrent.add(base, { automatic: true })]);
assert.equal(concurrent.rows().length, 1);
concurrent.deleteAll();
await concurrent.recover();
await concurrent.add(base, { automatic: true });
assert.equal(concurrent.rows().length, 0, 'deletion is not undone by stale batch completion');
const retry = fixture();
retry.fail(6);
await retry.recover();
assert.equal(retry.rows().length, 0);
assert.equal(retry.notices.length, 0, 'automatic projection recovery must remain silent');
assert.equal(policy.hasProjectionCommit(retry.generations()[0]), false);
await retry.recover();
assert.equal(retry.rows().length, 0);
assert.equal(retry.notices.length, 0, 'repeated automatic projection recovery must remain silent');
await retry.recover();
assert.equal(retry.rows().length, 1);
for (const change of ['project', 'cancel', 'object-deleted', 'committed-then-deleted']) {
  const crossing = fixture();
  crossing.onAsset(() => {
    if (change === 'project') crossing.state.currentProjectId = 'other';
    else if (change === 'cancel') crossing.setGenerations([{ ...base, metadata: { ...base.metadata, cancelled: true } }]);
    else if (change === 'object-deleted') crossing.setGenerations([]);
    else crossing.setGenerations([policy.withProjectionCommit(base, 'already-deleted')]);
  });
  await crossing.recover();
  assert.equal(crossing.rows().length, 0, change);
}
console.log('single-view auto projection: restored results, queue dedupe, retry, frozen capture, deletion and cancellation passed');
import { pipelineTraceDisabled } from './pipeline-trace-test-build.mjs';
