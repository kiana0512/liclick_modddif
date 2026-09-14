import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import * as THREE from 'three';

const read = (name) => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
const compile = (source) => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;
const scheduler = {};
const materialIdentity = {};
new Function('exports', compile(await read('engine/projection/projectedMaterialIdentity.ts')))(materialIdentity);
new Function('exports', 'require', compile(await read('engine/generation/gptMultiviewPairs.ts')))(scheduler, () => materialIdentity);
const { planGptViewPairs, runGptViewPairs, settleGptPairInOrder, hasResidentGptLayers, waitForGptPairPresentation } = scheduler;
const make = (names) => names.map((id) => ({ id, value: id, label: id, viewDirection: [0, 0, 1] }));
const expected1 = [['front', 'back'], ['front-left', 'back-right'], ['left', 'right'], ['back-left', 'front-right'], ['top', 'bottom']];
const expected2 = [['front', 'back'], ['left', 'right'], ['right-top', 'left-bottom'], ['front-top', 'back-bottom'], ['left-top', 'right-bottom'], ['back-top', 'front-bottom'], ['top', 'bottom']];
const ids = (pairs) => pairs.map((pair) => pair.map((view) => view.id));
for (const [preset, expected] of [['preset-1', expected1], ['preset-2', expected2]]) {
  const views = make(expected.flat().reverse()), before = JSON.parse(JSON.stringify(views));
  const fast = [expected[0], ...Array.from({ length: (expected.length - 1) / 2 }, (_, index) => expected.slice(1 + index * 2, 3 + index * 2).flat())];
  assert.deepEqual(ids(planGptViewPairs(views, preset)), fast);
  assert.deepEqual(ids(planGptViewPairs(views, preset, 'fast')), fast);
  for (const legacy of ['stable', 'unknown']) assert.deepEqual(ids(planGptViewPairs(views, preset, legacy)), fast, 'legacy arguments cannot restore retired grouping');
  const added = { id: 'user-angle', viewDirection: [0.2, 0.9, 0.3] };
  const customFast = planGptViewPairs([...views, added], 'custom', 'fast');
  assert.deepEqual(ids(customFast).flat(), [...expected.slice(0, -1).flat(), 'user-angle', 'top', 'bottom']);
  assert.deepEqual(customFast.find((group) => group.includes(added)), [added]);
  assert.deepEqual(views, before, 'thumbnail array and camera definitions are immutable');
}
assert.deepEqual(ids(planGptViewPairs(make(['front', 'left', 'back', 'right', 'top', 'bottom']), 'custom')), [['front', 'back'], ['left', 'right', 'top', 'bottom']]);
assert.deepEqual(ids(planGptViewPairs(make(['front', 'top', 'front']), 'preset-1')), [['front'], ['top']]);
assert.deepEqual(planGptViewPairs([], 'custom'), []);
assert.deepEqual(planGptViewPairs([], 'custom', 'fast'), []);
assert.deepEqual(ids(planGptViewPairs(make(['front', 'top', 'front']), 'preset-1', 'fast')), [['front'], ['top']]);

const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const first = defer(), second = defer(), presentation = defer();
const trace = []; let active = 0, peak = 0;
const running = runGptViewPairs([[1, 2], [3]], () => {}, async (pair) => {
  trace.push(`capture:${pair}`);
  await settleGptPairInOrder(pair, async (id) => {
    active++; peak = Math.max(peak, active);
    if (id < 3) await (id === 1 ? first : second).promise;
    active--; return id;
  }, async (_, id) => { trace.push(`commit:${id}`); });
  if (pair[0] === 1) await presentation.promise;
});
second.resolve(); await new Promise((r) => setTimeout(r, 0));
assert.deepEqual(trace, ['capture:1,2'], 'faster second result cannot overtake the first commit');
first.resolve(); await new Promise((r) => setTimeout(r, 0));
assert.deepEqual(trace, ['capture:1,2', 'commit:1', 'commit:2']);
presentation.resolve(); await running;
assert.deepEqual(trace, ['capture:1,2', 'commit:1', 'commit:2', 'capture:3', 'commit:3']);
assert.equal(peak, 2);
const gates = Array.from({ length: 4 }, defer), fourPresentation = defer(), fourTrace = [];
let fourActive = 0, fourPeak = 0;
const fourRunning = runGptViewPairs([[1, 2, 3, 4], [5]], () => {}, async (group) => {
  fourTrace.push(`capture:${group}`);
  await settleGptPairInOrder(group, async (id) => {
    fourActive++; fourPeak = Math.max(fourPeak, fourActive);
    if (id <= 4) await gates[id - 1].promise;
    fourActive--; return id;
  }, async (_, id) => { fourTrace.push(`commit:${id}`); });
  if (group[0] === 1) await fourPresentation.promise;
});
for (const gate of gates.slice(1).reverse()) gate.resolve();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(fourTrace, ['capture:1,2,3,4']);
gates[0].resolve(); await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(fourTrace, ['capture:1,2,3,4', 'commit:1', 'commit:2', 'commit:3', 'commit:4']);
fourPresentation.resolve(); await fourRunning;
assert.equal(fourPeak, 4);
assert.deepEqual(fourTrace.slice(-2), ['capture:5', 'commit:5']);
const retained = [];
const partial = await settleGptPairInOrder([1, 2], async (id) => { if (id === 1) throw new Error('failed'); return id; }, async (_, id) => retained.push(id));
assert.equal(partial[0].status, 'rejected'); assert.deepEqual(retained, [2]);
let cancelled = false, executed = 0;
await assert.rejects(runGptViewPairs([[1, 2], [3, 4]], () => { if (cancelled) throw new Error('cancelled'); }, async () => { executed++; cancelled = true; }), /cancelled/);
assert.equal(executed, 1);

