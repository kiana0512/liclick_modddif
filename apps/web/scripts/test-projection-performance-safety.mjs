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
  /uploadProjectedTextureArrayInStripes\([\s\S]*?UNPACK_ROW_LENGTH[\s\S]*?renderer\.resetState\(\)/,
  'projected arrays must normalize per-stripe unpack state and reset Three renderer state before presentation',
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
  /droppedFrames: frameTimes\.filter\(\(value\) => value > targetMs\)\.length/,
  'the performance lab must count every frame above the 60 Hz interval',
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
  /overlayHasLiveContent[\s\S]*?!overlayOwnsOrderedPreview/,
  'S7 overlay expectations must follow live-content and ordered-preview ownership',
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
  /layer\.visible \|\| selectedObjectId === importedObjectId[\s\S]*?prewarmPreviewTextures\(imageUrls,[\s\S]*?maxSize: proxyTextureMaxSize/,
  'multi-model restore must pin only the selected object\'s hidden UV toggle working set',
);
assert.match(
  sceneRootSource,
  /if \(!workspaceVisible\) \{[\s\S]*?hiddenBuild\.cancelled = true;[\s\S]*?projectedTextureArrayBuildRef\.current = undefined;[\s\S]*?return undefined;/,
  'hidden texture-workspace models must cancel and forget partial 4K projected-array builds',
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
