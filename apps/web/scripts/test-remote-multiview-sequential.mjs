import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers';
import ts from 'typescript';
import * as THREE from 'three';

const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const presentation = {}, identity = {};
new Function('exports', compile(await readFile(new URL('../src/engine/projection/projectedMaterialIdentity.ts', import.meta.url), 'utf8')))(identity);
new Function('exports', 'require', compile(await readFile(new URL('../src/engine/generation/gptMultiviewPairs.ts', import.meta.url), 'utf8')))(presentation, () => identity);

const [panel, transformActions, sequenceSource] = await Promise.all([
  readFile(new URL('../src/components/panels/GeneratePanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/engine/scene/transformActions.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/engine/generation/remoteMultiviewSequence.ts', import.meta.url), 'utf8'),
]);

const transpiledSequence = ts.transpileModule(sequenceSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sequenceModule = { exports: {} };
new Function('module', 'exports', transpiledSequence)(sequenceModule, sequenceModule.exports);
const { insertCameraViewByPreviewOrder, usesGptTextureGeneration } = sequenceModule.exports;

const ordered = insertCameraViewByPreviewOrder(
  [
    { id: 'front', viewDirection: [0, 0, 1] },
    { id: 'left', viewDirection: [-1, 0, 0] },
    { id: 'top', viewDirection: [0, 1, 0] },
    { id: 'bottom', viewDirection: [0, -1, 0] },
  ],
  { id: 'front-left', viewDirection: [-1, 0, 1] },
);
assert.deepEqual(
  ordered.map((view) => view.id),
  ['front', 'front-left', 'left', 'top', 'bottom'],
  'new ordinary views must be inserted by adjacency before the GPT pole tail',
);
assert.equal(usesGptTextureGeneration({ id: 'top', viewDirection: [0, 1, 0] }), true);
assert.equal(
  usesGptTextureGeneration({ id: 'top-oblique', viewDirection: [0, 0.89, 0.46] }),
  false,
);
assert.equal(usesGptTextureGeneration({ id: 'bottom', viewDirection: [0, -1, 0] }), true);
const orderedWithCustomTop = insertCameraViewByPreviewOrder(ordered, {
  id: 'custom-top',
  viewDirection: [0.1, 0.99, 0],
});
assert.deepEqual(
  orderedWithCustomTop.map((view) => view.id),
  ['front', 'front-left', 'left', 'top', 'custom-top', 'bottom'],
  'custom pole views must use the GPT top/bottom tail instead of interrupting remote views',
);

const start = panel.indexOf('async function handleRemoteSequentialMultiviewGenerate');
const end = panel.indexOf('async function handleGptPairedMultiviewGenerate', start);
assert(start >= 0 && end > start, 'the remote multiview sequential orchestrator must exist');
const flow = panel.slice(start, end);
const persistPairedStart = panel.indexOf('async function persistPairedMultiviewReference');
const persistPairedEnd = panel.indexOf(
  'async function generatePairedMultiviewReference',
  persistPairedStart,
);
assert(
  persistPairedStart >= 0 && persistPairedEnd > persistPairedStart,
  'paired multiview reference persistence must exist',
);
const persistPairedFlow = panel.slice(persistPairedStart, persistPairedEnd);

// Both providers are selectable; GPT is the initial selection, shared by tabs.
assert.match(panel, /const \[singleViewProvider, setSingleViewProvider\] = useState<SingleViewProvider>\('gpt'\)/);
const switchSource = panel.match(/<SegmentedControl<SingleViewProvider>[\s\S]*?\/>/)?.[0];
assert.ok(switchSource);
for (const value of ['gpt', 'remote']) assert.ok(switchSource.includes(`value: '${value}'`));
assert.match(switchSource, /label: 'GPT'/);
assert.match(switchSource, /label: 'ModelView'/);
assert.equal((switchSource.match(/disabled: workflowConfigurationLocked \|\| workflowSubmissionLocked/g) ?? []).length, 2);
const onChangeSource = switchSource.match(/onChange=\{\(provider\) => \{([\s\S]*?)\}\}/)?.[1];
assert.ok(onChangeSource);
for (const configurationLocked of [false, true]) for (const submissionLocked of [false, true]) {
  const changes = [];
  const switchProvider = new Function('provider', 'workflowConfigurationLocked', 'workflowSubmissionLocked', 'setSingleViewProvider', onChangeSource);
  for (const provider of ['remote', 'gpt', 'remote']) switchProvider(provider, configurationLocked, submissionLocked, value => changes.push(value));
  assert.deepEqual(changes, configurationLocked || submissionLocked ? [] : ['remote', 'gpt', 'remote']);
}
assert.match(panel, /\(isTextureMapTab && singleViewProvider === 'gpt'\) \|\| isGptLocalRepaint/);
assert.doesNotMatch(panel, /label: 'GPT2'|label: '远端'/);
const routeStart = panel.indexOf('async function handleTextureMapMultiviewGenerate(');
const routeEnd = panel.indexOf('    const objectId = captureObjectId;', routeStart);
assert(routeStart >= 0 && routeEnd > routeStart);
const routeJs = ts.transpileModule(`${panel.slice(routeStart, routeEnd)}\n}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const providerBinding = panel.match(/const \[singleViewProvider, setSingleViewProvider\] = useState<SingleViewProvider>\('gpt'\);/)[0];
const bindingJs = ts.transpileModule(providerBinding, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
for (const provider of ['gpt', 'remote']) for (const mode of ['single', 'multi']) {
  const calls = [];
  const scope = {
    useState: () => [provider, () => {}],
    throwIfTexturePipelineCancelled: () => {}, captureObjectId: 'object',
    requireFeishuLogin: async () => { calls.push('remote-login'); return true; },
    requirePersonalLiclickAccount: async () => { calls.push('gpt-login'); },
    usesGptTextureGeneration: () => true,
    handleRemoteSequentialMultiviewGenerate: async () => { calls.push('remote-generation'); },
    handleGptPairedMultiviewGenerate: async () => { calls.push('gpt-pairs'); },
  };
  const route = new Function(...Object.keys(scope), `${bindingJs}\n${routeJs}\nreturn handleTextureMapMultiviewGenerate;`)(...Object.values(scope));
  await route({ id: 'material' }, [{ id: 'front' }, { id: 'top' }, { id: 'custom' }], mode);
  const expected = provider === 'remote'
    ? mode === 'multi' ? ['remote-login', 'remote-generation'] : ['remote-login']
    : mode === 'multi' ? ['gpt-login', 'gpt-pairs'] : ['gpt-login'];
  assert.deepEqual(calls, expected, `${provider}/${mode} must use its own authorization and route`);
}
assert.match(
  panel,
  /isMultiviewRequest && usesRemoteTextureGeneration[\s\S]*?handleRemoteSequentialMultiviewGenerate/,
  'remote multiview requests must route into the sequential orchestrator',
);
assert.match(
  flow,
  /const orderedViews = \[\.\.\.requestedViews\][\s\S]*?for \(let index = 0; index < viewCount; index \+= 1\)/,
  'remote generation must consume the exact preview order in one serial loop',
);
assert.doesNotMatch(
  flow,
  /preferredFirstViewId|activeCameraViewId\s*\)/,
  'the active thumbnail must not reorder the submitted preview sequence',
);
assert.match(
  flow,
  /setCameraToObjectDirection\(objectId, view\.viewDirection, view\.viewUp\)[\s\S]*?await waitForBrowserPaint\(\)[\s\S]*?captureCurrentColorPreview/,
  'the visible viewport must move and settle before the current material is captured',
);
assert.match(
  flow,
  /prepareSingleViewTextureCompletion\([\s\S]*?uncoveredPixelCount === 0[\s\S]*?continue;/,
  'fully covered views must skip remote generation',
);
assert.match(
  flow,
  /generateSingleViewInpaint\([\s\S]*?completion-mask\.png[\s\S]*?: await modelviewClient\.generateSingleView\(/,
  'partial views must use expanded-mask inpaint while all-clay views use ordinary generation',
);
assert.doesNotMatch(
  flow,
  /usesGptTextureGeneration|submitGptTextureView|waitForGptTextureGeneration/,
  'top and bottom must never divert to GPT in the serial ModelView chain',
);
assert.doesNotMatch(
  panel,
  /requestedViews\.some\(usesGptTextureGeneration\)[\s\S]*?requirePersonalLiclickAccount\(\)/,
  'ModelView must not require a GPT account',
);
assert.match(flow, /whiteFill: true/);
assert.doesNotMatch(flow, /prompt: texturePrompt/);

// Execute the production serial loop, including top/bottom, resident barriers,
// covered-view skipping and cancellation/error stopping the remaining views.
const serialJs = ts.transpileModule(flow
  .replace("import('@/services/modelviewApiClient')", "Promise.resolve({ createModelviewApiClient: modelviewFactory })")
  .replace("import('@/engine/generation/gptMultiviewPairs')", "Promise.resolve(presentationModule)"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
for (const outcome of ['success', 'textured', 'covered', 'cancel', 'failure', 'already-resident', 'capture-failure', 'capture-cancel', 'save-failure']) {
  const views = ['front', 'top', 'bottom'].map((id, i) => ({ id, label: id,
    viewDirection: i === 0 ? [0, 0, 1] : [0, i === 1 ? 1 : -1, 0], viewUp: [0, 1, 0] }));
  const captures = views.map(view => ({ viewId: view.id, cameraView: {}, cameraSnapshot: { view: view.id },
    capture: { id: view.id, colorUrl: 'clay-' + view.id, maskUrl: 'mask-' + view.id, normalUrl: 'normal-' + view.id, width: 2048, height: 2048 } }));
  const calls = [], projected = [], committed = [], prepared = [], progress = [];
  let persisted = [{ id: 'unrelated-capture' }], savedCaptureId, frozenCamera, clayOverride = false;
  let requests = 0, residents = 0, restored = 0, cancelled = false;
  const root = new THREE.Group();
  const reusedMaterial = new THREE.ShaderMaterial({ name: 'LiclickUvOverlayPreview' });
  reusedMaterial.userData.liclickResidentUvProjectionLayers = [];
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), reusedMaterial));
  const remote = async (kind, input) => {
    assert.equal(residents, requests, 'No next request before the previous projection is GPU-resident');
    requests++;
    assert.equal(prepared.length, requests, 'First request must not wait for later captures');
    assert.equal(savedCaptureId, input.captureId, 'Capture must be saved before submitting generation');
    assert.equal(input.prompt, undefined);
    assert.equal(input.image.dataUrl, 'white-' + input.captureId);
    assert.equal(input.normalImage.dataUrl, 'normal-' + input.captureId, 'Every angle must submit its own unchanged captured normal');
    assert.equal(input.normalImage.path, input.captureId + '-normal.png');
    assert.equal(input.materialImage.dataUrl, 'material');
    assert.equal(Boolean(input.mask), kind === 'inpaint');
    calls.push([kind, input.captureId]);
    if (outcome === 'failure' && requests === 2) throw new Error('remote failure');
    return { id: input.clientGenerationId, status: 'succeeded', resultUrl: 'result', metadata: {} };
  };
  const scope = {
    presentationModule: presentation,
    captureObjectId: 'object', currentProject: { id: 'project', captures: [] },
    getImportedModelMatrixWorld: () => [],
    useSceneStore: { getState: () => ({ importedModels: [{ objectId: 'object', group: root }],
      viewport: { controls: { target: { clone: () => ({}) } }, camera: {} },
      requestCameraRestore: () => { restored++; } }) },
    serializeCamera: () => ({}), activeCameraViewId: 'front', createId: label => label,
    cancelledTextureBatchIdsRef: { current: new Set() },
    modelviewFactory: () => ({ generateSingleView: input => remote('full', input),
      generateSingleViewInpaint: input => remote('inpaint', input) }),
    updateTexturePipelineProgress: value => progress.push(value),
    frameGenerationCapture: async (_object, aspect, direction) => {
      assert.equal(aspect, 1);
      frozenCamera = { view: views.find(view => view.viewDirection === direction).id };
      return frozenCamera;
    },
    getTextureMapMultiviewCaptures: async (nextViews, _signal, options) => {
      assert.equal(nextViews.length, 1, 'Capture only the current view');
      assert.equal(residents, requests, 'Next capture must wait for previous GPU presentation');
      const id = nextViews[0].id;
      assert.equal(options.cameraSnapshot.view, id);
      assert.equal(options.cameraSnapshot, frozenCamera);
      assert.equal(options.reportProgress, false, 'Per-view capture must not reset batch progress');
      prepared.push(id);
      clayOverride = true;
      if (outcome === 'capture-failure' && prepared.length === 2) throw new Error('capture failure');
      if (outcome === 'capture-cancel') cancelled = true;
      return [captures.find(item => item.viewId === id)];
    },
    useProjectStore: { getState: () => ({ projects: [{ id: 'project', captures: persisted }] }) },
    persistCaptureAssets: async value => value,
    updateProjectById: (_id, update) => { persisted = update.captures; },
    saveCriticalProjectState: async update => {
      if (outcome === 'save-failure' && prepared.length === 2) throw new Error('save failure');
      savedCaptureId = update.captures[0].id;
      assert.ok(update.captures.some(capture => capture.id === 'unrelated-capture'));
      assert.equal(update.captures[0].normalUrl, 'normal-' + savedCaptureId);
      // Simulate a concurrent editor capture between serial views.
      if (!persisted.some(capture => capture.id === 'editor-capture')) persisted.push({ id: 'editor-capture' });
      else assert.ok(update.captures.some(capture => capture.id === 'editor-capture'));
    },
    throwIfTexturePipelineCancelled: () => { if (cancelled) throw new Error('cancelled'); },
    urlToDataUrl: async value => value, setActiveCameraViewId() {}, setCameraToObjectDirection() {},
    waitForBrowserPaint: async () => {}, hasVisibleTextureLayerCandidate: () => residents > 0 || outcome === 'textured',
    captureCurrentColorPreview: async input => {
      assert.equal(clayOverride, false, 'Current texture must be captured before clay replaces its material');
      assert.equal(input.cameraSnapshot.view, views[requests].id);
      assert.equal(input.cameraSnapshot, frozenCamera);
      return { colorUrl: 'effect' };
    }, resolution: '2K', resolutionToSize: { '2K': 2048 },
    prepareSingleViewTextureCompletion: async input => {
      assert.equal(input.whiteFill, true);
      assert.equal(input.fullObject, requests === 0 && outcome !== 'textured');
      return { hasVisibleTexture: requests > 0 || outcome === 'textured', uncoveredPixelCount: outcome === 'covered' && requests >= 2 ? 0 : 100,
        imageUrl: 'white-' + views[requests].id, completionMaskUrl: 'expanded-mask' };
    }, referenceGroupId: () => 'reference-group', start() {}, addProjectGeneration() {},
    saveGenerationStateBestEffort: async () => {},
    mergeGenerationMetadataPreservingStartedAt: (a, b) => ({ ...a, ...b }),
    syncGeneration: value => { if (value.metadata?.projectionCommittedAt) committed.push(value.id); },
    addGenerationAsProjectedLayer: async generation => {
      projected.push(generation.id);
      // Reuse the same material, emitting NO event. Cover both completion
      // before subscription and asynchronous in-place texture replacement.
      const present = () => {
        clayOverride = false;
        residents++;
        reusedMaterial.userData.liclickResidentUvProjectionLayers.push('layer-' + generation.id);
        if (outcome === 'cancel') cancelled = true;
      };
      if (outcome === 'already-resident') present();
      else setImmediate(present);
      return { id: 'layer-' + generation.id };
    }, setGenerateNotice() {}, requestContentAwareRepair: async () => {}, pushToast() {},
    isGenerationCancellation: error => error.message === 'cancelled',
    createFailedGeneration: (generation, message) => ({ ...generation, status: 'failed', error: message }),
  };
  const run = new Function(...Object.keys(scope), `${serialJs};return handleRemoteSequentialMultiviewGenerate;`)(...Object.values(scope));
  const succeeds = ['success', 'textured', 'already-resident'].includes(outcome);
  if (succeeds || outcome === 'covered') await run({ id: 'reference', url: 'material' }, views);
  else await assert.rejects(run({ id: 'reference', url: 'material' }, views), new RegExp(
    outcome.includes('cancel') ? 'cancelled' : outcome === 'capture-failure' ? 'capture failure'
      : outcome === 'save-failure' ? 'save failure' : 'remote failure'));
  assert.equal(restored, 1, 'Camera must restore after success, failure and cancellation');
  assert.deepEqual(calls, outcome === 'capture-cancel' ? []
    : ['cancel', 'capture-failure', 'save-failure'].includes(outcome) ? [['full', 'front']] : succeeds
    ? [[outcome === 'textured' ? 'inpaint' : 'full', 'front'], ['inpaint', 'top'], ['inpaint', 'bottom']] : [['full', 'front'], ['inpaint', 'top']]);
  assert.equal(projected.length, succeeds ? 3 : outcome === 'covered' ? 2 : outcome === 'capture-cancel' ? 0 : 1);
  assert.deepEqual(prepared, outcome.includes('cancel') ? ['front'] : succeeds || outcome === 'covered' ? ['front', 'top', 'bottom'] : ['front', 'top']);
  assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]), 'Progress must not go backwards between captures');
  root.children[0].geometry.dispose(); reusedMaterial.dispose();
  if (outcome === 'failure') assert.equal(committed.length, 1, 'A later failure must retain already committed results');
}
assert.match(
  panel,
  /'front',[\s\S]*?'front-left',[\s\S]*?'left',[\s\S]*?'back-left',[\s\S]*?'back',[\s\S]*?'back-right',[\s\S]*?'right',[\s\S]*?'front-right',[\s\S]*?'top',[\s\S]*?'bottom'/,
  'preset 1 must keep adjacent orbit views first and poles last',
);
assert.match(
  panel,
  /'front',[\s\S]*?'left',[\s\S]*?'back',[\s\S]*?'right',[\s\S]*?'right-top',[\s\S]*?'front-top',[\s\S]*?'left-top',[\s\S]*?'back-top',[\s\S]*?'back-bottom',[\s\S]*?'left-bottom',[\s\S]*?'front-bottom',[\s\S]*?'right-bottom',[\s\S]*?'top',[\s\S]*?'bottom'/,
  'preset 2 must use the approved preview and execution order',
);
const thirdPreset = panel.match(/id: 'preset-3',\s*label:[\s\S]*?views: (\[[^\]]+\])/);
assert(thirdPreset);
assert.deepEqual(new Function(`return ${thirdPreset[1]}`)(),
  ['front', 'front-left', 'left', 'back-left', 'back', 'back-right', 'right', 'front-right', 'bottom']);
assert.match(panel, /id: 'preset-3', title: '预设 3', detail: '9 视角'/);
assert.match(panel, /getCameraViewPresetDefinition\(option.id\).views.length/);
assert.match(panel, /presetId === 'preset-3' \? 15 : 0/);
assert.match(panel, /id: orbitElevation \? `preset-3-\$\{option.value\}` : option.value/,
  'raised previews must not share horizontal camera cache IDs');
assert.match(
  flow,
  /addGenerationAsProjectedLayer[\s\S]*?await presentation\.waitForProjectedLayerPresentation[\s\S]*?model\.objectId === objectId[\s\S]*?\[projectedLayer\.id\][\s\S]*?projectedGenerationCount \+= 1/,
  'each returned image must be projected and GPU-resident before the next iteration',
);
assert.doesNotMatch(panel, /function waitForProjectedMaterialResident|await residentWait\.promise/);
assert.doesNotMatch(
  flow,
  /beginProjectedPreviewBatch/,
  'sequential remote generation must publish every projected view immediately',
);
assert.match(
  flow,
  /requestContentAwareRepair\([\s\S]*?batchId: textureBatchId/,
  'content-aware repair must run once after the sequential view loop',
);
assert.match(
  panel,
  /if \(isTextureMap\)[\s\S]*?pipelineController\.abort\('user-cancelled-texture-generation'\)/,
  'terminating a texture generation must abort the active remote request and prevent later views',
);
// Selection and persisted identity are exercised by test-reference-binding.mjs
// against this actual function for both new six-view results and in-place
// lighting edits. The latter must select the retained ID, not the upload ID.
assert.doesNotMatch(
  persistPairedFlow,
  /setTexturePreviewMode\('multi'\)|setTextureViewMode\('multi'\)|setTab\('multiview'\)/,
  'background multiview reference persistence must not navigate away from the active generation tab',
);
assert.match(
  transformActions,
  /export function setCameraToObjectDirection\([\s\S]*?runtime\.camera\.position\.copy\(center\)[\s\S]*?runtime\.controls\?\.target\.copy\(center\)/,
  'preset and custom generation views must share exact object-centered viewport framing',
);

console.log('Remote multiview sequential generation regression checks passed.');