const root = new THREE.Group(), material = new THREE.ShaderMaterial({ name: 'LiclickProjectedLayerStack:layers' });
root.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
material.userData.liclickProjectedLayerStackState = { bindings: [{ layerId: 'old' }] };
assert.equal(hasResidentGptLayers(root, ['new']), false);
material.userData.liclickProjectedLayerStackState.bindings.push({ layerId: 'new' });
assert.equal(hasResidentGptLayers(root, ['new']), true);
material.name = 'LiclickProjectedLayerWarmup';
assert.equal(hasResidentGptLayers(root, ['new']), false, 'warmup bindings cannot release the batch');
let frames = 0;
await waitForGptPairPresentation(() => true, () => {}, async () => { frames++; });
assert.equal(frames, 2);
let backgroundSettled = false;
const backgroundWait = waitForGptPairPresentation(
  () => true,
  () => {},
  async () => { frames++; },
  0,
).then(() => { backgroundSettled = true; });
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(backgroundSettled, true, 'A background lifecycle must not wait for foreground visibility');
await backgroundWait;
let delayed = 0;
let delayedReady = false;
const delayedWait = waitForGptPairPresentation(
  () => delayedReady,
  () => {},
  async () => {},
  0,
  () => { delayed++; },
);
await new Promise((resolve) => setTimeout(resolve, 70));
assert.equal(delayed, 1, 'A delayed renderer reports waiting without failing a completed generation');
delayedReady = true;
await delayedWait;
await assert.rejects(waitForGptPairPresentation(() => true, () => { throw new Error('cancelled'); }, async () => {}), /cancelled/);

// Execute both production panel adapters with controlled network/GPU ports.
// This verifies fresh guides, frozen original masks, persistence and the routing
// boundary, not just a copy of the pairing algorithm.
const panel = process.argv.includes('--baseline')
  ? execFileSync('git', ['show', 'HEAD:apps/web/src/components/panels/GeneratePanel.tsx'], { encoding: 'utf8' })
  : await read('components/panels/GeneratePanel.tsx');
