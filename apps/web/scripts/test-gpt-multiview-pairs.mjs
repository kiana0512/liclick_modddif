import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import * as THREE from 'three';
import { ownershipPolicy } from './test-texture-generation-recovery-ownership.mjs';

const read = (name) => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
const compile = (source) => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;
const scheduler = {};
const materialIdentity = {};
new Function('exports', compile(await read('engine/projection/projectedMaterialIdentity.ts')))(materialIdentity);
new Function('exports', 'require', compile(await read('engine/generation/gptMultiviewPairs.ts')))(scheduler, () => materialIdentity);
const {
  planGptViewPairs,
  runGptViewPairs,
  settleGptPairInOrder,
  gptPairCompletionDisposition,
  hasResidentGptLayers,
  waitForGptPairPresentation,
} = scheduler;
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
assert.equal(gptPairCompletionDisposition(2, 2, 0), 'complete');
assert.equal(gptPairCompletionDisposition(2, 1, 1), 'continue-after-qa');
assert.equal(gptPairCompletionDisposition(4, 2, 2), 'continue-after-qa');
assert.equal(gptPairCompletionDisposition(2, 1, 0), 'stop');
assert.equal(gptPairCompletionDisposition(2, 0, 1), 'stop');
assert.equal(gptPairCompletionDisposition(2, 3, 0), 'stop');

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
material.name = 'LiclickUvOverlayPreview';
material.userData.liclickResidentUvProjectionLayers = ['old'];
assert.equal(hasResidentGptLayers(root, ['new']), false, 'old incremental atlas cannot release a new result');
material.userData.liclickResidentUvProjectionLayers.push('new');
assert.equal(hasResidentGptLayers(root, ['new']), true, 'in-place UV updates need no resident event');
assert.equal(hasResidentGptLayers(undefined, ['new']), false);
assert.equal(hasResidentGptLayers(new THREE.Group(), ['new']), false);
root.visible = false;
assert.equal(hasResidentGptLayers(root, ['new']), false);
root.visible = true;
const pendingMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
root.add(pendingMesh);
assert.equal(hasResidentGptLayers(root, ['new']), false, 'all visible mesh materials must be ready');
root.remove(pendingMesh); pendingMesh.geometry.dispose(); pendingMesh.material.dispose();
let checks = 0, paintChecks = 0;
await waitForGptPairPresentation(
  () => ++checks !== 2,
  () => {},
  async () => { paintChecks++; },
);
assert.equal(paintChecks, 4, 'readiness lost during paint must wait and recheck');
let abortPending = false;
const pendingCancellation = waitForGptPairPresentation(
  () => false,
  () => { if (abortPending) throw new Error('cancelled'); },
  async () => {},
);
abortPending = true;
await assert.rejects(pendingCancellation, /cancelled/);
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
let textureEntryDeclaration;
let compactProgressLabelDeclaration;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleTextureMapGenerate') textureEntryDeclaration = node.getText(ast);
  if (ts.isFunctionDeclaration(node) && [
    'markSilhouetteRetryFailed',
    'submitSilhouetteAlignmentRetry',
    'submitGptTextureViewWithSilhouetteRetry',
    'waitForGptTextureGenerationWithSilhouetteRetry',
    'handleGptPairedMultiviewGenerate',
    'handleTextureMapMultiviewGenerate',
  ].includes(node.name?.text)) declarations.push(node.getText(ast));
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'compactTextureProgressButtonLabel') compactProgressLabelDeclaration = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast); assert.equal(declarations.length, 6); assert(compactProgressLabelDeclaration);
const compactProgressLabel = new Function(
  `${compile(compactProgressLabelDeclaration)}; return compactTextureProgressButtonLabel;`,
)();
assert.equal(compactProgressLabel('提交纹理任务 · 第 2/7 组'), '第 2/7 组');
assert.equal(
  compactProgressLabel('结果已保存 · 等待视口渲染恢复 · 第 2/7 组'),
  '第 2/7 组',
);
assert.equal(compactProgressLabel('生成纹理贴图 · 第 2/7 组'), '生成纹理贴图 · 第 2/7 组');
async function fixture(failedView, fullyCovered = false, mode = 'stable', preset = 'custom', names = ['front', 'left', 'back', 'right', 'top', 'bottom'], captureError, slowStatusSave = false, silhouetteFailure) {
  let sequence = 0, rows = [], frozen = false, repairCount = 0, whitePresentation = false;
  const jobs = new Map(), requests = [], captures = [], saved = [];
  const checkpoint = defer();
  let statusSaves = 0, observedWhileSaving = false;
  const project = { id: 'project', captures: [], settings: { imageGeneration: { textureMultiviewMode: mode } } };
  const sceneRoot = new THREE.Group(), resident = new THREE.ShaderMaterial({ name: 'LiclickProjectedLayerStack:layers' });
  sceneRoot.add(new THREE.Mesh(new THREE.BoxGeometry(), resident));
  const active = () => { assert.equal(frozen, false, 'capture must not run against a frozen preview'); };
  const silhouetteRetryPolicy = {
    GPT_SILHOUETTE_RETRY_LIMIT: 1,
    SILHOUETTE_RETRY_FAILURE_MESSAGE: 'alignment drift; retrying once',
    silhouetteRetryAttempt: (metadata) => metadata.silhouetteRetryAttempt ?? 0,
    isGptReturnSilhouetteMismatch: (error) => error?.code === 'GPT_RETURN_SILHOUETTE_MISMATCH',
    terminalSilhouetteRetryError: () => Object.assign(
      new Error('连续两次 alignment failed'),
      { code: 'GPT_RETURN_SILHOUETTE_MISMATCH' },
    ),
    createTextureMapSilhouetteRetry: (failed) => {
      const id = `${failed.id}-silhouette-retry-1`;
      return {
        viewLabel: failed.metadata.cameraViewLabel ?? 'current',
        generation: {
          ...failed,
          id,
          prompt: `alignment-retry:${failed.prompt}`,
          resultUrl: undefined,
          status: 'running',
          metadata: {
            ...failed.metadata,
            clientGenerationId: id,
            serverJobId: undefined,
            taskId: undefined,
            completedAt: undefined,
            error: undefined,
            framingRestored: undefined,
            generationFraming: undefined,
            serverSubmitted: false,
            startedAt: new Date().toISOString(),
            silhouetteRetryOf: failed.id,
            silhouetteRetryAttempt: 1,
          },
        },
      };
    },
  };
  const scope = {
    ...ownershipPolicy,
    require: (name) => name.endsWith('gptMultiviewPairs')
      ? scheduler
      : name.endsWith('gptReturnSilhouetteRetry')
        ? silhouetteRetryPolicy
        : { buildTextureMapPrompt: () => 'initial', buildTextureMapCompletionPrompt: () => 'completion' },
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
      if (captureError && rows.length >= (captureError.after ?? 2)) throw (captureError.error ?? captureError);
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
    saveGenerationStateBestEffort: async () => {
      statusSaves++;
      if (slowStatusSave && statusSaves === 1) await checkpoint.promise;
    },
    start: (job) => jobs.set(job.id, job), addProjectGeneration: () => {}, finish: () => {},
    syncGeneration: (job) => jobs.set(job.id, job),
    isCancelledGeneration: () => false,
    getUserFacingGenerationError: (error) => String(error),
    createFailedGeneration: (job, error, extra = {}) => ({ ...job, status: 'failed', metadata: { ...job.metadata, ...extra, error } }),
    mergeGenerationMetadataPreservingStartedAt: (a, b) => ({ ...a, ...b }),
    submitGptTextureView: async (id, prompt, guide, reference, capture) => {
      assert.equal(reference.id, 'material', 'second input remains the user-selected material reference');
      assert(saved.some((patch) => patch.captures?.some((item) => item.id === capture.id)), 'capture must be durable before submission');
      requests.push({ id, prompt, guide, capture });
      const job = jobs.get(id);
      assert.equal(capture.maskUrl, `original-mask-${job.metadata.cameraViewId}`);
      if (
        silhouetteFailure?.stage === 'submit' &&
        job.metadata.cameraViewId === silhouetteFailure.view &&
        silhouetteFailure.failures > (job.metadata.silhouetteRetryAttempt ?? 0)
      ) {
        throw Object.assign(new Error('return QA mismatch'), {
          code: silhouetteFailure.code ?? 'GPT_RETURN_SILHOUETTE_MISMATCH',
        });
      }
      return job;
    },
    waitForLiclickGeneration: async (job) => {
      if (slowStatusSave && !observedWhileSaving) {
        observedWhileSaving = true;
        assert.equal(statusSaves, 1, 'status checkpoint started before result observation');
        checkpoint.resolve();
      }
      if (
        silhouetteFailure &&
        (silhouetteFailure?.stage ?? 'wait') === 'wait' &&
        job.metadata.cameraViewId === silhouetteFailure.view &&
        (silhouetteFailure.failures > (job.metadata.silhouetteRetryAttempt ?? 0))
      ) {
        throw Object.assign(new Error('return QA mismatch'), {
          code: silhouetteFailure.code ?? 'GPT_RETURN_SILHOUETTE_MISMATCH',
        });
      }
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
  return { requests, captures, rows, error, repairCount, jobs, observedWhileSaving };
}
const slowSaveRun = fixture(undefined, false, 'fast', 'custom', undefined, undefined, true);
const slowSaveResult = await Promise.race([
  slowSaveRun,
  new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(Error('result polling waited for status-only save')), 1500);
    void slowSaveRun.finally(() => clearTimeout(timeout));
  }),
]);
assert.ifError(slowSaveResult.error);
assert.equal(slowSaveResult.observedWhileSaving, true);
assert.equal(slowSaveResult.rows.length, 6, 'all groups still complete and checkpoint');
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
const recoveredSilhouette = await fixture(
  undefined, false, 'fast', 'custom', undefined, undefined, false,
  { view: 'front', failures: 1 },
);
assert.ifError(recoveredSilhouette.error);
assert.equal(recoveredSilhouette.requests.length, 7, 'one rejected silhouette submits exactly one replacement view');
assert.equal(recoveredSilhouette.requests.filter((request) => request.capture.id === 'capture-front').length, 2);
assert.match(recoveredSilhouette.requests.find((request) => request.id.endsWith('-silhouette-retry-1')).prompt, /^alignment-retry:/);
assert.deepEqual(recoveredSilhouette.rows.map((row) => row.id), recoveredSilhouette.captures.flat());
const recoveredImmediateSilhouette = await fixture(
  undefined, false, 'fast', 'custom', undefined, undefined, false,
  { view: 'front', failures: 1, stage: 'submit' },
);
assert.ifError(recoveredImmediateSilhouette.error);
assert.equal(recoveredImmediateSilhouette.requests.length, 7, 'an immediate bad response also receives only one replacement');
assert.deepEqual(recoveredImmediateSilhouette.rows.map((row) => row.id), recoveredImmediateSilhouette.captures.flat());
const rejectedSilhouette = await fixture(
  undefined, false, 'fast', 'custom', undefined, undefined, false,
  { view: 'front', failures: 2 },
);
assert.ifError(rejectedSilhouette.error);
assert.equal(rejectedSilhouette.requests.length, 7, 'the retry budget cannot create a submission storm');
assert.deepEqual(rejectedSilhouette.captures, [['front', 'back'], ['left', 'right', 'top', 'bottom']]);
assert.deepEqual(
  rejectedSilhouette.rows.map((row) => row.id),
  ['back', 'left', 'right', 'top', 'bottom'],
  'the rejected view is skipped while its sibling and later group continue',
);
assert.equal(rejectedSilhouette.repairCount, 1);
const rejectedRatio = await fixture(
  undefined, false, 'fast', 'custom', undefined, undefined, false,
  { view: 'front', failures: 1, code: 'GPT_RETURN_FRAME_RATIO_MISMATCH' },
);
assert.ifError(rejectedRatio.error);
assert.equal(rejectedRatio.requests.length, 6, 'ratio QA does not consume the silhouette retry budget');
assert.deepEqual(rejectedRatio.captures, [['front', 'back'], ['left', 'right', 'top', 'bottom']]);
assert.deepEqual(rejectedRatio.rows.map((row) => row.id), ['back', 'left', 'right', 'top', 'bottom']);
assert.equal(rejectedRatio.repairCount, 1);
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

