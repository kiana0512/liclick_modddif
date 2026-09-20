import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers';
import ts from 'typescript';
import * as THREE from 'three';

const materialSource = await readFile(
  new URL('../src/engine/projection/ProjectedLayerMaterial.ts', import.meta.url),
  'utf8',
);
const compositorSource = await readFile(
  new URL('../src/engine/projection/ProjectedLayerPreviewCompositor.ts', import.meta.url),
  'utf8',
);
const viewportSource = await readFile(
  new URL('../src/engine/viewport/ViewportCanvas.tsx', import.meta.url),
  'utf8',
);
const sceneRootSource = await readFile(
  new URL('../src/engine/viewport/SceneRoot.tsx', import.meta.url),
  'utf8',
);
const previewTextureCacheSource = await readFile(
  new URL('../src/engine/viewport/previewTextureCache.ts', import.meta.url),
  'utf8',
);
const editorSource = await readFile(
  new URL('../src/routes/EditorPage.tsx', import.meta.url),
  'utf8',
);
const objectsPanelSource = await readFile(
  new URL('../src/components/panels/ObjectsPanel.tsx', import.meta.url),
  'utf8',
);
const projectStoreSource = await readFile(
  new URL('../src/stores/projectStore.ts', import.meta.url),
  'utf8',
);
const sceneStoreSource = await readFile(
  new URL('../src/stores/sceneStore.ts', import.meta.url),
  'utf8',
);
const uvBakeSource = await readFile(
  new URL('../src/engine/bake/bakeProjectedLayerToTexture.ts', import.meta.url),
  'utf8',
);
const visibilityReuseSource = await readFile(
  new URL('../src/engine/bake/projectionVisibilityReuse.ts', import.meta.url),
  'utf8',
);
const projectedArrayUploadSchedulingSource = await readFile(
  new URL('../src/engine/projection/projectedArrayUploadScheduling.ts', import.meta.url),
  'utf8',
);

const visibilityReuseJs = ts.transpileModule(visibilityReuseSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const visibilityReuseExports = {};
new Function('exports', visibilityReuseJs)(visibilityReuseExports);
const { canReuseAuthoredProjectionVisibility } = visibilityReuseExports;
const projectedArrayUploadSchedulingJs = ts.transpileModule(projectedArrayUploadSchedulingSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const projectedArrayUploadSchedulingExports = {};
new Function('exports', projectedArrayUploadSchedulingJs)(projectedArrayUploadSchedulingExports);
const { yieldProjectedArrayUploadTurn } = projectedArrayUploadSchedulingExports;
for (const busy of [false, true]) {
  const calls = [];
  const mode = await yieldProjectedArrayUploadTurn({
    isViewportInteractionBusy: () => busy,
    waitForPaint: async () => calls.push('paint'),
    yieldToTask: async () => calls.push('task'),
  });
  assert.equal(mode, busy ? 'paint' : 'task');
  assert.deepEqual(calls, [busy ? 'paint' : 'task']);
}
const authoredVisibility = {
  depthUrl: 'depth.png',
  depthEncoding: 'linear-view',
  objectMatrixWorld: new Array(16).fill(0),
};
assert.equal(canReuseAuthoredProjectionVisibility(authoredVisibility, false), true);
assert.equal(canReuseAuthoredProjectionVisibility(authoredVisibility, true), false);
assert.equal(
  canReuseAuthoredProjectionVisibility({ ...authoredVisibility, normalUrl: 'normal.png' }, true),
  true,
);
assert.equal(
  canReuseAuthoredProjectionVisibility({ ...authoredVisibility, objectMatrixWorld: undefined }, false),
  false,
  'legacy rows without an authored object transform must regenerate visibility',
);
assert.equal(
  canReuseAuthoredProjectionVisibility({ ...authoredVisibility, depthEncoding: 'legacy-rgba' }, false),
  false,
  'non-linear legacy depth must never enter the capture-space reuse path',
);

// GPU and CPU use capture * inverse(current) as their object-space delta.
// Prove that applying the current object transform and then that delta lands on
// the exact authored capture-space point for multiple non-trivial transforms.
const captureMatrix = new THREE.Matrix4().compose(
  new THREE.Vector3(4, -2, 7),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.7, 0.2)),
  new THREE.Vector3(1.4, 0.8, 1.1),
);
for (const currentMatrix of [
  new THREE.Matrix4().makeTranslation(-6, 3, 2),
  new THREE.Matrix4().compose(
    new THREE.Vector3(2, 5, -3),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5, 0.25, 1.1)),
    new THREE.Vector3(0.75, 1.25, 1.5),
  ),
]) {
  const objectMatrixDelta = captureMatrix.clone().multiply(currentMatrix.clone().invert());
  for (const localPoint of [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(2.5, -1.25, 0.75),
    new THREE.Vector3(-4, 3, 9),
  ]) {
    const expected = localPoint.clone().applyMatrix4(captureMatrix);
    const actual = localPoint.clone().applyMatrix4(currentMatrix).applyMatrix4(objectMatrixDelta);
    assert.ok(actual.distanceTo(expected) <= 1e-9, 'capture-space depth transform must be invariant');
  }
}