const ast = ts.createSourceFile('panel.tsx', panel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = [];
let compactProgressLabelDeclaration;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ['handleGptPairedMultiviewGenerate', 'handleTextureMapMultiviewGenerate'].includes(node.name?.text)) declarations.push(node.getText(ast));
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'compactTextureProgressButtonLabel') compactProgressLabelDeclaration = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast); assert.equal(declarations.length, 2); assert(compactProgressLabelDeclaration);
const compactProgressLabel = new Function(
  `${compile(compactProgressLabelDeclaration)}; return compactTextureProgressButtonLabel;`,
)();
assert.equal(compactProgressLabel('提交纹理任务 · 第 2/7 组'), '第 2/7 组');
assert.equal(
  compactProgressLabel('结果已保存 · 等待视口渲染恢复 · 第 2/7 组'),
  '第 2/7 组',
);
assert.equal(compactProgressLabel('生成纹理贴图 · 第 2/7 组'), '生成纹理贴图 · 第 2/7 组');
async function fixture(failedView, fullyCovered = false, mode = 'stable', preset = 'custom', names = ['front', 'left', 'back', 'right', 'top', 'bottom']) {
  let sequence = 0, rows = [], frozen = false, repairCount = 0, whitePresentation = false;
  const jobs = new Map(), requests = [], captures = [], saved = [];
  const project = { id: 'project', captures: [], settings: { imageGeneration: { textureMultiviewMode: mode } } };
  const sceneRoot = new THREE.Group(), resident = new THREE.ShaderMaterial({ name: 'LiclickProjectedLayerStack:layers' });
  sceneRoot.add(new THREE.Mesh(new THREE.BoxGeometry(), resident));
  const active = () => { assert.equal(frozen, false, 'capture must not run against a frozen preview'); };
  const scope = {
    require: (name) => name.endsWith('gptMultiviewPairs') ? scheduler : {
      buildTextureMapPrompt: () => 'initial', buildTextureMapCompletionPrompt: () => 'completion',
    },
    captureObjectId: 'object', currentProject: project, selectedCameraViewPreset: preset,
    singleViewProvider: 'gpt', prompt: 'user draft', imageModel: 'gpt', resolution: '2k', resolutionToSize: { '2k': 2048 },
    objects: [{ id: 'object' }], t: (key) => key, console,
    createId: (prefix) => `${prefix}-${++sequence}`,
    throwIfTexturePipelineCancelled: (signal) => { if (signal?.aborted) throw new Error('cancelled'); },
    cancelledTextureBatchIdsRef: { current: new Set() }, cancelledGenerationIdsRef: { current: new Set() },
    pairProgressScopeRef: {},
    requirePersonalLiclickAccount: async () => {},
    getImportedModelMatrixWorld: () => ['frozen-transform'],
    hasVisibleTextureLayerCandidate: () => rows.length > 0,
    useProjectStore: { getState: () => ({ projects: [project], currentProjectId: 'project' }) },
    useSceneStore: { getState: () => ({ importedModels: [{ objectId: 'object', group: sceneRoot }] }) },
    useLayerStore: { getState: () => ({ layers: rows,
      beginProjectedPreviewBatch: () => { assert.equal(frozen, false); frozen = true; },
      endProjectedPreviewBatch: () => {
        frozen = false;
        whitePresentation = false;
        resident.userData.liclickProjectedLayerStackState = { bindings: rows.map((layer) => ({ layerId: layer.id })) };
      },
    }) },
    frameGenerationCapture: async (_objectId, _aspect, direction, _up, _signal, animate) => {
      assert.equal(animate, false, 'batch framing must not animate the live camera');
      return { camera: { direction }, target: {}, aspect: 1 };
    },
    getTextureMapMultiviewCaptures: async (views, _signal, options) => {
      if (rows.length) for (const view of views) assert(options.viewSnapshots.has(view.id), 'clay reuses each effect camera');
      active(); assert(views.length <= (captures.length ? 4 : 2)); captures.push(views.map((view) => view.id));
      // Clearing transient white mode does not synchronously restore SceneRoot's
      // resident texture material. Model the gap that the old adapter captured.
      whitePresentation = true;
      return views.map((view) => ({ viewId: view.id, cameraView: view.id, label: view.id,
        capture: { id: `capture-${view.id}`, objectId: 'object', colorUrl: `clay-${view.id}`, maskUrl: `original-mask-${view.id}`, width: 2048, height: 2048 } }));
    },
    captureCurrentColorPreview: async (input) => {
      active();
      assert.equal(whitePresentation, false, 'authored colour must be frozen BEFORE asynchronous clay presentation');
      assert.equal(input.resolution, 2048);
      assert.equal(input.colorMode, 'flat-target-coverage');
      assert(input.cameraSnapshot, 'effect receives its frozen camera');
      return { colorUrl: `effect:${rows.map((row) => row.id)}` };
    },
    prepareSingleViewTextureCompletion: async (input) => ({ hasVisibleTexture: true, imageUrl: fullyCovered ? undefined : input.currentEffectUrl, uncoveredPixelCount: fullyCovered ? 0 : 10 }),
    persistCaptureAssets: async (items) => items,
    updateProjectById: (_, patch) => Object.assign(project, patch),
    saveCriticalProjectState: async (patch) => { saved.push(patch); },
    saveGenerationStateBestEffort: async () => {},
    start: (job) => jobs.set(job.id, job), addProjectGeneration: () => {}, finish: () => {},
    syncGeneration: (job) => jobs.set(job.id, job),
    isCancelledGeneration: () => false,
    getUserFacingGenerationError: (error) => String(error),
    createFailedGeneration: (job, error) => ({ ...job, status: 'failed', metadata: { ...job.metadata, error } }),
    mergeGenerationMetadataPreservingStartedAt: (a, b) => ({ ...a, ...b }),
    submitGptTextureView: async (id, prompt, guide, reference, capture) => {
      assert.equal(reference.id, 'material', 'second input remains the user-selected material reference');
      assert(saved.some((patch) => patch.captures?.some((item) => item.id === capture.id)), 'capture must be durable before submission');
      requests.push({ id, prompt, guide, capture });
      assert.equal(capture.maskUrl, `original-mask-${jobs.get(id).metadata.cameraViewId}`);
      return jobs.get(id);
    },
    waitForLiclickGeneration: async (job) => {
      if (job.metadata.cameraViewId === failedView) throw new Error('controlled network failure');
      return { ...job, status: 'succeeded', resultUrl: `result:${job.id}` };
    },
    addGenerationAsProjectedLayer: async (job) => {
      const layer = { id: job.metadata.cameraViewId, generationId: job.id, visible: true };
      rows.push(layer); return layer;
    },
    requestContentAwareRepair: async () => { repairCount++; },
    waitForBrowserPaint: async () => {}, updateTexturePipelineProgress: () => {}, setGenerateNotice: () => {}, pushToast: () => {},
  };
  const start = new Function(...Object.keys(scope), compile(`${declarations.join('\n')}\nreturn handleTextureMapMultiviewGenerate;`))(...Object.values(scope));
  let error;
  try { await start({ id: 'material' }, make(names), 'multi'); }
  catch (reason) { error = reason; }
  return { requests, captures, rows, error, repairCount, jobs };
}
const success = await fixture();
assert.ifError(success.error);
assert.deepEqual(success.captures, [['front', 'back'], ['left', 'right', 'top', 'bottom']]);
assert.deepEqual(success.rows.map((row) => row.id), success.captures.flat());
assert.deepEqual(success.requests.map((request) => request.prompt), ['initial', 'initial', 'completion', 'completion', 'completion', 'completion']);
assert.deepEqual(success.requests.map((request) => request.guide.url), ['clay-front', 'clay-back', ...Array(4).fill('effect:front,back')]);
assert.equal(new Set([...success.jobs.values()].map((job) => job.metadata.textureBatchId)).size, 1);
assert.equal(success.repairCount, 1);
const covered = await fixture(undefined, true);
assert.ifError(covered.error);
assert.equal(covered.requests.length, 6, 'fully textured selected angles are not silently skipped');
assert.deepEqual(covered.requests.map((request) => request.guide.url), success.requests.map((request) => request.guide.url));
const failure = await fixture('back');
assert(failure.error);
assert.deepEqual(failure.captures, [['front', 'back']]);
assert.deepEqual(failure.rows.map((row) => row.id), ['front']);
assert.equal(failure.repairCount, 0);
for (const [preset, expected] of [['preset-1', expected1], ['preset-2', expected2]]) for (const stored of [undefined, 'stable', 'fast', 'unknown']) {
  const result = await fixture(undefined, false, stored, preset, expected.flat());
  assert.ifError(result.error);
  assert.deepEqual(result.captures.map((group) => group.length), preset === 'preset-1' ? [2, 4, 4] : [2, 4, 4, 4]);
  assert.deepEqual(result.rows.map((row) => row.id), expected.flat());
  assert.equal(result.repairCount, 1);
  let offset = 0;
  for (const group of result.captures) {
    const groupRequests = result.requests.slice(offset, offset + group.length);
    assert.deepEqual(groupRequests.map((request) => request.guide.url), offset
      ? group.map(() => `effect:${expected.flat().slice(0, offset)}`)
      : group.map((id) => `clay-${id}`));
    offset += group.length;
  }
}
const fastFailure = await fixture('right-top', false, 'fast', 'preset-2', expected2.flat());
assert(fastFailure.error);
assert.deepEqual(fastFailure.captures.map((group) => group.length), [2, 4]);
assert.deepEqual(fastFailure.rows.map((row) => row.id), ['front', 'back', 'left', 'right', 'left-bottom']);
assert.equal(fastFailure.repairCount, 0);

assert.doesNotMatch(panel, /textureMultiviewMode|稳定 · 2张并发|aria-label="多视图加速模式"/);
assert.match(panel, /planGptViewPairs\(requestedViews, selectedCameraViewPreset\)/);
assert.doesNotMatch(panel, /aria-label="多视图并发策略"|加速 · 最多4张并发/);
console.log('Fixed accelerated GPT groups: defaults, legacy settings, fresh inputs, ordered commits, cancellation and failure contracts passed.');