// The first group is committed, then the next group's UV capture aborts.
// This is NOT a user cancellation and must reach the real entry-point notice.
const generationErrors = {};
new Function('exports', compile(await read('services/generationErrorMessage.ts')))(generationErrors);
const internalAbort = new DOMException('UV display superseded.', 'AbortError');
const interrupted = await fixture(undefined, false, 'fast', 'custom', undefined, internalAbort);
assert.equal(interrupted.error, internalAbort);
assert.deepEqual(interrupted.rows.map(row => row.id), ['front', 'back']);
assert.equal(interrupted.requests.length, 2, 'no next-group submission after failed capture');
assert.equal(interrupted.repairCount, 0);
assert.equal(generationErrors.isGenerationCancellation(internalAbort), false);
assert.equal(generationErrors.isGenerationCancellation(new DOMException('Aborted', 'AbortError')), false);
assert.equal(generationErrors.isGenerationCancellation(new Error('相机已移动，已取消生成取景。')), false);
assert.equal(generationErrors.isGenerationCancellation(new Error('用户已终止纹理贴图生成任务。')), true);
assert.match(generationErrors.getUserFacingGenerationError(internalAbort), /意外中断/);

async function testEntryFailure(error, cancel = false) {
  const notices = [], toasts = [], logged = [], locks = new Set();
  const ownership = ownershipPolicy.createTextureGenerationRecoveryOwnership();
  let progress, finished = 0, saved = 0;
  const scope = {
    ...generationErrors, textureViewMode: 'multi', cameraViews: make(['front', 'back']),
    currentProjectId: 'project', textureRecoveryOwnershipRef: { current: ownership },
    workflowSubmissionLocked: false, previewIsGenerating: false,
    selectedSingleReference: undefined, selectedMultiviewReference: { id: 'reference' },
    submitLocksRef: { current: locks }, texturePipelineAbortControllerRef: {},
    setSubmissionActive() {}, setTexturePipelineCancelling() {}, setCancelTextureSnapshotConfirmOpen() {},
    setTexturePipelineProgress: value => { progress = typeof value === 'function' ? value(progress) : value; },
    updateTexturePipelineProgress() {}, setGenerateNotice: value => notices.push(value),
    pushToast: value => toasts.push(value), finish: () => { finished++; },
    saveGenerationStateBestEffort: async () => { saved++; },
    console: { error: (...args) => logged.push(args) },
    handleTextureMapMultiviewGenerate: async (_ref, _views, _mode, signal) => {
      assert.equal(signal.aborted, false);
      assert.equal(ownership.backgroundTicket('project', 'texture-map')(), false);
      if (cancel) scope.texturePipelineAbortControllerRef.current.abort('user-cancelled-texture-generation');
      throw error;
    },
  };
  const entry = new Function(...Object.keys(scope), `${compile(textureEntryDeclaration)}; return handleTextureMapGenerate;`)(...Object.values(scope));
  await entry();
  assert.equal(ownership.backgroundTicket('project', 'texture-map')(), true, 'error/cancel releases foreground ownership');
  assert.equal(locks.size, 0); assert.equal(finished, 1); assert.equal(progress, undefined);
  assert.equal(scope.texturePipelineAbortControllerRef.current, undefined);
  if (cancel) {
    assert.equal(notices.at(-1), undefined); assert.equal(toasts.length, 0); assert.equal(logged.length, 0);
  } else {
    assert.equal(notices.at(-1).tone, 'error'); assert.equal(toasts.at(-1).tone, 'error');
    assert.equal(logged[0][1], error); assert.equal(saved, 1);
    assert.equal(notices.at(-1).message, generationErrors.getUserFacingGenerationError(error, '纹理贴图生成失败，请稍后重试。'));
  }
}
await testEntryFailure(interrupted.error);
const thirdGroupInterrupted = await fixture(undefined, false, 'fast', 'preset-1', expected1.flat(), { after: 6, error: internalAbort });
assert.equal(thirdGroupInterrupted.error, internalAbort);
assert.equal(thirdGroupInterrupted.rows.length, 6);
assert.equal(thirdGroupInterrupted.requests.length, 6, 'third group is not submitted with an invalid guide');
assert.equal(thirdGroupInterrupted.repairCount, 0);
await testEntryFailure(thirdGroupInterrupted.error);
await testEntryFailure(new Error('UV 预览在截图期间发生变化，请重试。'));
await testEntryFailure(new Error('相机已移动，已取消生成取景。'));
await testEntryFailure(new Error('network failed'));
await testEntryFailure(new DOMException('Aborted', 'AbortError'), true);
assert.match(panel, /generateNotice\.tone !== 'info' \|\| !isVerboseGenerationNotice/);
console.log('Fixed accelerated GPT groups: defaults, legacy settings, fresh inputs, ordered commits, cancellation and failure contracts passed.');