assert.match(
  visibilityReuseSource,
  /layer\.depthEncoding === 'linear-view' &&\s*layer\.objectMatrixWorld\?\.length === 16/,
  'authored capture-space linear depth must survive later rigid model transforms',
);
assert.doesNotMatch(
  uvBakeSource,
  /matrixMatches\(layer\.objectMatrixWorld\)|currentObjectMatrixWorld\[index\]/,
  'projection-to-UV must not regenerate every capture depth after a rigid model transform',
);
assert.match(
  uvBakeSource,
  /captureObjectMatrixWorld: layer\.objectMatrixWorld/,
  'legacy or missing depth regeneration must still render in the authored capture matrix',
);

// Execute the production cold-warmup gate and promise registration.
const sceneAst = ts.createSourceFile('SceneRoot.tsx', sceneRootSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const findNodes = (predicate) => {
  const nodes = [];
  const visit = (node) => { if (predicate(node)) nodes.push(node); ts.forEachChild(node, visit); };
  visit(sceneAst);
  return nodes;
};
const [warmupEffect] = findNodes((node) => ts.isCallExpression(node) &&
  node.expression.getText(sceneAst) === 'useEffect' &&
  node.arguments[0]?.getText(sceneAst).includes('const sharedWarmupSignature'));
assert.ok(warmupEffect);
const gate = warmupEffect.arguments[0].body.statements[0];
assert.ok(ts.isIfStatement(gate));
const uniformBudgetSource = await readFile(new URL('../src/engine/projection/projectedUniformBudget.ts', import.meta.url), 'utf8');
const uniformBudgetJs = ts.transpileModule(uniformBudgetSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const budgetExports = {};
new Function('exports', uniformBudgetJs)(budgetExports);
const { isProjectedUniformBudgetSafe } = budgetExports;
assert.match(sceneRootSource, /const residentUvDisplayEnabled = true;/,
  'every supported viewport must consume a verified UV display buffer');
assert.match(sceneRootSource,
  /const useProjectedTextureArrays = Boolean\([\s\S]*?projectedEraserArmed[\s\S]*?gl\.capabilities\.isWebGL2[\s\S]*?previewProjectionInputs\.length > 1/,
  'the heavier texture-array renderer must be scoped to an armed WebGL2 multi-view eraser');
assert.match(sceneRootSource, /const canUseDirectVisibleStackAfterArrayFailure = false;/,
  'array failure must retain the verified UV front buffer instead of publishing a direct projection');
assert.match(sceneRootSource,
  /const exactProjectedEraserStackSafe = Boolean\([\s\S]*?useProjectedTextureArrays[\s\S]*?projectedTextureArraySamplerBudget[\s\S]*?directProjectedSamplerBudget[\s\S]*?isProjectedUniformBudgetSafe[\s\S]*?const canUseExactProjectedEraserStack = Boolean\([\s\S]*?projectedEraserArmed && exactProjectedEraserStackSafe/,
  'the projected eraser may use direct or array presentation only after the selected exact stack passes device budgets');
assert.match(sceneRootSource,
  /const materialProjectionInputs = canUseExactProjectedEraserStack[\s\S]*?\? previewProjectionInputs[\s\S]*?: \[\]/,
  'the material publisher must stay UV-only outside the bounded exact eraser session');
assert.equal(isProjectedUniformBudgetSafe(34, 1024), false, 'reported 34-layer shader must not reach the driver');
assert.equal(isProjectedUniformBudgetSafe(14, 1024), true);
assert.equal(isProjectedUniformBudgetSafe(14, 256), false, 'limits follow the actual device');
const evaluateWarm = new Function('stage', 'visible', 'selected', 'isProjectedUniformBudgetSafe', `
  const importedModel = { restoreStage: stage }, workspaceVisible = visible;
  const residentUvDisplayEnabled = true;
  const gl = { compileAsync() {}, capabilities: { maxFragmentUniforms: 1024 } }, projectedProgramWarmupInputs = [{}, {}];
  const projectedProgramWarmupSignature = 'test';
  return !(${gate.expression.getText(sceneAst)});
`);
const shouldWarm = (...args) => evaluateWarm(...args, isProjectedUniformBudgetSafe);
assert.equal(shouldWarm('outline', true, true), false, 'UV-only display must not compile projected preview shaders');
for (const stage of ['bounds', 'proxy', 'full', undefined]) {
  assert.equal(shouldWarm(stage, true, true), false, 'editing a resident stack must not start speculative compilation');
}
assert.equal(shouldWarm('outline', false, true), false);
assert.equal(shouldWarm('outline', true, false), false);
const [warmupSet] = findNodes((node) => ts.isCallExpression(node) && node.expression.getText(sceneAst) === 'sharedWarmups.set');
const registerWarmup = new Function('sharedWarmups', 'sharedWarmupPromise', `
  const sharedWarmupSignature = 'test'; ${warmupSet.getText(sceneAst)};
`);
const warmupMap = new Map(), pendingCompile = Promise.resolve();
registerWarmup(warmupMap, pendingCompile);
assert.equal(warmupMap.get('test'), pendingCompile, 'finally must see the same promise identity to release the renderer entry');

// The actual direct build branch must await compilation before publication.
const directStart = sceneRootSource.indexOf('markProjectedMaterialBuild();', sceneRootSource.indexOf('const latestOrdinaryUvKey'));
const directEnd = sceneRootSource.indexOf('} catch (error)', directStart);
assert.ok(directStart > 0 && directEnd > directStart);
const directBlock = sceneRootSource.slice(directStart, directEnd).replace(/\}\s*$/, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runDirect = new AsyncFunction('events', 'compile', 'created', `
  const projectedMaterialInput = {}, gl = { capabilities: { maxTextures: 16 } }, cancelled = false;
  const isViewportInteractionBusy = () => false, useProjectedTextureArrayMaterial = false;
  const markProjectedMaterialBuild = () => events.push('build');
  const createProjectedLayerStackMaterial = async () => created;
  const precompileProjectedMaterial = compile;
  let sharedProjectedMaterial;
  ${directBlock.replace(/\}\s*$/, '')}
  events.push('publish');
`);
let finishCompile;
const compileBarrier = new Promise((resolve) => { finishCompile = resolve; });
const compileEvents = [];
const directRun = runDirect(compileEvents, async () => { compileEvents.push('compile'); await compileBarrier; }, {});
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(compileEvents, ['build', 'compile']);
finishCompile();
await directRun;
assert.deepEqual(compileEvents, ['build', 'compile', 'publish']);
const failedEvents = [];
await assert.rejects(runDirect(failedEvents, async () => { throw new Error('compile failed'); }, {}), /compile failed/);
assert.deepEqual(failedEvents, ['build'], 'failed compilation must not publish');
const emptyEvents = [];
await runDirect(emptyEvents, () => assert.fail('missing material must not compile'), undefined);
assert.deepEqual(emptyEvents, ['build', 'publish']);

const [precompileDeclaration] = findNodes((node) => ts.isVariableDeclaration(node) &&
  node.name.getText(sceneAst) === 'precompileProjectedMaterial');
assert.ok(precompileDeclaration);
const precompileJs = ts.transpileModule(`const run = ${precompileDeclaration.initializer.getText(sceneAst)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const targetCompilerSource = await readFile(
  new URL('../src/engine/projection/compileForRenderTarget.ts', import.meta.url), 'utf8',
);
const targetCompilerJs = ts.transpileModule(targetCompilerSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const targetCompilerExports = {};
new Function('exports', targetCompilerJs)(targetCompilerExports);
// A layer change can request disposal while two offscreen/viewport link polls
// still refer to the same material. Keep it alive until both settle.
const leasedMaterial = new THREE.ShaderMaterial();
const leasedScene = new THREE.Scene();
leasedScene.add(new THREE.Mesh(new THREE.PlaneGeometry(), leasedMaterial));
const resolvers = [];
const leaseRenderer = {
  getRenderTarget: () => null, getActiveCubeFace: () => 0,
  getActiveMipmapLevel: () => 0, setRenderTarget() {},
  compileAsync: () => new Promise(resolve => resolvers.push(resolve)),
};
let disposals = 0;
const firstLease = targetCompilerExports.compileForRenderTarget(leaseRenderer, leasedScene, {}, null);
const secondLease = targetCompilerExports.compileForRenderTarget(leaseRenderer, leasedScene, {}, null);
assert.equal(targetCompilerExports.deferDisposalDuringCompile(leasedMaterial, () => { disposals++; }), true);
resolvers[0](); await firstLease;
assert.equal(disposals, 0);
resolvers[1](); await secondLease;
assert.equal(disposals, 1);
assert.equal(targetCompilerExports.deferDisposalDuringCompile(leasedMaterial, () => {}), false);
let finishColdWarmup;
const coldWarmup = new Promise((resolve) => { finishColdWarmup = resolve; });
const scheduleEvents = [];
const precompileScope = {
  THREE, camera: new THREE.PerspectiveCamera(), cancelled: false,
  gl: {
    compileAsync: async () => scheduleEvents.push('compile'),
    getRenderTarget: () => null,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    setRenderTarget() {},
  },
  compileForRenderTarget: targetCompilerExports.compileForRenderTarget,
  waitForPreviewTextureUploadsIdle: async () => scheduleEvents.push('uploads-idle'),
  getProjectedProgramWarmupMap: () => new Map([['cold', coldWarmup]]),
  waitForViewportInteractionIdle: async () => scheduleEvents.push('interaction-idle'),
  performance: { now: () => 0 }, document: { body: { dataset: {} } },
  markPerformanceEvent: () => {},
};
const makePrecompile = (scope) => new Function(...Object.keys(scope), `${precompileJs}\nreturn run;`)(...Object.values(scope));
const testMaterial = new THREE.ShaderMaterial();
const precompileRun = makePrecompile(precompileScope)(testMaterial);
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(scheduleEvents, ['uploads-idle'], 'existing cold compile must be joined, not polled concurrently');
finishColdWarmup();
assert.equal(await precompileRun, true);
assert.deepEqual(scheduleEvents, ['uploads-idle', 'interaction-idle', 'compile']);
scheduleEvents.length = 0;
assert.equal(await makePrecompile({ ...precompileScope, cancelled: true })(testMaterial), false);
assert.deepEqual(scheduleEvents, [], 'superseded material must not start compilation');
testMaterial.dispose();

assert.match(
  sceneStoreSource,
  /const hasRuntimeStateToReset = Boolean\([\s\S]*?paintMaskHasContent[\s\S]*?localRepaintProjectionSource[\s\S]*?hasRuntimeStateToReset[\s\S]*?paintMaskResetRevision:/,
  'blank scene selection must not clear and re-upload the viewport paint mask target',
);
assert.match(
  sceneRootSource,
  /const ImportedModel = memo\(function ImportedModel[\s\S]*?state\.selectedObjectId === importedModel\.objectId/,
  'scene models must subscribe to their own selection bit and skip unrelated material-pipeline renders',
);
assert.doesNotMatch(
  sceneRootSource,
  /function ImportedModel\([\s\S]{0,1000}state\.selectedObjectId\);/,
  'each imported model must not subscribe to the global selected-object string',
);
assert.match(
  objectsPanelSource,
  /markViewportInteractionActivity\(\);\s*selectObject\(objectId\);/,
  'object-list selection should pause background viewport work before publishing selection',
);
assert.match(
  sceneRootSource,
  /const selectImportedObject = useCallback\([\s\S]*?markViewportInteractionActivity\(\);\s*selectObject\(objectId\);/,
  'mesh selection should pause background viewport work before publishing selection',
);

assert.match(
  sceneRootSource,
  /function SelectionBoundsCorners[\s\S]*?bounds\.setFromObject\(object, false\)/,
  'scene selection chrome must use geometry bounds instead of scanning every high-poly vertex',
);
assert.match(
  sceneRootSource,
  /const selectionBoundsCache = new WeakMap[\s\S]*?cachedBounds\?\.matrixWorld\.equals\(object\.matrixWorld\)[\s\S]*?bounds\.copy\(cachedBounds\.bounds\)/,
  'reselecting an unchanged model must reuse its world-space selection bounds',
);
assert.match(
  sceneRootSource,
  /useFrame\(\(\) => \{[\s\S]*?object\.updateWorldMatrix\(true, false\);[\s\S]*?indicator\.update\(\)/,
  'unchanged selected models must not recursively update their complete object tree every frame',
);

assert.match(
  materialSource,
  /projectedTextureArrayCircuitBreakers\.has\(options\.renderer\)[\s\S]*?ProjectedTextureArrayCircuitOpenError/,
  'a failed renderer must reject later texture-array attempts before another upload',
);
assert.match(
  materialSource,
  /!options\.isCancelled\?\.\(\)[\s\S]*?projectedTextureArrayCircuitBreakers\.set\(options\.renderer/,
  'non-cancelled texture-array failures must open the renderer-scoped circuit',
);
assert.match(
  materialSource,
  /const existingFailure = projectedTextureArrayCircuitBreakers\.get\(options\.renderer\)[\s\S]*?surfacedError = new ProjectedTextureArrayCircuitOpenError/,
  'concurrent model failures must converge on the existing renderer circuit instead of reporting duplicates',
);
assert.match(
  sceneRootSource,
  /isProjectedTextureArrayCircuitOpenError\(error\)[\s\S]*?if \(!circuitWasAlreadyOpen\) \{[\s\S]*?console\.warn/,
  'SceneRoot must suppress duplicate fallback warnings after the shared renderer circuit opens',
);
assert.match(
  materialSource,
  /vec3 sn\(vec3 v, vec3 f\)[\s\S]*?inversesqrt\(max\(l, 1\.0e-12\)\)/,
  'projected shaders must guard zero-length normal derivatives before normalization',
);
assert.doesNotMatch(
  materialSource,
  /vec3 projectedFaceNormal = normalize\(\s*cross\(dFdx\(captureViewPosition\), dFdy\(captureViewPosition\)\)/,
  'projected shaders must not directly normalize a potentially zero-length face derivative',
);
assert.doesNotMatch(
  materialSource,
  /dot\(projectedFaceNormal, normalize\(capturedFaceNormal\)\)/,
  'visibility sampling must not normalize the zero normal used by layers without a normal map',
);
assert.match(
  materialSource,
  /uploadProjectedTextureArrayInStripes\([\s\S]*?UNPACK_ROW_LENGTH[\s\S]*?renderer\.resetState\(\)/,
  'projected arrays must normalize per-stripe unpack state and reset Three renderer state before presentation',
);
assert.match(
  materialSource,
  /yieldProjectedArrayUploadWork\(input\.isViewportInteractionBusy\)[\s\S]*?yieldMode === 'paint'[\s\S]*?uploadTaskYieldCount/,
  'idle array stripes must use task yields while active interaction keeps paint-aligned yields',
);
assert.doesNotMatch(
  materialSource,
  /yieldProjectedArrayUploadWork\(input\.isViewportInteractionBusy\);\s*await waitForProjectedArrayUploadWindow/,
  'one bounded upload stripe must not pay both a task/frame yield and a second frame wait',
);
assert.match(
  viewportSource,
  /const reusableEraserGpu =[\s\S]*?currentLayer\.objectId === model\.objectId[\s\S]*?currentLayer\.paintDefaultResolution === paintResolution[\s\S]*?!isPaintingRef\.current[\s\S]*?currentLayer\.pendingPaintCommits === 0[\s\S]*?!currentLayer\.projectedEraserResidentHandoffPromise/,
  'a settled projected layer must transfer its compiled model/resolution eraser GPU to the next row',
);
assert.match(
  viewportSource,
  /unregisterLiveUvRenderTarget\(currentLayer\.liveResultUrl, reusableEraserGpu\.texture\)[\s\S]*?currentLayer\.eraserGpu = undefined[\s\S]*?disposeUvPaintLayer\(currentLayer\)/,
  'GPU transfer must detach ownership before disposing the previous layer session',
);
assert.match(
  viewportSource,
  /reusableEraserGpu\.resetWhite\(\)[\s\S]*?registerLiveUvRenderTarget\([\s\S]*?paintLayer\.eraserGpu = reusableEraserGpu[\s\S]*?paintLayer\.eraserGpuReady = Promise\.resolve\(\)/,
  'the transferred eraser must be neutralized and synchronously rebound before the next stroke',
);
assert.match(
  materialSource,
  /MAX_PROJECTED_SOURCE_TEXTURE_CACHE_ENTRIES = 48[\s\S]*?while \(projectedTextureCache\.size > MAX_PROJECTED_SOURCE_TEXTURE_CACHE_ENTRIES\)[\s\S]*?projectedTextureCache\.delete\(oldestKey\)/,
  'decoded projected source textures must use a bounded LRU cache across multi-model projects',
);
assert.match(
  materialSource,
  /PIXEL_UNPACK_BUFFER_BINDING[\s\S]*?bindBuffer\(input\.context\.PIXEL_UNPACK_BUFFER, null\)[\s\S]*?bindBuffer\(input\.context\.PIXEL_UNPACK_BUFFER, previousPixelUnpackBuffer\)/,
  'striped projected-array uploads must isolate and restore the pixel-unpack buffer binding',
);
assert.match(
  sceneRootSource,
  /const canUseDirectVisibleStackAfterArrayFailure = false;/,
  'an obsolete projected-array failure must retain the last verified UV buffer',
);
assert.doesNotMatch(
  compositorSource,
  /priorityOverlay/,
  'the retired single-view priority branch must not add uniforms or per-pass writes',
);
assert.match(
  viewportSource,
  /droppedFrames: estimateMissedFrameCount\(/,
  'the performance lab must count refresh opportunities actually missed',
);
assert.doesNotMatch(
  viewportSource,
  /duration > 20|summarizeFramePacing\([^\n]+, 20\)/,
  'all S2-S9 benchmark summaries must use the strict fixed 60 Hz budget',
);
assert.match(
  viewportSource,
  /const STRICT_60_HZ_FRAME_BUDGET_MS = 1000 \/ 60/,
  'the performance lab must declare the fixed 16.67ms acceptance budget',
);
assert.match(
  viewportSource,
  /overlayHasLiveContent[\s\S]*?shouldUseDedicatedLocalRepaintOverlay[\s\S]*?overlayKeepsLivePreview/,
  'S7 overlay expectations must follow the same live/persisted ownership gate as the renderer',
);
assert.match(
  viewportSource,
  /const requiredCount = scenario === 'projected' \? 14 : 1/,
  'S5 must benchmark the current object real projection stack instead of requiring legacy 14-view data',
);
assert.ok(
  (viewportSource.match(/document\.body\.dataset\.perfSuppressProjectLayerSync = '1'/g) ?? [])
    .length >= 4,
  'performance scenarios that mutate layer stores must suppress project persistence',
);
assert.match(
  viewportSource,
  /perfSuppressProjectLayerSync = '1';[\s\S]*?setLayerVisibility\(targetIds, true\)[\s\S]*?waitForProjectedUvReady/,
  'S7 must acquire its read-only lock before the exact UV preflight mutates layers',
);
assert.doesNotMatch(
  viewportSource,
  /setViewportLayerStressRunning\(true\);\s*document\.body\.dataset\.perfViewportStressMeasuring = '1'/,
  'S7 cannot pause background material publication before awaiting its prewarm',
);
assert.match(
  viewportSource,
  /performanceScenarioOccludingUvIds\(originalLayers, selectedObjectId\), false,[\s\S]*?await waitForProjectedUvReady\(\);[\s\S]*?viewportLayerStressRunningRef\.current = true;[\s\S]*?perfViewportStressMeasuring = '1'/,
  'S7 must uncover projection inputs and complete exact UV prewarm before reserving the interaction budget',
);
assert.match(
  viewportSource,
  /const uvUpdatePending =[\s\S]*?readResidentUvProjectionState\(\)\.status === 'computing';[\s\S]*?!uvUpdatePending/,
  'S7 must permit the previous verified UV only while a latest-wins UV update is pending',
);
assert.match(
  editorSource,
  /perfSuppressProjectLayerSync === '1'[\s\S]*?pendingLayers = undefined/,
  'the project sync bridge must discard layer mutations performed inside a read-only performance transaction',
);
assert.match(
  viewportSource,
  /if \(target\.LiclickPerfLab === controller\) delete target\.LiclickPerfLab/,
  'a stale React effect cleanup must not remove the current performance lab controller',
);
assert.match(
  viewportSource,
  /if \(target\.LiclickPerfViewportStress === controller\)/,
  'a stale viewport cleanup must not remove the current S7 stress controller',
);
assert.match(
  viewportSource,
  /activeViewportStressController\.run\(\)/,
  'the in-app S7 button must call the renderer controller without depending on an external window bridge',
);
assert.match(
  sceneRootSource,
  /authoritativeExactUvTexture \?\? loadedUvTexture \?\? authoritativeProxyUvTexture/,
  'the 512px-to-exact UV handoff must keep a valid sampler until 4K is resident',
);
assert.match(
  sceneRootSource,
  /projectedProgramWarmupsByRenderer[\s\S]*?sharedWarmups\.has\(sharedWarmupSignature\)/,
  'cold multi-model restore must deduplicate concurrent projected shader warmups per renderer',
);
assert.match(
  viewportSource,
  /projectedProgramWarmupStatus === 'pending'[\s\S]*?await waitForFrame\(\)/,
  'local repaint shader prewarm must yield behind an in-flight projected background warmup',
);
assert.match(
  previewTextureCacheSource,
  /activePreviewTextureUploads[\s\S]*?waitForPreviewTextureUploadsIdle/,
  'preview uploads must expose a renderer-idle barrier for quality-preserving shader scheduling',
);
assert.match(
  sceneRootSource,
  /await waitForPreviewTextureUploadsIdle\(gl, \(\) => cancelled\)[\s\S]*?compileForRenderTarget\(gl, compileScene, camera, target\)/,
  'projected material compilation must not overlap active 4K preview uploads',
);
assert.match(
  previewTextureCacheSource,
  /createWorkerBackedPreviewTexture[\s\S]*?adoptPreviewBitmapInWorker/,
  'fresh 4K UV composites must return to the worker-backed striped upload path',
);
assert.match(
  previewTextureCacheSource,
  /prewarmPreviewTextures[\s\S]*?retainPreviewTexture\(url, options\)[\s\S]*?finally\s*\{\s*releases\.forEach\(\(release\) => release\(\)\)/,
  'bulk preview prewarm must pin worker bitmaps until their striped uploads finish',
);
assert.match(
  sceneRootSource,
  /Boolean\(layer\.imageUrl\)[\s\S]*?layer\.visible[\s\S]*?prewarmPreviewTextures\(imageUrls,[\s\S]*?maxSize: proxyTextureMaxSize/,
  'multi-model restore must only prewarm the visible UV working set',
);
assert.match(
  projectStoreSource,
  /ACTIVE_OBJECT_PERSIST_DELAY_MS = 4_000[\s\S]*?scheduleCurrentProjectActiveObjectPersistence[\s\S]*?updateProjectById\(projectId, \{ activeObjectId \}\)/,
  'rapid model navigation must persist only its final stable selection',
);
assert.match(
  objectsPanelSource,
  /function handleSelectObject\(objectId: string\)[\s\S]*?selectObject\(objectId\);\s*scheduleCurrentProjectActiveObjectPersistence\(objectId\);\s*\}/,
  'the object list must defer persistence instead of cloning the complete project on every selection',
);
assert.match(
  sceneRootSource,
  /const selectImportedObject = useCallback\([\s\S]*?selectObject\(objectId\);\s*scheduleCurrentProjectActiveObjectPersistence\(objectId\);/,
  'viewport selection must defer persistence instead of cloning the complete project on every click',
);
assert.match(
  sceneRootSource,
  /if \(!workspaceVisible\) \{[\s\S]*?hiddenBuild\.cancelled = true;[\s\S]*?projectedTextureArrayBuildRef\.current = undefined;[\s\S]*?return undefined;/,
  'hidden texture-workspace models must cancel and forget partial 4K projected-array builds',
);
assert.match(
  sceneRootSource,
  /const needsInteractiveProjectedMaterial = stableVisibleProjectedLayers\.length > 0/,
  'hidden projected rows must not start speculative texture-array uploads while merged UV owns the visible result',
);
assert.doesNotMatch(
  sceneRootSource,
  /HIDDEN_PROJECTED_PREWARM_DELAY_MS|selectedForProjectedEditing/,
  'selection idle must not schedule a delayed hidden-layer upload that can collide with wheel input',
);
assert.match(
  sceneRootSource,
  /!workspaceVisible \|\|\s*!selected \|\|\s*typeof gl\.compileAsync/,
  'projected shader warmup must be reserved for the selected visible model',
);
assert.match(
  sceneRootSource,
  /!workspaceVisible \|\|\s*!selected \|\|\s*!texturedRestoreReady/,
  'runtime projection visibility repair must not compete across hidden or unselected models',
);
assert.doesNotMatch(
  compositorSource,
  /uniform float priorityOverlay/,
  'progressive composition must keep ordinary single views in the quality pass',
);
assert.match(
  sceneRootSource,
  /nextTexture = await createWorkerBackedPreviewTexture\(bitmap\)/,
  'SceneRoot must not retain and crop a full 4K composite bitmap on the UI thread',
);
assert.doesNotMatch(
  editorSource,
  /const promoteSelectedModel = async \(\) => \{[\s\S]{0,1200}await prewarmPreviewTextures/,
  'selected models must enter full restore without waiting on the background prewarm queue',
);

console.log('Projection performance safety regression checks passed.');
