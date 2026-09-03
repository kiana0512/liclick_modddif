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
const shouldWarm = new Function('stage', 'visible', 'selected', `
  const importedModel = { restoreStage: stage }, workspaceVisible = visible;
  const gl = { compileAsync() {} }, projectedProgramWarmupInputs = [{}, {}];
  const projectedProgramWarmupSignature = 'test';
  return !(${gate.expression.getText(sceneAst)});
`);
assert.equal(shouldWarm('outline', true, true), true);
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
let finishColdWarmup;
const coldWarmup = new Promise((resolve) => { finishColdWarmup = resolve; });
const scheduleEvents = [];
const precompileScope = {
  THREE, camera: new THREE.PerspectiveCamera(), cancelled: false,
  gl: { compileAsync: async () => scheduleEvents.push('compile') },
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
  /canUseDirectVisibleStackAfterArrayFailure[\s\S]*?textureArrayCompositionFallbackRequired && directProjectedSamplerBudget\.withinBudget/,
  'an array failure must use the complete direct stack whenever the GPU can carry it',
);
assert.match(
  compositorSource,
  /const overlayMaterial = createFullscreenMaterial\(overlayFragmentShader,[\s\S]*?priorityOverlay: 0/,
  'overlay compositor must declare the priorityOverlay uniform before step writes it',
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
  /perfSuppressProjectLayerSync = '1';[\s\S]*?setLayerVisibility\(targetIds, true\)[\s\S]*?waitForProjectedResidentReady/,
  'S7 must acquire its read-only lock before the resident projected-stack preflight mutates layers',
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
  /await waitForPreviewTextureUploadsIdle\(gl, \(\) => cancelled\)[\s\S]*?gl\.compileAsync/,
  'projected material compilation must not overlap active 4K preview uploads',
);
assert.match(
  previewTextureCacheSource,
  /createWorkerBackedPreviewTexture[\s\S]*?adoptPreviewBitmapInWorker/,
  'fresh 4K UV composites must return to the worker-backed striped upload path',
);
assert.match(
  previewTextureCacheSource,
  /pinnedPreviewTextureCacheKeys[\s\S]*?prewarmPreviewTextures[\s\S]*?trimBakedTextureCache\(\)/,
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
assert.match(
  compositorSource,
  /const overlayFragmentShader = `[\s\S]*?uniform float priorityOverlay;/,
  'the priority overlay compositor shader must declare the uniform used by its alpha branch',
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
