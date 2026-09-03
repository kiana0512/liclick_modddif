import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
  /!workspaceVisible \|\|\s*selectedObjectId !== importedModel\.objectId \|\|\s*typeof gl\.compileAsync/,
  'projected shader warmup must be reserved for the selected visible model',
);
assert.match(
  sceneRootSource,
  /!workspaceVisible \|\|\s*selectedObjectId !== importedModel\.objectId \|\|\s*!texturedRestoreReady/,
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
