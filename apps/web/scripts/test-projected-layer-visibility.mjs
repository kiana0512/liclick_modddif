import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import * as THREE from 'three';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sceneRootSource = readFileSync(path.join(root, 'src/engine/viewport/SceneRoot.tsx'), 'utf8');
const editorPageSource = readFileSync(path.join(root, 'src/routes/EditorPage.tsx'), 'utf8');
const generatePanelSource = readFileSync(
  path.join(root, 'src/components/panels/GeneratePanel.tsx'),
  'utf8',
);
const layersPanelSource = readFileSync(
  path.join(root, 'src/components/panels/LayersPanel.tsx'),
  'utf8',
);
const layerRowStyles = layersPanelSource.match(/'group relative flex h-\[58px\][\s\S]*?pendingDisplay &&[^\n]+/)?.[0];
assert.ok(layerRowStyles);
assert.doesNotMatch(layerRowStyles, /hover:/, 'Layer rows must not highlight on hover.');
assert.match(layerRowStyles, /selected && 'bg-white\/\[0\.22\][^']*ring-fuchsia-400\/80'/);
assert.match(layerRowStyles, /active && 'after:absolute/);
const viewportCanvasInteractionSource = readFileSync(
  path.join(root, 'src/engine/viewport/ViewportCanvas.tsx'),
  'utf8',
);
const projectedPreviewCompositorSource = readFileSync(
  path.join(root, 'src/engine/projection/ProjectedLayerPreviewCompositor.ts'),
  'utf8',
);
const projectedLayerMaterialSource = readFileSync(
  path.join(root, 'src/engine/projection/ProjectedLayerMaterial.ts'),
  'utf8',
);
const gpuUvBakeRendererSource = readFileSync(
  path.join(root, 'src/engine/bake/gpuUvBakeRenderer.ts'),
  'utf8',
);
const maskedProjectedImageSource = readFileSync(
  path.join(root, 'src/engine/projection/createMaskedProjectedImage.ts'),
  'utf8',
);
const maskedProjectedImageWorkerSource = readFileSync(
  path.join(root, 'src/engine/projection/maskedProjectedImage.worker.ts'),
  'utf8',
);
const bakeProjectedLayerToTextureSource = readFileSync(
  path.join(root, 'src/engine/bake/bakeProjectedLayerToTexture.ts'),
  'utf8',
);
const liveSurfacePaintPreviewRegistrySource = readFileSync(
  path.join(root, 'src/engine/paint/liveSurfacePaintPreviewRegistry.ts'),
  'utf8',
);
const viewportPanelSource = readFileSync(
  path.join(root, 'src/components/panels/ViewportPanel.tsx'),
  'utf8',
);
const sceneStoreSource = readFileSync(path.join(root, 'src/stores/sceneStore.ts'), 'utf8');
const layerStoreSource = readFileSync(path.join(root, 'src/stores/layerStore.ts'), 'utf8');
const editorShellSource = readFileSync(path.join(root, 'src/layouts/EditorShell.tsx'), 'utf8');
const localRepaintDialogSource = readFileSync(
  path.join(root, 'src/components/localRepaint/LocalRepaintDialog.tsx'),
  'utf8',
);
assert.match(
  localRepaintDialogSource,
  /const penEraserContact =\s*event\.pointerType === 'pen'[\s\S]*?const mouseEraserContact =\s*event\.pointerType === 'mouse' && event\.button === 2;[\s\S]*?strokeToolRef\.current = penEraserContact \|\| mouseEraserContact \? 'erase' : tool;/,
  'The 2D repaint editor must keep primary paint plus mouse/pressure-pen erasing.',
);
assert.match(
  localRepaintDialogSource,
  /onContextMenu=\{\(event\) => event\.preventDefault\(\)\}/,
  'The retired 2D RMB gesture must not reopen the browser context menu.',
);
const localRepaintMaskWorkerSource = readFileSync(
  path.join(root, 'src/workers/localRepaintMaskPreparation.worker.ts'),
  'utf8',
);
const renderTargetUtilsSource = readFileSync(
  path.join(root, 'src/engine/capture/renderTargetUtils.ts'),
  'utf8',
);
const previewTextureCacheSource = readFileSync(
  path.join(root, 'src/engine/viewport/previewTextureCache.ts'),
  'utf8',
);
const gpuReadbackWorkerSource = readFileSync(
  path.join(root, 'src/workers/encodeGpuReadbackPng.worker.ts'),
  'utf8',
);

assert.match(
  projectedPreviewCompositorSource,
  /private handleFailure[\s\S]*?failedAttemptCount \+= 1[\s\S]*?failedAttemptCount >= 4[\s\S]*?retryDelayMs[\s\S]*?this\.request\(request\)/,
  'A transient projected-preview failure must retry with bounded backoff instead of leaving a projection-only model permanently white.',
);
assert.doesNotMatch(
  projectedPreviewCompositorSource,
  /this\.retryTimer = window\.setTimeout\([\s\S]*?this\.failedSignature = undefined;[\s\S]*?this\.request\(request\)/,
  'A same-signature retry must preserve its attempt counter so the retry budget stays bounded.',
);
assert.doesNotMatch(
  sceneRootSource,
  /notifyProjectedPreviewFailure|projected-preview:failure/,
  'Projected-preview fallback failures must remain console diagnostics and never interrupt users with a toast.',
);

assert.match(
  projectedPreviewCompositorSource,
  /vec4 maskTexel = texture\(maskMap, maskUv\);\s*float maskValue = dot\(maskTexel\.rgb,[\s\S]*?\) \* maskTexel\.a;/,
  'Projected preview compositing must preserve continuous mask alpha.',
);
assert.match(
  generatePanelSource,
  /let projectedResultUrl = readableResultUrl;[\s\S]*?createCaptureMaskedProjectionImage\([\s\S]*?persistGeneratedImage\('layers', projectedResultUrl,[\s\S]*?persistedGenerationCapture\.maskUrl[\s\S]*?alphaMode: 'geometry-mask-separated'/,
  'Generated image RGB may be edge-decontaminated, but geometry coverage must remain a separate persisted mask so projection alpha is never clipped twice.',
);
assert.doesNotMatch(
  generatePanelSource,
  /createMaskedProjectedImage/,
  'Ordinary generation staging must not bake the capture silhouette into source alpha.',
);
assert.match(
  maskedProjectedImageSource,
  /createMaskedProjectedImage[\s\S]*?processMaskedProjectedImageInWorker\(sourceImage, projectionMask, 'mask-only'\)/,
  'The explicit repaint masked-image utility must preserve RGB while applying the authored projection mask exactly once.',
);
assert.match(
  layerStoreSource,
  /addProjectedLayerFromGeneration:[\s\S]*?captureMaskUrl = captureMaskTexture \? capture\?\.maskUrl : undefined[\s\S]*?maskUrl: captureMaskUrl[\s\S]*?maskSpace: captureMaskUrl \? 'projection' : undefined[\s\S]*?projectionCoverageMode: captureMaskTexture[\s\S]*?'capture-mask'[\s\S]*?ignoreSourceAlpha: textureProjectionIgnoresSourceAlpha\(generation\)[\s\S]*?projectionVisibilityPolicy: captureMaskTexture \? 'standard' : undefined/,
  'New GPT and remote single-view layers must use the capture silhouette while joining ordinary quality composition.',
);
assert.match(
  sceneRootSource,
  /function resolveProjectionMask\([\s\S]*?projectionCoverageMode === 'capture-mask'[\s\S]*?capture\?\.maskUrl[\s\S]*?maskUrl: capture\.maskUrl, maskSpace: 'projection'/,
  'Saved single-view layers must recover their authored capture silhouette without overwriting UV eraser masks.',
);
assert.match(
  layerStoreSource,
  /minimumProjectionFacing: captureMaskTexture[\s\S]*?SINGLE_VIEW_MINIMUM_PROJECTION_FACING/,
  'Generated single-view layers must reject extreme grazing faces instead of projecting isolated triangle islands.',
);
assert.doesNotMatch(
  maskedProjectedImageWorkerSource,
  /removeSolidBackground|removeEdgeConnectedNeutralBackground|alignCutoutToProjectionMask/,
  'The production projection worker must never infer transparency from dark connected pixels.',
);
assert.match(
  `${projectedLayerMaterialSource}\n${projectedPreviewCompositorSource}\n${gpuUvBakeRendererSource}`,
  /mix\(texel\.a, 1\.0, ignoreSourceAlpha\)/,
  'Mask-authored repaint preview and bake paths must be able to ignore damaged source alpha.',
);
assert.match(
  bakeProjectedLayerToTextureSource,
  /ignoreSourceAlpha: layer\.ignoreSourceAlpha \?\? localRepaint/,
  'Legacy local-repaint layers must normalize to brush-mask-only alpha during UV baking.',
);
assert.match(
  sceneRootSource,
  /const localRepaint = isRenderedLocalRepaintLayer\(layer\);[\s\S]*?storedDepthUrl = layer\.depthUrl \?\? capture\?\.depthUrl[\s\S]*?useDepthCheck: Boolean\(depthUrl\)[\s\S]*?ignoreSourceAlpha: layer\.ignoreSourceAlpha \?\? localRepaint/,
  'Resident local repaint must ignore source alpha while retaining front-surface capture depth.',
);
assert.match(
  viewportCanvasInteractionSource,
  /const visibilityDepthUrl = runtimeDepth\?\.depthUrl \?\? source\.depthUrl;[\s\S]*?depthUrl: visibilityDepthUrl[\s\S]*?useDepthCheck: Boolean\(visibilityDepthUrl\)/,
  'The live local-repaint overlay must bind runtime or captured depth to prevent projection-through.',
);
assert.match(
  projectedPreviewCompositorSource,
  /float depthAuthoritativeFacingCoverage = mix\([\s\S]*?lockedFacingCoverage,[\s\S]*?1\.0,[\s\S]*?useDepthCheck[\s\S]*?float lockedCoverage =\s*layerOpacity \*\s*sourceAlpha \*\s*depthAuthoritativeFacingCoverage \*\s*lockedSafetyCoverage \*\s*visibilityCoverage/,
  'Depth-backed surface locking must not attenuate accepted pixels with unreliable mesh normals.',
);
assert.match(
  projectedLayerMaterialSource,
  /float lockedCoverage =\s*layerOpacity \*\s*sourceAlpha \*\s*projectionFacingCoverage \*\s*lockedSafetyCoverage/,
  'The resident surface-locked material must preserve continuous local-repaint coverage.',
);
assert.match(
  sceneRootSource,
  /const storedDepthIsLinearView[\s\S]*?return !\(storedDepthUrl && storedDepthIsLinearView\);[\s\S]*?runtimeProjectionVisibilityStatus = 'stored'/,
  'A valid authored linear-depth capture must remain the stable preview authority instead of being replaced by a delayed runtime render.',
);
assert.match(
  sceneRootSource,
  /storedDepthUrl && storedDepthIsLinearView[\s\S]*?\? undefined[\s\S]*?: runtimeVisibilityByLayerId\[layer\.id\]/,
  'A stale runtime visibility result must not override an authored linear-depth capture.',
);
assert.doesNotMatch(
  `${sceneRootSource}\n${viewportCanvasInteractionSource}`,
  /includeNormal:\s*true/,
  'Runtime preview visibility must not publish flat triangle normals into projection alpha.',
);
assert.match(
  bakeProjectedLayerToTextureSource,
  /runtimeVisibilityIncludeNormal = input\.runtimeVisibilityIncludeNormal === true/,
  'Final UV baking must keep geometric-normal visibility opt-in.',
);
assert.doesNotMatch(
  `${projectedLayerMaterialSource}\n${projectedPreviewCompositorSource}\n${gpuUvBakeRendererSource}`,
  /abs\(projectedFaceNormal\.z\)|dot\(projectedFaceNormal, normalize\(-captureViewPosition\)\)/,
  'Projection angle feather must use interpolated vertex normals rather than triangle-constant derivative normals.',
);
assert.doesNotMatch(
  `${projectedLayerMaterialSource}\n${projectedPreviewCompositorSource}`,
  /step\(0\.001, visibilitySupport\)|SURFACE_LOCKED_VISIBILITY_THRESHOLD/,
  'Resident and staged preview coverage must not threshold visibility support into triangular comb teeth.',
);
assert.match(
  gpuUvBakeRendererSource,
  /const SURFACE_LOCKED_VISIBILITY_FEATHER = 0\.05;[\s\S]*?float normalCheckWeight = useNormalCheck \* \(1\.0 - surfaceLockedVisibility\);[\s\S]*?SURFACE_LOCKED_VISIBILITY_FEATHER\.toFixed\(2\)[\s\S]*?visibilitySupport/,
  'The UV bake must turn trustworthy depth-neighbourhood support into opaque surface-locked coverage.',
);
assert.match(
  projectedLayerMaterialSource,
  /quality = mix\(quality, max\(quality, coverage\), surfaceLockedVisibility\);[\s\S]*?quality = mix\([\s\S]*?max\(quality, coverage\),[\s\S]*?compactSurfaceLocks\[layerIndex\]/,
  'Resident surface-locked projections must keep depth-accepted priority overlays opaque in both material paths.',
);
assert.match(
  projectedPreviewCompositorSource,
  /quality = mix\(quality, max\(quality, coverage\), surfaceLockedVisibility\);/,
  'The staged preview compositor must not re-attenuate depth-accepted priority overlays with mesh-normal quality.',
);
assert.match(
  gpuUvBakeRendererSource,
  /quality = mix\(quality, max\(quality, coverage\), surfaceLockedVisibility\);/,
  'The UV bake must preserve the same surface-locked priority quality as the live preview.',
);
assert.match(
  sceneRootSource,
  /const storedLayers = projectedCandidates[\s\S]*?sort\(\(a, b\) => b\.order - a\.order\)/,
  'Every persisted projection must enter the single resident stack, including rows whose eyes are closed.',
);
assert.doesNotMatch(
  sceneRootSource,
  /coldVisibleCandidates|initialProjectedMaterialColdReady|setInitialProjectedMaterialColdReady/,
  'Cold restore must not publish a temporary projected material that is later replaced by the resident stack.',
);
assert.match(
  projectedLayerMaterialSource,
  /PROJECTED_ARRAY_DEPTH_MEMORY_BUDGET = 224 \* 1024 \* 1024[\s\S]*?PROJECTED_ARRAY_MAX_DEPTH_PREVIEW_SIDE = 2048[\s\S]*?PROJECTED_ARRAY_FRAME_PIXEL_BUDGET = 1024 \* 1024/,
  'Resident depth arrays must preserve authored 2K coverage while yielding bounded upload stripes.',
);
assert.doesNotMatch(
  projectedLayerMaterialSource,
  /computeProjectionEmptyFeatherColor|vec3\(0\.040\)/,
  'Projection feathering must not inject a white/grey placeholder colour.',
);
assert.match(
  liveSurfacePaintPreviewRegistrySource,
  /currentPreview\?\.objectId === preview\.objectId[\s\S]*?currentPreview\.layerId === preview\.layerId[\s\S]*?currentPreview\.assetUrl === preview\.assetUrl[\s\S]*?return;/,
  'Repeated short eraser strokes must not republish an identical live preview and restart the projected-material effect.',
);
assert.match(
  layersPanelSource,
  /function beginVisibilityDrag[\s\S]*?useLayerStore\.getState\(\)\.layers[\s\S]*?currentLayer\.visible/,
  'Rapid eye toggles must calculate their next value from the authoritative store, not a deferred row snapshot.',
);
assert.match(
  viewportCanvasInteractionSource,
  /state\.activeProjectedLayerId && layer\.visible/,
  'A hidden active row must be excluded from the surface-paint target immediately.',
);
assert.match(
  sceneRootSource,
  /if \(projectedMaterial && projectedLayerInput\) \{[\s\S]*?updateProjectedLayerStackMaterial\(projectedMaterial,[\s\S]*?topUvProjectedOverlayInput/,
  'A reused asynchronous texture-array material must receive the current effect live-erasure uniforms before publication.',
);
assert.match(
  sceneRootSource,
  /const authoritativeLiveSurfacePreview = getLiveSurfacePaintPreview\(\);[\s\S]*?syncProjectedLayerLiveEraserPreviewInObject\([\s\S]*?authoritativeLiveEraserLayerId,[\s\S]*?authoritativeLiveEraserTexture/,
  'Final projected-material publication must atomically rebind the current registry eraser layer instead of a stale effect closure.',
);
assert.equal(
  (projectedLayerMaterialSource.match(/layerOpacity\$\{index\} \* sourceAlpha/g) ?? []).length >= 2,
  true,
  'Both generated projected-stack variants must preserve source alpha for surface-locked layers.',
);
assert.match(
  viewportPanelSource,
  /\{ value: 'flat', labelKey: 'flatShort' \},\s*\{ value: 'pbr', labelKey: 'pbr' \}/,
  'Flat view must appear before PBR in the viewport controls.',
);
assert.match(
  sceneStoreSource,
  /displayMode: 'flat',[\s\S]*?version: 2,[\s\S]*?version < 2[\s\S]*?displayMode: 'flat'/,
  'Flat view must be the initial and migrated viewport preference.',
);
assert.match(
  editorShellSource,
  /if \(nextMode === 'texture'\) setDisplayMode\('flat'\);/,
  'Entering the texture workspace must default to flat view.',
);
const maskStrokeDeclaration = viewportCanvasInteractionSource.match(/const isMaskStroke = isInpaintMode \|\| isLocalRepaintApplyMode;/)?.[0];
const contextMenuBody = viewportCanvasInteractionSource.match(/const handleContextMenu = \(event: MouseEvent\) => \{([\s\S]*?)\n {4}\};/)?.[1];
assert(maskStrokeDeclaration && contextMenuBody);
const runContextMenu = new Function('isInpaintMode', 'isLocalRepaintApplyMode', 'event', `${maskStrokeDeclaration}\n${contextMenuBody}`);
for (const mask of [false, true]) for (const apply of [false, true]) {
  let prevented = false;
  runContextMenu(mask, apply, { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'RMB orbit always suppresses the browser context menu.');
}
assert.match(
  viewportCanvasInteractionSource,
  /const maximumProjectedRadius = Math\.min\([\s\S]*?fallbackUvRadius \* 4[\s\S]*?length > maximumProjectedRadius[\s\S]*?axis\.multiplyScalar\(maximumProjectedRadius \/ length\)/,
  'A grazing local-repaint projection must clamp a dot stroke before it can erase unrelated material regions.',
);
assert.match(
  viewportCanvasInteractionSource,
  /const eraserFeather = paintToolSettings\.eraserFeather \?\? 50;[\s\S]*?layer\.liveResultContext[\s\S]*?'destination-out',[\s\S]*?'uv',[\s\S]*?eraserFeather/,
  'The projected-layer eraser must apply its feather value to the live keep-mask.',
);
const promoteProjectedEraserMaskSource = viewportCanvasInteractionSource.match(
  /function promoteProjectedEraserMaskToResidentMaterial[\s\S]*?\n}\n\nfunction endLiveEraserPreview/,
)?.[0];
assert.ok(
  promoteProjectedEraserMaskSource,
  'The projected eraser must expose a verified resident-mask handoff.',
);
assert.match(
  promoteProjectedEraserMaskSource,
  /syncProjectedLayerResidentMaskTextureInObject\([\s\S]*?if \(result\.bound && !layer\.liveEraserPreviewActive\)[\s\S]*?syncProjectedLayerLiveEraserPreviewInObject\(root, undefined, undefined\)/,
  'The live multiplier may be cleared only after every resident material samples the committed mask texture.',
);
const endLiveEraserPreviewSource = viewportCanvasInteractionSource.match(
  /function endLiveEraserPreview\(layer: UvPaintLayer, renderer\?: THREE\.WebGLRenderer\)[\s\S]*?\n}\n\nfunction getPaintHistoryTileBounds/,
)?.[0];
assert.ok(endLiveEraserPreviewSource, 'The projected-layer eraser preview teardown must exist.');
assert.match(
  endLiveEraserPreviewSource,
  /pendingPaintCommits === 0[\s\S]*?promoteProjectedEraserMaskToResidentMaterial[\s\S]*?clearLiveSurfacePaintPreview\(layer\.layerId, layer\.liveResultUrl\)[\s\S]*?pendingPaintCommits === 0[\s\S]*?layer\.liveEraserPreviewRoot = undefined/,
  'Ending a projected-layer eraser preview must retain root ownership until an in-flight commit can complete its atomic handoff.',
);
assert.match(
  viewportCanvasInteractionSource,
  /updateLayer\(layer\.layerId,[\s\S]*?promoteProjectedEraserMaskToResidentMaterial\([\s\S]*?layer,[\s\S]*?projectedEraserCommit\.model\.group[\s\S]*?\.finally\(\(\) => \{[\s\S]*?pendingPaintCommits === 0 && !layer\.liveEraserPreviewActive[\s\S]*?endLiveEraserPreview\(layer, gl\)/,
  'Pointer-up must promote the full-resolution canvas and finish a deferred teardown after the last queued commit.',
);
assert.match(
  viewportCanvasInteractionSource,
  /erasesLocalRepaint && paintTool === 'eraser'[\s\S]*?paintToolSettings\.eraserFeather/,
  'The dedicated eraser feather must also control completed local-repaint masks.',
);
const bottomToolDockSource = readFileSync(
  path.join(root, 'src/components/editor/BottomToolDock.tsx'),
  'utf8',
);
assert.match(
  bottomToolDockSource,
  /getEraserTargetPolicy\(activeLayer\)[\s\S]*?shortcut="E"[\s\S]*?<Eraser/,
  'The texture dock must expose the policy-gated active-layer eraser and its Modddif shortcut.',
);
assert.match(
  viewportCanvasInteractionSource,
  /target === 'projected-mask'[\s\S]*?UV_TEXTURE_RESOLUTION\[textureResolutionSetting\]/,
  'The durable projected keep-mask must use the selected project texture resolution.',
);
assert.match(
  viewportCanvasInteractionSource,
  /target === 'projected-mask' && !existingAssetUrl[\s\S]*?fillStyle = '#ffffff'/,
  'A new projected eraser must start its stable resident mask from neutral white.',
);
assert.match(
  viewportCanvasInteractionSource,
  /layer\.target === 'projected-mask' && layer\.isReady && !layer\.pendingBaseImage[\s\S]*?residentMaskUrl: layer\.assetUrl/,
  'A ready projected eraser must prewarm its stable resident mask URL before the first stroke.',
);
assert.match(
  sceneRootSource,
  /function applyLiveProjectedMaskBinding[\s\S]*?if \(preview\.composition === 'multiply-original-mask'\) return layer;[\s\S]*?const maskUrl = preview\.assetUrl/,
  'The transient projected eraser multiplier must remain outside the authored texture-array structure.',
);
const projectedTextureArraySignatureSource = sceneRootSource.slice(
  sceneRootSource.indexOf('const projectedTextureArrayStructureSignature'),
  sceneRootSource.indexOf('const projectedSamplerBudget'),
);
assert.doesNotMatch(
  projectedTextureArraySignatureSource,
  /liveProjectedMaskRevisionSignature/,
  'A direct live mask sampler pixel revision must not repack the authored texture arrays.',
);
assert.match(
  sceneRootSource,
  /const useProjectedProgramWarmupTextureArrays = Boolean\([\s\S]*?gl\.capabilities\.isWebGL2[\s\S]*?projectedProgramWarmupInputs\.length > 1/,
  'A multi-view WebGL2 stack must prepare its texture arrays before eraser activation.',
);
assert.match(
  sceneRootSource,
  /const projectedTextureArrayReadySignatureRef = useRef\(''\)[\s\S]*?projectedTextureArrayReadySignatureRef\.current === textureArrayBuildSignature[\s\S]*?projectedTextureArrayReadySignatureRef\.current = textureArrayBuildSignature/,
  'A multi-view WebGL2 stack must prewarm once and preserve its GPU-ready signature after material transfer.',
);
assert.match(
  viewportCanvasInteractionSource,
  /liveEraserPreviewDirty: boolean[\s\S]*?!layer\.liveEraserPreviewDirty[\s\S]*?clearLiveSurfacePaintPreview\(layer\.layerId, layer\.liveResultUrl\)[\s\S]*?layer\.liveEraserPreviewDirty = true/,
  'Neutral tool activation must switch layers synchronously while real strokes retain the persistence handoff.',
);
assert.match(
  projectedLayerMaterialSource,
  /Every array layer owns a reserved neutral keep-mask slice[\s\S]*?\? 1[\s\S]*?reserved-uv-mask:\$\{layer\.layerId\}[\s\S]*?copyTexSubImage3D/,
  'Every projected array layer must reserve a mask slot and promote a completed stroke with an in-place GPU slice copy.',
);
assert.match(
  projectedLayerMaterialSource,
  /replaceSource[\s\S]*?mix\(baseKeep \* liveKeep, liveKeep, replaceSource\)/,
  'Normal handoff must multiply the live keep-mask while undo/redo can atomically replace the reserved slice.',
);
assert.match(
  sceneRootSource,
  /if \(!liveProjectedEraserMaskTexture\) return;[\s\S]*?const projectedMaterialStructureKey[\s\S]*?if \(committedProjectedMaterialStructureRef\.current !== projectedMaterialStructureKey\)[\s\S]*?replacement material only after the persistent mask is resident/,
  'Eye and tool toggles must retain the live eraser multiplier until either direct or array resident material owns the persistent mask.',
);
assert.match(
  viewportCanvasInteractionSource,
  /previewOwnsOverlay &&[\s\S]*?sceneState\.localRepaintGenerationPresentationActive[\s\S]*?localRepaintGenerationPresentationActive,[\s\S]*?paintTool/,
  'A running local generation must keep the previous renderer-owned repaint visible while editing is locked.',
);
assert.match(
  generatePanelSource,
  /captureCurrentLocalRepaintView\([\s\S]*?resolution: LOCAL_REPAINT_INPUT_RESOLUTION[\s\S]*?colorMode: 'flat-target-coverage'[\s\S]*?cameraSnapshot: captureCameraSnapshot/,
  'The local-repaint current-effect input must capture frozen-camera BaseColor without PBR lighting.',
);
assert.match(
  generatePanelSource,
  /const completedGeneration: Generation = \{[\s\S]*?syncGeneration\(completedGeneration\);[\s\S]*?setGenerateNotice\(undefined\);[\s\S]*?void Promise\.all\(\[[\s\S]*?persistedResultUrlPromise,[\s\S]*?persistedAuthoredMaskUrlPromise,[\s\S]*?persistedSubmittedMaskUrlPromise,[\s\S]*?\]\)/,
  'A returned repaint result must leave the foreground spinner before local persistence continues in the background.',
);
assert.match(
  generatePanelSource,
  /setTexturePreviewMode\('repaint'\);\s*setTab\('repaint'\);/,
  'A completed local repaint must keep the next generate action on the repaint channel.',
);
assert.match(
  generatePanelSource,
  /async function handleGenerate\(\) \{[\s\S]*?if \(displayedTexturePreviewMode === 'repaint'\) \{[\s\S]*?handleLocalRepaintGenerate\(\)/,
  'The visible repaint preview must never fall through to multi-view generation.',
);
assert.match(
  generatePanelSource,
  /onChange=\{\(value\) => \{\s*setTexturePreviewMode\(value\);\s*if \(value === 'repaint'\) \{\s*setTab\('repaint'\);/,
  'Selecting the repaint result view must also select the repaint generation channel.',
);
const captureCurrentViewSource = readFileSync(
  path.join(root, 'src/engine/capture/captureCurrentView.ts'),
  'utf8',
);
assert.match(
  captureCurrentViewSource,
  /previewLightingEnabled\.value = 0;[\s\S]*?previewExposure\.value = 1/,
  'Flat target capture must disable both preview lighting and exposure compensation.',
);
assert.match(
  captureCurrentViewSource,
  /localRepaintInteractiveCaptureSize = maxCaptureSize[\s\S]*?mutatedShaderMaterials[\s\S]*?return source;/,
  'Button 2 must reuse the resident flat shader while preserving a real 2K source.',
);
assert.match(
  captureCurrentViewSource,
  /withStableClayTargetPresentation[\s\S]*?setTransientWhitePresentationObject\(objectId\)[\s\S]*?await waitForViewportFrame\(\)[\s\S]*?return await task\(\)[\s\S]*?setTransientWhitePresentationObject\(previousPresentationObjectId\)/,
  'A multiview capture batch must keep a reactive white membrane without restoring stale materials.',
);
assert.match(
  captureCurrentViewSource,
  /captureClayTarget[\s\S]*?prepareScene:\s*\(\) =>[\s\S]*?applyTargetOnlyMaterial\([\s\S]*?captureMaterial/,
  'Tiled clay snapshots must scope target-only visibility to each offscreen draw.',
);
assert.match(
  renderTargetUtilsSource,
  /const restorePreparedScene = options\.prepareScene\?\.\(\);[\s\S]*?request\.gl\.render\(request\.scene, request\.camera\);[\s\S]*?restorePreparedScene\?\.\(\);[\s\S]*?await tileCompletion/,
  'Capture-only visibility must be restored before a tiled render yields another viewport frame.',
);
assert.match(
  generatePanelSource,
  /getTextureMapMultiviewCaptures[\s\S]*?withStableClayTargetPresentation\(captureObjectId,[\s\S]*?captureTextureMapCameraView/,
  'Multiview snapshot preparation must run inside the stable white-membrane presentation.',
);
assert.match(
  generatePanelSource,
  /const workflowConfigurationLocked = interactionLocked \|\| snapshotPreparing;[\s\S]*?const workflowSubmissionLocked = interactionLocked \|\| panelTaskRunning;/,
  'Remote multiview generation must lock duplicate submission without locking ordinary panel configuration.',
);
assert.match(
  editorPageSource,
  /const generationConflictLocked =[\s\S]*?localImageGenerationRunning \|\| projectGenerationRunning \|\| generatePanelTaskState\.running;[\s\S]*?const editorTaskRunning = localImageGenerationRunning \|\| contentAwareRepairRunning;[\s\S]*?const snapshotPreparationLocked = generatePanelTaskState\.snapshotPreparing;[\s\S]*?const modelMutationLocked = editorTaskRunning \|\| generationConflictLocked;[\s\S]*?const editorToolsLocked = editorTaskRunning \|\| snapshotPreparationLocked;/,
  'The editor must prevent conflicting generation/model mutations while keeping ordinary editor tools locked only for exclusive local work or snapshot preparation.',
);
assert.match(
  generatePanelSource,
  /failUnsubmittedGeneration[\s\S]*?submissionTimedOut: true[\s\S]*?generationAbortControllersRef\.current\.get\(generation\.id\)\?\.abort\(\)[\s\S]*?setSubmissionActive\([\s\S]*?onLocalImageGenerationSettled\?\.\(\{ succeeded: false \}\)/,
  'A generation that never reaches the remote service must abort its request and release every local task lock.',
);
assert.match(
  editorPageSource,
  /orphanedRequestTimeout[\s\S]*?hasBackingGeneration[\s\S]*?setLocalImageGenerationRequested\(false\)[\s\S]*?orphaned-local-generation-lock-released/,
  'The editor must self-heal a local-generation request bridge with no backing panel or generation task.',
);
assert.match(
  editorPageSource,
  /<ObjectsPanel[\s\S]*?mutationLocked=\{modelMutationLocked\}[\s\S]*?<ObjectTransformPanel[\s\S]*?transformLocked=\{editorToolsLocked\}/,
  'Running multiview tasks must protect model structure while allowing transforms again after snapshot preparation.',
);
assert.match(
  editorPageSource,
  /<BottomToolDock[\s\S]*?interactionLocked=\{editorToolsLocked\}/,
  'Painting and transform tools must be locked only during exclusive work or multiview snapshot preparation.',
);
assert.match(
  editorPageSource,
  /<GeneratePanel[\s\S]*?interactionLocked=\{contentAwareRepairRunning\}/,
  'A toolbar local-generation request must not feed back into GeneratePanel as its own external lock.',
);
assert.match(
  renderTargetUtilsSource,
  /encodedWidth[\s\S]*?encodeFlippedGpuReadbackPngInWorker[\s\S]*?options\.encodedWidth/,
  'Transient repaint guidance resizing must stay in the PNG worker.',
);
assert.match(
  gpuReadbackWorkerSource,
  /resizeRgbaBilinear[\s\S]*?encodeRgbaPngBytes\(outputWidth, outputHeight, output\)/,
  'The PNG worker must resize and encode without returning raw 2K RGBA to the main thread.',
);
assert.match(
  sceneRootSource,
  /const uvMaterialUpdated = syncProjectedLayerResidentTextureVisibilityInObject\([\s\S]*?const projectedMaterialUpdated = syncProjectedLayerMaterialDisplayStateInObject\([\s\S]*?hasVisibleUvContribution[\s\S]*?!uvMaterialUpdated[\s\S]*?!projectedMaterialUpdated[\s\S]*?setUvVisibilityRenderRevision/,
  'Opening an eye after an all-hidden cold restore must schedule a material pass when no resident shader accepted the uniform update.',
);
assert.doesNotMatch(
  sceneRootSource,
  /projectedUvDisplaySignature|reopenedProjectedLayer|reopenedUvLayer/,
  'A resident eye toggle must not force a duplicate full React material reconciliation.',
);
assert.match(
  sceneRootSource,
  /readAuthoritativeLocalRepaintLayers\(\s*layerRenderSignature,\s*uvVisibilityRenderRevision/,
  'React material derivation must rerun only for structure/content changes or an explicit cold-cache revision.',
);
assert.doesNotMatch(
  sceneRootSource,
  /const activeLayerId = useLayerStore\(\(state\) => state\.activeProjectedLayerId\)/,
  'ordinary active-layer changes must not rerender every imported model',
);
assert.match(
  sceneRootSource,
  /const activeUvMaskLayerId = useLayerStore[\s\S]*?activeLayer\.maskSpace === 'uv'/,
  'renderer subscriptions must retain the active UV-mask correctness gate',
);
assert.match(
  sceneRootSource,
  /const residentUvDisplayEnabled = true;[\s\S]*?const useProjectedTextureArrays = Boolean\([\s\S]*?projectedEraserArmed[\s\S]*?gl\.capabilities\.isWebGL2[\s\S]*?const exactProjectedEraserStackSafe = Boolean\([\s\S]*?projectedTextureArraySamplerBudget[\s\S]*?const canUseExactProjectedEraserStack = Boolean\([\s\S]*?projectedEraserArmed && exactProjectedEraserStackSafe[\s\S]*?residentUvDisplayEnabled && !canUseExactProjectedEraserStack[\s\S]*?const materialProjectionInputs = canUseExactProjectedEraserStack[\s\S]*?\? previewProjectionInputs[\s\S]*?: \[\]/,
  'Idle frames must remain UV-only while an armed multi-view eraser restores the exact texture-array stack without Resident UV.',
);
assert.match(
  sceneRootSource,
  /liveSurfacePaintPreview\?\.displayArmed[\s\S]*?target === 'projected-mask'[\s\S]*?objectId === importedModel\.objectId/,
  'A retained commit handoff may keep the exact eraser stack armed only for its owning model.',
);
assert.match(
  viewportCanvasInteractionSource,
  /beginLiveEraserPreview\(layer, model\.group, false\)[\s\S]*?if \(paintTool === 'eraser'\)[\s\S]*?beginLiveEraserPreview\(layer, model\.group\)/,
  'Neutral GPU prewarm must stay UV-only until the eraser tool explicitly owns presentation.',
);
assert.match(
  sceneRootSource,
  /Eye\/opacity controls and display modes must update the resident material[\s\S]*?const authoritativeProjectionLayers = useLayerStore\.getState\(\)\.layers;[\s\S]*?const authoritativeProjectionDisplayInputs = authoritativeProjectionLayers[\s\S]*?syncProjectedLayerMaterialDisplayStateInObject\([\s\S]*?authoritativeProjectionDisplayInputs/,
  'A late texture or lighting effect must re-read authoritative eye state instead of reopening a hidden projection from the structural cache.',
);
assert.match(
  previewTextureCacheSource,
  /function getReadyResidentPreviewTexture\([\s\S]*?previewTextureReadyRenderers\.get\(texture\)\?\.has\(renderer\)/,
  'A decoded cache entry must not be published before its exact upload completes in the active renderer.',
);
assert.match(
  previewTextureCacheSource,
  /if \(previewTextureReadyRenderers\.get\(texture\)\?\.has\(renderer\)\) return Promise\.resolve\(\);[\s\S]*?readyRenderers\.add\(renderer\)/,
  'A cached preview must upload again after project exit creates a new WebGL renderer.',
);
assert.match(
  sceneRootSource,
  /const authoritativeContentAwareUvLayers =[\s\S]*?getReadyResidentPreviewTexture\(authoritativeContentAwareUvLayers\[0\]\.imageUrl, gl\)[\s\S]*?syncProjectedLayerResidentTextureVisibilityInObject\(model\.group,[\s\S]*?baseTexture: authoritativeContentAwareTexture[\s\S]*?baseTextureOpacity: authoritativeContentAwareOpacity/,
  'Final asynchronous material publication must reconcile the authoritative content-aware texture and eye opacity.',
);
assert.match(
  sceneRootSource,
  /function getVisibleMergedUvBoundaryOrder[\s\S]*?layer\.role === 'merged-uv'[\s\S]*?isProjectedLayerAboveMergedUv[\s\S]*?layer\.order < mergedUvBoundaryOrder/,
  'A visible merged UV row must become an explicit layer-order boundary for projected repaint rows.',
);
assert.match(
  sceneRootSource,
  /uvOverlayBelowProjected: Number\.isFinite\(visibleMergedUvBoundaryOrder\)/,
  'The merged UV texture must be composited below projected repaint rows that are higher in the panel.',
);
assert.ok(
  !sceneRootSource.includes('ContactShadows') ||
    /const paintTool = useSceneStore\(\(state\) => state\.paintTool\);[\s\S]*?<group visible=\{paintTool === 'none'\}>[\s\S]*?<ContactShadows/.test(
      sceneRootSource,
    ),
  'The contact-shadow receiver plane must be absent or hidden while a paint tool is active.',
);
assert.match(
  sceneRootSource,
  /const hasAuthoritativeVisibleTextureLayer = useLayerStore\(\(state\) =>[\s\S]*?state\.layers\.some\([\s\S]*?layer\.visible &&[\s\S]*?Boolean\(layer\.imageUrl\)[\s\S]*?layer\.type === 'uv'[\s\S]*?layer\.type === 'projected'/,
  'White-membrane state must come directly from the layer store instead of a cached render-layer memo.',
);
assert.match(
  sceneRootSource,
  /const showWhiteMembrane = Boolean\(\s*transientWhitePresentationObjectId === importedModel\.objectId \|\|\s*\(!hasAuthoritativeVisibleTextureLayer &&\s*!liveTopUvTexture &&\s*!liveSurfacePaintPreview\)/,
  'All hidden content-bearing layers must authoritatively keep the model in white-membrane mode.',
);
assert.match(
  sceneRootSource,
  /const exactBakedBootstrapTexture =\s*loadedBakedTexture &&\s*!showWhiteMembrane &&\s*stableVisibleProjectedLayers\.length > 0 &&/,
  'Changing PBR lighting with every projected eye closed must not restore a stale baked bootstrap texture.',
);
assert.match(
  sceneRootSource,
  /const transientLocalRepaintPreviewLayerId = useLayerStore\([\s\S]*?getTransientLocalRepaintLayerId\(localRepaintPreviewLayerId, state\.layers\)[\s\S]*?layer\.id !== transientLocalRepaintPreviewLayerId/,
  'A completed local repaint must stay structurally resident while its eraser overlay owns visibility.',
);
assert.match(
  sceneRootSource,
  /const alreadyPresentsWhiteMembrane = hasPresentedMaterial && presentsOnlyWhiteMembrane;\s*if \(showWhiteMembrane && alreadyPresentsWhiteMembrane\) \{[\s\S]*?revealInitialMaterialPresentation\(\);[\s\S]*?return;[\s\S]*?\}\s*if \(\s*!showWhiteMembrane &&\s*!canUseProgressivePreviewBase &&\s*hasResidentProjectedMaterial/,
  'PBR changes must publish the current Group before reusing the resident white or projected material.',
);
assert.match(
  sceneRootSource,
  /const allowProgressiveDirectBootstrap = false as boolean/,
  'Cold projection restore must not expose a one-camera partial bootstrap.',
);
assert.match(
  sceneRootSource,
  /const canPresentUvBootstrap = Boolean\([\s\S]*?exactBakedBootstrapTexture \|\|[\s\S]*?loadedUvTexture && uvOverlayOpacity > 0/,
  'Cold restore must present a decoded UV contribution while the complete projected arrays are building.',
);
assert.doesNotMatch(
  sceneRootSource,
  /const canPresentUvBootstrap = Boolean\([\s\S]*?!hasAuthoritativeVisibleProjectedLayer/,
  'A visible projected stack must not force a white membrane when a safe UV underlay is already resident.',
);
assert.match(
  sceneRootSource,
  /const authoritativeResidentUvTexture =\s*authoritativeOrdinaryUvLayers\.length > 0\s*\?[\s\S]*?authoritativeExactUvTexture \?\?[\s\S]*?authoritativeOrdinaryUvKey === visibleResidentUvKey \? loadedUvTexture : undefined[\s\S]*?authoritativeProxyUvTexture[\s\S]*?: undefined/,
  'A late material publication must preserve lower repaint UVs without resurrecting hidden ordinary UVs.',
);
assert.match(
  sceneRootSource,
  /const authoritativeOrdinaryUvLayers = authoritativeUvStack\.filter\([\s\S]*?layer\.id !== authoritativeTopUvLayer\?\.id/,
  'Every visible UV row outside the actual top sampler, including manual repaint, belongs to the lower stack.',
);
assert.match(
  sceneRootSource,
  /if \(isLiveProjectedCanvasUrl\(imageUrl\)\) return undefined/,
  'Borrowed UV render targets must bypass the ordinary image decode/upload/cache lifecycle.',
);
assert.match(sceneRootSource, /residentAllVisibleUvState\.ready\s*\? residentAllVisibleUvState\.texture/, 'Prewarm must not cache a previous composition under the next visibility key.');
assert.match(sceneRootSource, /layer\.imageUrl && !isLiveProjectedCanvasUrl\(layer\.imageUrl\)/, 'Toggle prewarm must not decode runtime URLs as images.');
assert.match(
  sceneRootSource,
  /visible=\{initialMaterialPresentationVisibleForGroup\}/,
  'Cold restore must explicitly control placeholder, outline and final-material presentation.',
);
assert.match(
  sceneRootSource,
  /!importedModel\.restoreStage \|\|[\s\S]*?importedModel\.restoreStage === 'full'[\s\S]*?!hasAuthoritativeVisibleTextureLayer \|\| initialMaterialPresentationReadyForGroup/,
  'A refresh must keep bounds, outline and proxy stages hidden until the full material is ready.',
);
assert.match(
  sceneRootSource,
  /const \[presentedMaterialGroup, setPresentedMaterialGroup\] = useState<THREE\.Group \| undefined>[\s\S]*?presentedMaterialGroup === importedModel\.group/,
  'Atomic reveal must track the exact progressively restored Group instead of a stale boolean.',
);
assert.match(
  sceneRootSource,
  /if \(showWhiteMembrane && alreadyPresentsWhiteMembrane\) \{[\s\S]*?revealInitialMaterialPresentation\(\);[\s\S]*?return;/,
  'A textureless model must publish its final white-membrane Group before the material fast path returns.',
);
assert.match(
  sceneRootSource,
  /if \(\s*!showWhiteMembrane &&\s*!canUseProgressivePreviewBase &&\s*hasResidentProjectedMaterial &&\s*committedProjectedMaterialStructureRef\.current === projectedMaterialStructureKey\s*\) \{[\s\S]*?revealInitialMaterialPresentation\(\);[\s\S]*?return;/,
  'A restored single projected layer must publish its resident Group before the material fast path returns.',
);
assert.match(
  sceneRootSource,
  /requestAnimationFrame[\s\S]*?requestAnimationFrame[\s\S]*?liclick:initial-model-frame-presented/,
  'The editor reveal signal must wait until the first WebGL model frame has actually been presented.',
);
assert.match(
  sceneRootSource,
  /!initialMaterialPresentationVisibleForGroup[\s\S]*?ModelRestoreLoadingIndicator object=\{importedModel\.group\}/,
  'Each restoring model must own an independent loading indicator until its material is presented.',
);
assert.match(
  sceneRootSource,
  /function ModelRestoreLoadingIndicator[\s\S]*?useFrame[\s\S]*?rotation\.z -= delta[\s\S]*?torusGeometry/,
  'The per-model loading indicator must animate in the 3D viewport.',
);
const outlineRestoreBlock = sceneRootSource.slice(
  sceneRootSource.indexOf("if (model.restoreStage === 'outline')"),
  sceneRootSource.indexOf("if (\n        model.restoreStage === 'proxy'"),
);
assert.match(outlineRestoreBlock, /createFlatPreviewMaterial/);
assert.doesNotMatch(
  outlineRestoreBlock,
  /revealInitialMaterialPresentation\(\)/,
  'Cold restore must not reveal the model while it still has the flat outline material.',
);
assert.match(
  sceneRootSource,
  /authoritativeHasVisibleProjection[\s\S]*?presentsProjectedMaterial \|\| presentsExactProjectedBootstrap[\s\S]*?revealInitialMaterialPresentation/,
  'A visible projected stack may reveal only a complete projected material or an exact baked equivalent.',
);
assert.match(
  localRepaintDialogSource,
  /setIsStarting\(true\);[\s\S]*?requestAnimationFrame[\s\S]*?prepareGenerateInput\(\)/,
  'The local repaint Generate button must paint immediate feedback before mask preparation.',
);
assert.match(
  localRepaintMaskWorkerSource,
  /buildEditMask[\s\S]*?buildProtectMask[\s\S]*?computeMaskBoundingBox/,
  'Edit-mask dilation, protection and bounds must run off the main thread.',
);
assert.doesNotMatch(
  `${generatePanelSource}\n${viewportCanvasInteractionSource}\n${sceneRootSource}`,
  /localRepaintGenerationBusy/,
  'Local repaint generation must use frozen capture coordinates instead of a global viewport lock.',
);
assert.match(
  generatePanelSource,
  /captureCurrentLocalRepaintView[\s\S]*?generationPromise[\s\S]*?captureCurrentDepthPreview[\s\S]*?Promise\.all/,
  'The aligned current-effect input and mask must submit before the local-only depth guard finishes in parallel.',
);
assert.match(
  generatePanelSource,
  /start\(pendingGeneration\);\s*addProjectGeneration\(pendingGeneration\);[\s\S]*?setLastCapture\(capture\);/,
  'A new repaint capture must not be paired with the previous result before its running generation exists.',
);
assert.match(
  viewportCanvasInteractionSource,
  /LOCAL_REPAINT_LIVE_SOURCE_MAX_SIZE = 1024/,
  'The interactive repaint preview must not synchronously upload the durable high-resolution source.',
);
assert.match(
  viewportCanvasInteractionSource,
  /LOCAL_REPAINT_MINIMUM_FACE_ON = 0\.08/,
  'Local repaint projection must feather inward before reaching grazing side faces.',
);
assert.match(
  projectedLayerMaterialSource,
  /sourceAlpha \*[\s\S]*?projectionFacingCoverage \*[\s\S]*?lockedSafetyCoverage/,
  'Surface-locked repaint must retain smooth facing coverage so the base UV shows through without black seams.',
);
const uvSamplerWarmupSource = sceneRootSource.match(
  /const prewarmProjectedUvSamplers = async \([\s\S]*?\r?\n {4}async function applyMaterials/,
)?.[0];
assert(uvSamplerWarmupSource, 'Expected the projected UV sampler warmup implementation.');
assert.match(
  uvSamplerWarmupSource,
  /await precompileProjectedMaterial\(material, warmTarget\);\s*if \(cancelled\) return;/,
  'Await the offscreen program and recheck cancellation before exercising UV samplers.',
);
assert.match(
  uvSamplerWarmupSource,
  /await waitForViewportInteractionIdle\(\);[\s\S]*?const frameTarget = gl\.getRenderTarget\(\);[\s\S]*?gl\.setRenderTarget\(warmTarget\);[\s\S]*?gl\.render\(warmScene, warmCamera\);[\s\S]*?gl\.setRenderTarget\(frameTarget\);/,
  'Every fullscreen sampler warmup draw must bind and restore its offscreen target after the last await.',
);
assert.doesNotMatch(
  uvSamplerWarmupSource,
  /gl\.setRenderTarget\(warmTarget\);\s*for \(/,
  'The sampler warmup must not keep an offscreen target bound across animation frames.',
);
const viewportCanvasSource = readFileSync(
  path.join(root, 'src/engine/viewport/ViewportCanvas.tsx'),
  'utf8',
);
assert.match(
  viewportCanvasSource,
  /const rightModelEraseContact =\s*event\.pointerType === 'mouse' && event\.button === 2 && Boolean\(result\);[\s\S]*?const localRepaintEraseContact =\s*isLocalRepaintApplyMode &&[\s\S]*?rightModelEraseContact[\s\S]*?isEditingPersistedLocalRepaint && event\.button === 0/,
  'After repaint RMB has exited to its settings menu, pen and primary eraser routing remains intact.',
);
assert.match(
  viewportCanvasSource,
  /const isPaintButton = event\.button === 0 \|\| penEraserContact \|\| rightModelEraseContact;/,
  'RMB may be consumed by paint only after the model raycast has hit.',
);
assert.match(
  viewportCanvasSource,
  /const isLocalRepaintApplyMode =\s*paintTool === 'inpaint-apply' \|\| isEditingPersistedLocalRepaint/,
  'The ordinary eraser must enter the non-destructive local repaint path for a completed repaint layer.',
);
assert.match(
  viewportCanvasSource,
  /!canUseSurfacePaint \|\|\s*isLocalRepaintApplyMode[\s\S]*?beginLiveEraserPreview/,
  'A local repaint session (persisted or native GPU) must never prewarm the generic eraser.',
);
assert.match(
  viewportCanvasSource,
  /setLocalRepaintProjectionSource\(\{[\s\S]*?imageUrl: sourceUrl,[\s\S]*?allowedMaskUrl,[\s\S]*?camera: projectionCamera/,
  'Re-entering the eraser must restore the persisted local repaint editing source.',
);
assert.match(
  viewportCanvasSource,
  /const shouldPrewarmPersistedLocalRepaint = isEditingPersistedLocalRepaint;/,
  'Only an explicitly selected eraser target may restore a persisted editing source.',
);
const featherPrewarmGuard = viewportCanvasSource.match(
  /useEffect\(\(\) => \{\s*if \(([^\n]+)\) return;\s*(?:\/\/[^\n]*\n\s*)*getFeatheredBrushStamp\(localRepaintBrushSettings\.brushFeather\)/,
);
assert.ok(featherPrewarmGuard, 'The feather stamp must be prepared by an effect before pointer input.');
const shouldPrewarmFeather = new Function(
  'shouldPrewarmPersistedLocalRepaint',
  'localRepaintGenerationPresentationActive',
  'isInpaintMode',
  'paintTool',
  `return !(${featherPrewarmGuard[1]});`,
);
assert.equal(shouldPrewarmFeather(true, false, false, 'eraser'), true, 'Eraser targets prewarm before pointer input.');
assert.equal(shouldPrewarmFeather(false, true, false, 'none'), true, 'Generation prewarms in parallel.');
assert.equal(shouldPrewarmFeather(false, false, true, 'inpaint'), true, 'Mask authoring prewarms.');
assert.equal(shouldPrewarmFeather(false, false, false, 'inpaint-apply'), true, 'Apply retains prewarming.');
assert.equal(shouldPrewarmFeather(false, false, false, 'none'), false, 'Unrelated idle tools do not prewarm.');
assert.match(
  viewportCanvasSource,
  /if \(!shouldPrewarmPersistedLocalRepaint \|\| !activePaintLayer\?\.camera\) return;[\s\S]*?if \(currentPaintTool !== 'eraser'\) return;/,
  'A persisted source cannot publish after leaving the eraser, even before effect cleanup.',
);
assert.match(
  viewportCanvasSource,
  /const enhancedSourceUrl = activePaintLayer\.imageUrl \|\| activePaintLayer\.localRepaintSourceUrl;[\s\S]*?activePaintLayer\.localRepaintRawSourceUrl \|\| enhancedSourceUrl[\s\S]*?const savedMaskUrl = activePaintLayer\.localRepaintMaskUrl \|\| activePaintLayer\.maskUrl;/,
  'Reloaded repaint editing must prefer authored coverage while retaining canonical and raw color sources.',
);
assert.match(
  viewportCanvasSource,
  /if \(composite\.restoredMaskUrl && !composite\.restoredMaskReady\) return;[\s\S]*?const commitRevision =/,
  'An unrecovered persisted mask must never publish an empty live canvas.',
);
assert.match(
  viewportCanvasSource,
  /const exactOverlayOwnsPersistedEraser = Boolean\([\s\S]*?exactOverlayReady && repaintPreviewLayer\?\.id === composite\?\.layerId[\s\S]*?const presentationOwnerReady = isEditingPersistedLocalRepaint\s*\? residentMaskBound \|\| exactOverlayOwnsPersistedEraser\s*:\s*exactOverlayReady/,
  'A just-published repaint must remain editable through its exact overlay until the resident eraser mask is bound.',
);
const exactPresentation = viewportCanvasSource.match(/const exactOverlayPresentationRequired =([\s\S]*?);/);
assert.ok(exactPresentation);
const requiresExactPresentation = new Function('liveFeedbackRequested', 'previewOwnsOverlay', 'residentHandoffPending',
  `return (${exactPresentation[1]});`);
assert.equal(requiresExactPresentation(false, true, false), true,
  'Switching to eraser or another tool must retain the existing exact owner while the material prepares.');
assert.equal(requiresExactPresentation(false, false, true), true,
  'A presented handoff must finish before the exact overlay is withdrawn.');
assert.equal(requiresExactPresentation(false, false, false), false,
  'An idle persisted layer without a live owner uses the formal material.');
assert.match(
  sceneRootSource,
  /const localRepaintLiveFeedbackRequested =\s*localRepaintPaintTool === 'inpaint-apply' \|\|\s*\(localRepaintPaintTool === 'eraser' && localRepaintPreviewActive\)/,
  'SceneRoot must keep the resident repaint row muted until the eraser overlay handoff completes.',
);
assert.match(
  viewportCanvasSource,
  /paintTool === 'inpaint-subtract' \|\|\s*isEditingPersistedLocalRepaint[\s\S]*?return undefined;[\s\S]*?clearLocalRepaintResidentMaskOverride/,
  'The resident live-mask override must stay bound for the entire persisted repaint eraser session.',
);
assert.match(
  viewportCanvasSource,
  /const savedMaskUrls = \[existingLayer\?\.localRepaintMaskUrl, existingLayer\?\.maskUrl\][\s\S]*?for \(const candidateUrl of savedMaskUrls\)/,
  'Mask restoration must prefer authored coverage and fall back to the display mask for legacy projects.',
);
assert.match(
  viewportCanvasSource,
  /const shouldRetryGpuPreparation = Boolean\([\s\S]*?requestLocalRepaintGpuPrepare\(\);[\s\S]*?local-repaint-eraser-prepare/,
  'A blocked repaint eraser must request recovery and explain its readiness state instead of silently dropping input.',
);
assert.match(
  viewportCanvasSource,
  /isEditingPersistedLocalRepaint &&\s*!isLocalRepaintSourceForLayer\(source, activePaintLayer\)/,
  'The eraser must reject input until the selected repaint layer owns the restored source.',
);
assert.match(
  viewportCanvasSource,
  /const releasePreviousPreview = async[\s\S]*?await waitForLocalRepaintResidentHandoff\([\s\S]*?state\.setLocalRepaintPreviewLayer\(undefined\)[\s\S]*?await releasePreviousPreview\(\)/,
  'Switching repaint layers must wait for resident display before releasing the old overlay.',
);
assert.doesNotMatch(
  editorPageSource,
  /selectedPersistedLocalRepaint|latestActiveLayer/,
  'A stale persisted active-layer id must not block newest-result decode and GPU prewarm.',
);
assert.match(
  editorPageSource,
  /const visibleProjectionSource = latestSceneState\.localRepaintProjectionSource;[\s\S]*?resolveLocalRepaintBackgroundPrewarmDisposition\(\{[\s\S]*?currentSource: visibleProjectionSource,[\s\S]*?targetLayerId: currentTarget\.id,[\s\S]*?\}\);[\s\S]*?if \(disposition === 'preserve-current-source'\) return;/,
  'A live historical repaint source must remain the real ownership guard for background prewarm.',
);
const ownershipExpression = viewportCanvasSource.match(/const overlayCanOwnPresentation =([\s\S]*?);/);
assert.ok(ownershipExpression);
const canOwnPresentation = new Function('existingLayer', 'sceneState', 'currentPreviewLayer', 'projectedLayer', 'composite',
  `return (${ownershipExpression[1]});`);
assert.equal(canOwnPresentation({}, { paintTool: 'inpaint-apply' }, undefined, { id: 'row' }, { hasContent: false }), true);
assert.equal(canOwnPresentation({}, { paintTool: 'none' }, { id: 'row' }, { id: 'row' }, { hasContent: true }), true,
  'A nonempty pending preview keeps ownership when switching tools.');
assert.equal(canOwnPresentation({}, { paintTool: 'none' }, { id: 'other' }, { id: 'row' }, { hasContent: true }), false);
assert.equal(canOwnPresentation({}, { paintTool: 'none' }, { id: 'row' }, { id: 'row' }, { hasContent: false }), false);
assert.match(
  viewportCanvasSource,
  /visible: existingLayer\?\.visible \?\? true,[\s\S]*?opacity: existingLayer\?\.opacity \?\? 1,[\s\S]*?strength: existingLayer\?\.strength \?\? 1,[\s\S]*?adjustments: existingLayer\?\.adjustments/,
  'The renderer-owned repaint twin must inherit the persisted row adjustments instead of resetting them.',
);
assert.match(
  viewportCanvasSource,
  /contentRevision: existingLayer \? \(existingLayer\.contentRevision \?\? 0\) : undefined/,
  'Legacy completed repaint rows must be distinguishable from a brand-new transient repaint preview.',
);
assert.match(
  viewportCanvasSource,
  /const exactOverlayVisible =\s*shouldRenderExactOverlay &&\s*\(liveFeedbackRequested \|\|[\s\S]*?residentHandoffPending\);[\s\S]*?const rendererPreviewOwnsPresentation =\s*exactOverlayVisible \|\| \(!hasPersistedLayer && orderedStackOwnsPreview\);[\s\S]*?hasPersistedLayer &&[\s\S]*?residentOverrideBound &&[\s\S]*?previewOwnsOverlay &&[\s\S]*?!liveFeedbackRequested[\s\S]*?setLocalRepaintPreviewLayer\(undefined\);[\s\S]*?scheduleLocalRepaintResidentPresentation\(liveLayerId\);/,
  'Apply mode must retain the exact overlay, then transfer ownership only after the resident-mask handoff is allowed.',
);
assert.match(
  viewportCanvasSource,
  /visible: existingProjectionLayer\?\.visible \?\? true,[\s\S]*?opacity: existingProjectionLayer\?\.opacity \?\? 1,[\s\S]*?strength: existingProjectionLayer\?\.strength \?\? 1,[\s\S]*?order: existingProjectionLayer\?\.order \?\? 0/,
  'Committing an erased repaint mask must preserve the user-facing layer presentation and order.',
);
assert.match(
  viewportCanvasSource,
  /currentPreviewLayer\?\.id === projectedLayer\.id &&[\s\S]*?!overlayCanOwnPresentation[\s\S]*?setLocalRepaintPreviewLayer\(undefined\)/,
  'Refresh must clear a stale live-owner marker outside apply mode instead of hiding both the saved repaint and its overlay.',
);
assert.match(
  viewportCanvasSource,
  /const exactOverlayReady = Boolean\([\s\S]*?overlay\?\.sourceKey === sourceKey[\s\S]*?const exactOverlayOwnsPersistedEraser = Boolean\([\s\S]*?const presentationOwnerReady = isEditingPersistedLocalRepaint\s*\? residentMaskBound \|\| exactOverlayOwnsPersistedEraser\s*:\s*exactOverlayReady;/,
  'Pointer-down must consume the prewarmed exact overlay for apply mode and the pending persisted-eraser handoff.',
);
assert.match(
  viewportCanvasSource,
  /const savedLiveMask = savedMaskUrls[\s\S]*?getLiveProjectedCanvasState\(url\)\?\.canvas[\s\S]*?const savedLiveMaskCanvas = savedLiveMask\?\.canvas[\s\S]*?createLocalRepaintComposite\(/,
  'Switching repaint layers must capture any authored live mask before registering its replacement canvas.',
);
assert.doesNotMatch(
  viewportCanvasSource,
  /savedMaskUrl && savedMaskUrl !== composite\.maskUrl/,
  'A stable live mask URL must still be restored when a new canvas reuses that URL.',
);
assert.match(
  viewportCanvasSource,
  /if \(composite\.restoredMaskPromise\) \{[\s\S]*?withLocalRepaintSessionTimeout\([\s\S]*?composite\.restoredMaskPromise[\s\S]*?ensureLocalRepaintGpuOverlay\(model, source, composite\)[\s\S]*?ensureLiveLocalRepaintComposite\(model, source\) !== composite/,
  'Persisted repaint ownership must publish only after mask restore and GPU overlay readiness.',
);
assert.match(
  viewportCanvasSource,
  /preparedAssets\?\.url !== source\.imageUrl \|\|\s*preparedAssets\.allowedMaskUrl !== source\.allowedMaskUrl/,
  'A repaint stroke must reject decoded assets owned by a different local repaint layer.',
);
assert.match(
  viewportCanvasSource,
  /const keepsLiveLocalRepaintPreview =\s*sceneStateAtCommit\.paintTool === 'inpaint-apply' \|\|\s*erasesPersistedLocalRepaint/,
  'Committing an eraser stroke must retain the cumulative repaint mask for the next stroke.',
);
assert.match(
  viewportCanvasSource,
  /const isPointerContactActive =[\s\S]*?event\.pointerType === 'pen'[\s\S]*?return \(event\.buttons & 3\) !== 0;/,
  'An active left-paint or right-erase local repaint stroke must remain active throughout pointer movement.',
);
assert.match(
  viewportCanvasSource,
  /operation === 'erase' \? 'destination-out' : 'lighten'/,
  'Local repaint erasing must subtract the existing live mask.',
);
assert.match(
  viewportCanvasSource,
  /if \(operation === 'apply'\) \{[\s\S]*?scratchContext\.globalCompositeOperation = 'destination-in'/,
  'Only additive repaint stamps may be clipped by generated-content alpha; erasing must clear the existing mask completely.',
);
assert.match(
  viewportCanvasSource,
  /erasesLocalRepaint && paintTool === 'eraser'[\s\S]*?paintToolSettings\.eraserFeather[\s\S]*?: featherPercent/,
  'The selected dedicated eraser must use its own feather while repaint apply keeps its brush feather.',
);
assert.match(
  viewportCanvasSource,
  /strokePaintTool === 'inpaint-apply' \|\|[\s\S]*?strokePaintTool === 'inpaint-apply-erase'[\s\S]*?erasesLocalRepaint \? 'erase' : 'apply'/,
  'Local repaint apply and erase must share the same projected brush path.',
);
const repaintSourceTransparency = viewportCanvasSource.match(
  /function createLocalRepaintFalloffCanvasAsync\([\s\S]*?\r?\n}\r?\n/,
)?.[0];
assert(
  repaintSourceTransparency,
  'Expected local repaint projection to prepare brush-mask falloff.',
);
assert.match(
  repaintSourceTransparency,
  /manual-brush-scope-v3[\s\S]*?createLocalRepaintFalloffInWorker\(\{[\s\S]*?mask: allowedMaskImage[\s\S]*?width[\s\S]*?height/,
  'Manual source permission must use the new scope cache and validate the frozen source mask without clipping to it.',
);
assert.doesNotMatch(
  repaintSourceTransparency,
  /sourceImage|depthImage|removeEdgeConnectedNeutralBackground|createPackedDepthVisibilityMask|destination-in/,
  'Projection falloff must not cut the generated texture using source alpha, depth or colour.',
);
assert.match(
  viewportCanvasSource,
  /imageUrl: source\.persistentImageUrl \?\? source\.imageUrl[\s\S]*?maskUrl: composite\.blendMaskUrl[\s\S]*?depthUrl: source\.depthUrl[\s\S]*?depthEncoding: source\.depthEncoding[\s\S]*?localRepaintMaskUrl: composite\.maskUrl/,
  'Persisted local repaint projection must retain the editable authored mask, inward blend mask and capture depth used to reject rear surfaces.',
);
assert.match(
  viewportCanvasSource,
  /const visibilityDepthUrl =[\s\S]*?runtimeDepth\?\.depthUrl \?\? source\.depthUrl[\s\S]*?createProjectedLayerMaterial\(\{[\s\S]*?maskUrl: composite\.blendMaskUrl[\s\S]*?depthUrl: visibilityDepthUrl[\s\S]*?useDepthCheck: Boolean\(visibilityDepthUrl\)[\s\S]*?useNormalCheck: false/,
  'The live local repaint projection must bind the inward blend mask and front-surface depth without normal cutout checks.',
);
assert.match(
  generatePanelSource,
  /isLocalRepaintGeneration\(displayedPreviewGeneration\)[\s\S]*?'generated-display'[\s\S]*?createGeneratedDisplayPreview\(sourceUrl, previewProcessingDepthUrl, previewRequest, previewProcessingMode === 'source-alpha'\)[\s\S]*?preview\.fittedUrl/,
  'Local repaint cards must use one depth-authored transparent and fitted UI display copy.',
);
assert.match(
  layersPanelSource,
  /thumbnail \? createLayerThumbnail : createGeneratedDisplayPreview\)\(sourceUrl, depthUrl, \{[\s\S]*?signal: controller.signal, revision,[\s\S]*?displayPreview\.fittedUrl/,
  'Projected layer thumbnails must share the generated transparent display path.',
);
assert.match(
  layersPanelSource,
  /sourceUrl\s*&&\s*!isLocalRepaintPreviewLayer\(layer\)/,
  'Local repaint thumbnails must keep their paint mask instead of showing the full generated subject.',
);
assert.doesNotMatch(
  generatePanelSource,
  /const projectedResultUrl = (?:await )?createGeneratedDisplayPreview/,
  'The UI display copy must never replace the source used for projection or persistence.',
);
assert.match(
  viewportCanvasSource,
  /const compileScene = new THREE\.Scene\(\);[\s\S]*?const overlayCompile = gl\.compileAsync\(compileScene, camera\);[\s\S]*?consumptionCompile = gl\.compileAsync\(consumptionScene, camera\);[\s\S]*?overlayState\.compilePromise = compilePromise/,
  'Local repaint must compile isolated overlay/selection programs, never replaceable scene materials.',
);
assert.match(
  viewportCanvasSource,
  /if \(state\.compilePromise\)[\s\S]*?state\.compilePromise\.then\([\s\S]*?finalizeLocalRepaintGpuOverlayDisposal/,
  'Local repaint material disposal must wait for an in-flight asynchronous compile.',
);
const repaintFalloffWorkerSource = readFileSync(
  path.join(root, 'src/workers/localRepaintFalloff.worker.ts'),
  'utf8',
);
assert.match(
  repaintFalloffWorkerSource,
  /createManualRepaintFalloffPixels\(maskPixels\)[\s\S]*?transferToImageBitmap/,
  'The worker must use bounded inward author coverage without an extra texture silhouette.',
);
assert.doesNotMatch(
  repaintFalloffWorkerSource,
  /\bsource\b|\bdepth\b|removeEdgeConnectedNeutralBackground|createPackedDepthVisibilityMask|destination-in/,
  'The worker must not infer local repaint transparency from source alpha, depth or colour.',
);
assert.match(
  editorPageSource,
  /const getLocalRepaintProjectionImage = useCallback\([\s\S]*?const rawResultUrl =[\s\S]*?if \(seamMode === 'legacy' \|\| !referenceUrl\) return legacyResult;[\s\S]*?harmonizeLocalRepaintInWorker/,
  'An aligned local repaint result must retain a direct, uncropped legacy path beside seam harmonization.',
);
assert.match(
  projectedLayerMaterialSource,
  /float lockedCoverage =[\s\S]*?sourceAlpha[\s\S]*?float coverage = mix\(continuousCoverage, lockedCoverage, surfaceLockedVisibility\)/,
  'Surface-locked repaint must retain continuous source alpha instead of exposing binary black fringe pixels.',
);
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } },
});

try {
  if (!globalThis.ImageData) {
    globalThis.ImageData = class ImageData {
      constructor(dataOrWidth, widthOrHeight, height) {
        if (typeof dataOrWidth === 'number') {
          this.width = dataOrWidth;
          this.height = widthOrHeight;
          this.data = new Uint8ClampedArray(this.width * this.height * 4);
        } else {
          this.data = dataOrWidth;
          this.width = widthOrHeight;
          this.height = height;
        }
      }
    };
  }
  const projection = await server.ssrLoadModule('/src/engine/projection/ProjectedLayerMaterial.ts');
  const { getTopUvPreviewLayer } = await server.ssrLoadModule('/src/engine/projection/uvPreviewStack.ts');
  const manual = { id: 'uuid-manual', type: 'uv', order: 0, visible: true, imageUrl: 'liclick-live-projected-canvas:uuid-manual:rgba' };
  const lower = { ...manual, id: 'uuid-lower', order: 1 };
  assert.equal(getTopUvPreviewLayer([manual, lower], [{ order: 2 }]), manual);
  assert.equal(getTopUvPreviewLayer([lower], [{ order: 2 }]), lower);
  assert.equal(getTopUvPreviewLayer([], [{ order: 2 }]), undefined);
  assert.equal(getTopUvPreviewLayer([lower], [{ order: 0 }]), undefined);
  assert.equal(getTopUvPreviewLayer([lower], [{ order: 0, visible: false }]), lower);
  assert.equal(getTopUvPreviewLayer([lower], [{ order: 0 }], 'active-preview'), lower);
  assert.equal(getTopUvPreviewLayer([{ ...manual, imageUrl: '/saved.png' }], []), undefined);
  const legacy = { ...manual, imageUrl: '/saved.png', role: 'local-repaint-overlay' };
  assert.equal(getTopUvPreviewLayer([legacy], []), legacy);
  const { compileForRenderTarget } = await server.ssrLoadModule(
    '/src/engine/projection/compileForRenderTarget.ts',
  );
  const originalTarget = { name: 'visible-cube-face' };
  const offscreenTarget = { name: 'uv-warmup' };
  let boundTarget = originalTarget;
  let boundFace = 3;
  let boundMip = 2;
  let finishCompile;
  const rendererFixture = {
    getRenderTarget: () => boundTarget,
    getActiveCubeFace: () => boundFace,
    getActiveMipmapLevel: () => boundMip,
    setRenderTarget(target, face = 0, mip = 0) {
      boundTarget = target;
      boundFace = face;
      boundMip = mip;
    },
    compileAsync() {
      assert.equal(boundTarget, offscreenTarget, 'Select the offscreen shader variant.');
      return new Promise((resolve) => {
        finishCompile = resolve;
      });
    },
  };
  const compilation = compileForRenderTarget(rendererFixture, new THREE.Scene(), {}, offscreenTarget);
  assert.deepEqual(
    [boundTarget, boundFace, boundMip],
    [originalTarget, 3, 2],
    'Restore the exact visible framebuffer before asynchronous compilation settles.',
  );
  finishCompile();
  await compilation;
  rendererFixture.compileAsync = () => {
    throw new Error('compile failed');
  };
  assert.throws(
    () => compileForRenderTarget(rendererFixture, new THREE.Scene(), {}, offscreenTarget),
    /compile failed/,
  );
  assert.deepEqual(
    [boundTarget, boundFace, boundMip],
    [originalTarget, 3, 2],
    'A synchronous driver failure must also restore the framebuffer.',
  );
  rendererFixture.compileAsync = () => Promise.reject(new Error('link failed'));
  await assert.rejects(
    compileForRenderTarget(rendererFixture, new THREE.Scene(), {}, offscreenTarget),
    /link failed/,
  );
  assert.deepEqual(
    [boundTarget, boundFace, boundMip],
    [originalTarget, 3, 2],
    'An asynchronous link failure must propagate without leaking renderer state.',
  );
  const maskedProjection = await server.ssrLoadModule(
    '/src/engine/projection/createMaskedProjectedImage.ts',
  );
  const repaintPreviewUtils = await server.ssrLoadModule(
    '/src/engine/localRepaint/resultPreviewUtils.ts',
  );
  assert.equal(
    repaintPreviewUtils.LOCAL_REPAINT_RESULT_PREVIEW_CUTOUT_ENABLED,
    false,
    'The legacy colour-key cutout must stay disabled; generated display transparency uses depth.',
  );
  const geometrySourcePixels = new Uint8ClampedArray(4 * 3 * 4);
  const geometryDepthPixels = new Uint8ClampedArray(4 * 3 * 4);
  for (let index = 0; index < 4 * 3; index += 1) {
    const offset = index * 4;
    geometrySourcePixels[offset] = index === 5 ? 2 : 174;
    geometrySourcePixels[offset + 1] = index === 5 ? 3 : 166;
    geometrySourcePixels[offset + 2] = index === 5 ? 5 : 158;
    geometrySourcePixels[offset + 3] = 255;
    geometryDepthPixels[offset] = 255;
    geometryDepthPixels[offset + 1] = 255;
    geometryDepthPixels[offset + 2] = 255;
    geometryDepthPixels[offset + 3] = 255;
  }
  for (const index of [5, 6]) {
    const offset = index * 4;
    geometryDepthPixels[offset] = 32;
    geometryDepthPixels[offset + 1] = 64;
    geometryDepthPixels[offset + 2] = 96;
  }
  const geometryDisplay = repaintPreviewUtils.applyPackedDepthDisplayMask(
    new ImageData(geometrySourcePixels, 4, 3),
    new ImageData(geometryDepthPixels, 4, 3),
  ).imageData;
  assert.equal(
    geometryDisplay.data[3],
    0,
    'Pixels outside renderer-authored geometry must become transparent in the UI copy.',
  );
  assert.equal(
    geometryDisplay.data[5 * 4 + 3],
    255,
    'Every geometry-covered pixel must remain present, including the vulnerable edge.',
  );
  assert.equal(
    geometryDisplay.data[5 * 4],
    2,
    'Black generated material inside geometry must remain untouched.',
  );
  const alphaSource = new ImageData(new Uint8ClampedArray([20, 30, 40, 128, 50, 60, 70, 64]), 2, 1);
  const authoredMask = new ImageData(
    new Uint8ClampedArray([255, 255, 255, 128, 128, 128, 128, 255]),
    2,
    1,
  );
  const sourceAlphaMasked = maskedProjection.applyProjectedAlphaMask(alphaSource, authoredMask);
  assert.equal(sourceAlphaMasked.data[3], 64);
  assert.equal(sourceAlphaMasked.data[7], 32);
  const repaintMaskOnly = maskedProjection.applyProjectedAlphaMask(alphaSource, authoredMask, {
    ignoreSourceAlpha: true,
  });
  assert.equal(
    repaintMaskOnly.data[3],
    128,
    'A local repaint mask must not multiply a previously damaged generated-image alpha.',
  );
  assert.equal(
    repaintMaskOnly.data[7],
    128,
    'Local repaint coverage must be authored by the geometry/brush mask exactly once.',
  );
  assert.deepEqual(
    Array.from(repaintMaskOnly.data.slice(0, 3)),
    [20, 30, 40],
    'Mask-only repaint must preserve returned RGB instead of creating a dark fringe.',
  );
  const packedDepthPixels = new Uint8ClampedArray([
    255, 255, 255, 255, 8, 9, 12, 255, 253, 255, 255, 255,
  ]);
  const packedDepthVisibility = repaintPreviewUtils.createPackedDepthVisibilityMask(
    new ImageData(packedDepthPixels, 3, 1),
  );
  assert.equal(
    packedDepthVisibility.data[3],
    0,
    'The white depth clear value must stay outside local repaint projection coverage.',
  );
  assert.equal(
    packedDepthVisibility.data[7],
    255,
    'A dark recessed surface must remain paintable when geometry depth is present.',
  );
  assert.equal(
    packedDepthVisibility.data[11],
    255,
    'A packed depth value near the far plane must still count as visible geometry.',
  );
  const sourcePixels = new Uint8ClampedArray(6 * 4 * 4);
  for (let index = 0; index < 6 * 4; index += 1) {
    const offset = index * 4;
    sourcePixels[offset] = 8;
    sourcePixels[offset + 1] = 9;
    sourcePixels[offset + 2] = 12;
    sourcePixels[offset + 3] = 255;
  }
  for (const index of [8, 9, 14, 15]) {
    const offset = index * 4;
    sourcePixels[offset] = 224;
    sourcePixels[offset + 1] = 145;
    sourcePixels[offset + 2] = 22;
  }
  const transparentRepaint = repaintPreviewUtils.removeEdgeConnectedNeutralBackground(
    new ImageData(sourcePixels, 6, 4),
    'dark-only',
  ).imageData;
  assert.equal(
    transparentRepaint.data[3],
    0,
    'The edge-connected black generation backdrop must become transparent.',
  );
  assert.equal(
    transparentRepaint.data[8 * 4 + 3],
    255,
    'Authored yellow/orange repaint pixels must remain fully visible.',
  );
  const repaintActivation = await server.ssrLoadModule(
    '/src/engine/viewport/localRepaintPreviewActivation.ts',
  );
  const repaintOverlaySync = await server.ssrLoadModule(
    '/src/engine/viewport/localRepaintGpuOverlaySync.ts',
  );
  const renderedLayerColor = await server.ssrLoadModule(
    '/src/engine/viewport/renderedLayerColor.ts',
  );
  const bakeOverlayComposition = await server.ssrLoadModule(
    '/src/engine/bake/projectedOverlayComposition.ts',
  );
  const projectedPreviewAuthority = await server.ssrLoadModule(
    '/src/engine/viewport/projectedPreviewLayerAuthority.ts',
  );
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const camera = {
    type: 'perspective',
    projection: 'perspective',
    position: [0, 0, 3],
    quaternion: [0, 0, 0, 1],
    target: [0, 0, 0],
    near: 0.1,
    far: 100,
    fov: 45,
    zoom: 1,
    projectionMatrix: identity,
    matrixWorld: identity,
    viewMatrix: identity,
    aspect: 1,
  };
  const layerStore = await server.ssrLoadModule('/src/stores/layerStore.ts');
  const hybridLayers = Array.from({ length: 9 }, (_, index) => ({
    layerId: `hybrid-${index}`, camera, objectId: 'hybrid', visible: true, opacity: 1,
    imageUrl: index === 8 ? 'liclick-live-projected-canvas:color' : `memory://color-${index}`,
    maskUrl: index === 8 ? 'liclick-live-projected-canvas:mask' : `memory://mask-${index}`,
    depthUrl: `memory://depth-${index}`, useMask: true, useDepthCheck: true,
  }));
  const warmHybrid = (layers, maxTextureImageUnits = 16) =>
    projection.createProjectedLayerStackProgramWarmupMaterial({ layers, objectId: 'hybrid' },
      { isWebGL2: true, preferTextureArrays: true, maxTextureImageUnits });
  const hybrid = warmHybrid(hybridLayers);
  assert.ok(hybrid);
  assert.match(hybrid.fragmentShader, /COMPACT_LAYER_CAPACITY = 9/,
    'One live repaint must not expand nine layers of depth visibility math.');
  assert.doesNotMatch(
    hybrid.fragmentShader,
    /texture2D\(maskMap8,uv\)/,
    'A live durable eraser mask must use its reserved array slice, not add a direct sampler.',
  );
  assert.match(hybrid.fragmentShader, /compactMaskArraySlices\[i\]/);
  assert.match(hybrid.fragmentShader, /compactDepthArraySlices\[i\]/);
  assert.equal((hybrid.fragmentShader.match(/float computeCompactVisibility\(/g) ?? []).length, 1);
  const simpleHybrid = warmHybrid(hybridLayers.map((layer) => ({ ...layer, useDepthCheck: false })));
  assert.doesNotMatch(simpleHybrid.fragmentShader, /COMPACT_LAYER_CAPACITY/,
    'Simple live color/mask stacks retain the less expensive direct program.');
  const liveDepth = warmHybrid(hybridLayers.map((layer, index) => ({ ...layer,
    depthUrl: index === 8 ? 'liclick-live-projected-canvas:depth' : layer.depthUrl,
    normalUrl: index === 8 ? 'liclick-live-projected-canvas:normal' : 'memory://normal', useNormalCheck: true,
  })));
  assert.match(liveDepth.fragmentShader, /texture2D\(depthMap8,uv\)/);
  assert.match(liveDepth.fragmentShader, /texture2D\(normalMap8,uv\)/);
  assert.equal(warmHybrid(hybridLayers, 2), undefined,
    'Compact loops must still obey the device sampler budget.');
  hybrid.dispose(); simpleHybrid.dispose(); liveDepth.dispose();
  const sceneStore = await server.ssrLoadModule('/src/stores/sceneStore.ts');
  sceneStore.useSceneStore.getState().setPaintTool('none');
  const maskActivationBaseline = sceneStore.useSceneStore.getState().paintToolActivationRevision;
  sceneStore.useSceneStore.getState().setPaintTool('inpaint-add');
  assert.equal(
    sceneStore.useSceneStore.getState().paintToolActivationRevision,
    maskActivationBaseline + 1,
    'Entering the mask tool must arm one viewport session.',
  );
  sceneStore.useSceneStore.getState().setPaintTool('inpaint-add');
  assert.equal(
    sceneStore.useSceneStore.getState().paintToolActivationRevision,
    maskActivationBaseline + 2,
    'Repeated activation of the highlighted mask tool must publish a recovery command.',
  );
  sceneStore.useSceneStore.getState().setPaintTool('none');
  assert.equal(
    sceneStore.useSceneStore.getState().paintToolActivationRevision,
    maskActivationBaseline + 2,
    'Leaving paint mode must not create a false mask recovery command.',
  );
  const visibilityLayers = [
    { id: 'visibility-a', type: 'projected', visible: true, order: 0 },
    { id: 'visibility-b', type: 'projected', visible: true, order: 1 },
  ];
  layerStore.useLayerStore.setState({
    layers: visibilityLayers,
    activeProjectedLayerId: 'visibility-a',
  });
  sceneStore.useSceneStore.getState().setPaintTool('eraser');
  layerStore.useLayerStore.getState().setLayerVisibility(['visibility-a'], false);
  assert.equal(
    layerStore.useLayerStore.getState().activeProjectedLayerId,
    'visibility-b',
    'Hiding the active layer must synchronously select the next visible row.',
  );
  assert.equal(
    sceneStore.useSceneStore.getState().paintTool,
    'none',
    'Hiding the active layer must synchronously detach the eraser.',
  );
  layerStore.useLayerStore.getState().toggleLayer('visibility-b');
  layerStore.useLayerStore.getState().toggleLayer('visibility-b');
  assert.equal(
    layerStore.useLayerStore.getState().layers.find((layer) => layer.id === 'visibility-b')
      ?.visible,
    true,
    'Two immediate toggles must round-trip visibility without reading a stale frame.',
  );
  const linkedVisibilityLayers = [
    {
      id: 'local-repaint-projection-visible-row',
      type: 'projected',
      role: 'local-repaint-overlay',
      replacementTargetLayerId: 'local-repaint-uv-merge-target',
      visible: true,
      order: 0,
    },
    {
      id: 'local-repaint-uv-merge-target',
      type: 'uv',
      visible: true,
      order: 1,
    },
  ];
  layerStore.useLayerStore.setState({
    layers: linkedVisibilityLayers,
    activeProjectedLayerId: 'local-repaint-projection-visible-row',
  });
  sceneStore.useSceneStore.getState().setPaintTool('eraser');
  layerStore.useLayerStore.getState().toggleLayer('local-repaint-projection-visible-row');
  assert.deepEqual(
    layerStore.useLayerStore.getState().layers.map((layer) => layer.visible),
    [false, false],
    'Keyboard/store visibility must hide both representations of one local repaint result.',
  );
  assert.equal(sceneStore.useSceneStore.getState().paintTool, 'none');
  layerStore.useLayerStore.getState().toggleLayer('local-repaint-projection-visible-row');
  assert.deepEqual(
    layerStore.useLayerStore.getState().layers.map((layer) => layer.visible),
    [true, true],
    'Linked local repaint visibility must round-trip atomically.',
  );
  const stableVisibilityLayers = layerStore.useLayerStore.getState().layers;
  layerStore.useLayerStore
    .getState()
    .setLayerVisibility(['local-repaint-projection-visible-row'], true);
  assert.equal(
    layerStore.useLayerStore.getState().layers,
    stableVisibilityLayers,
    'A repeated visibility set must preserve the layers array and avoid recomposition.',
  );
  layerStore.useLayerStore.setState({ layers: [], activeProjectedLayerId: undefined });
  const generatedSourceAlphaLayer = layerStore.useLayerStore
    .getState()
    .addProjectedLayerFromGeneration(
      {
        id: 'generation-source-alpha',
        prompt: '',
        resultUrl: 'memory://complete-generated-rgba',
        captureId: 'capture-source-alpha',
        metadata: {},
      },
      {
        id: 'capture-source-alpha',
        colorUrl: 'memory://capture-color',
        maskUrl: 'memory://capture-silhouette',
        depthUrl: 'memory://capture-depth',
        depthEncoding: 'linear-view',
        camera,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      'object-source-alpha',
    );
  assert.equal(
    generatedSourceAlphaLayer.imageUrl,
    'memory://complete-generated-rgba',
    'An ordinary generated layer must keep the complete returned image.',
  );
  assert.equal(
    generatedSourceAlphaLayer.maskUrl,
    undefined,
    'An ordinary generated layer must not retain the capture silhouette as a layer mask.',
  );
  assert.equal(
    generatedSourceAlphaLayer.depthUrl,
    'memory://capture-depth',
    'An ordinary generated layer must retain capture depth as its geometry occlusion authority.',
  );
  layerStore.useLayerStore.setState({ layers: [], activeProjectedLayerId: undefined });
  const layers = Array.from({ length: 6 }, (_, index) => {
    const imageUrl = `memory://projected-layer-${index}`;
    projection.primeProjectedImageTexture(imageUrl, { width: 2, height: 2 });
    return {
      layerId: `layer-${index}`,
      imageUrl,
      camera,
      opacity: 1,
      strength: 1,
      blendMode: index === 0 ? 'overlay' : 'normal',
      compositeRole: 'normal',
      visible: true,
      hue: 0,
      saturation: 0,
      lightness: 0,
      useMask: false,
      useDepthCheck: false,
      useNormalCheck: false,
      renderedColor: false,
    };
  });
  assert.equal(
    renderedLayerColor.usesUnlitRenderedColor({
      id: 'local-repaint-projection-legacy',
      renderedColor: true,
    }),
    false,
    'Projected local repaint is BaseColor and must receive PBR viewport lighting.',
  );
  assert.equal(
    renderedLayerColor.usesUnlitRenderedColor({
      id: 'local-repaint-uv-layer',
      role: 'local-repaint-overlay',
      renderedColor: false,
    }),
    false,
    'A UV-committed local repaint must retain the same BaseColor lighting semantics.',
  );
  assert.equal(
    renderedLayerColor.usesUnlitRenderedColor({
      id: 'ordinary-uv-layer',
      renderedColor: false,
    }),
    true,
    'Ordinary UV layers must bypass the PBR sweep.',
  );
  assert.equal(
    renderedLayerColor.usesUnlitRenderedColor({
      id: 'merged-uv-layer',
      role: 'merged-uv',
      renderedColor: false,
    }),
    false,
    'Only the final merged UV layer may receive PBR preview lighting.',
  );
  const localRepaintLayer = {
    id: 'local-repaint-projection-regression',
    type: 'projected',
    imageUrl: 'memory://local-repaint',
    blendMode: 'normal',
  };
  assert.equal(
    bakeOverlayComposition.getProjectedLayerOverlayMode(localRepaintLayer),
    'literal',
    'Persisted local repaint projections must bypass the order-independent Top-K blend.',
  );
  assert.equal(
    bakeOverlayComposition.getProjectedLayerOverlayMode({
      ...localRepaintLayer,
      id: 'ordinary-overlay',
      blendMode: 'overlay',
    }),
    'feathered',
    'Ordinary overlay layers must retain their quality feather.',
  );
  assert.equal(
    bakeOverlayComposition.getProjectedLayerOverlayMode({
      ...localRepaintLayer,
      id: 'ordinary-normal',
    }),
    undefined,
    'Ordinary normal projections must remain in the Top-K blend.',
  );
  assert.equal(
    bakeOverlayComposition.getProjectionOverlayAlpha(0.2, 0, 'literal'),
    0.2,
    'Local repaint source-over alpha must equal its rasterized coverage.',
  );
  const authoritativeRepaint = {
    id: 'local-repaint-projection-restored',
    name: 'Local repaint',
    type: 'projected',
    imageUrl: 'memory://restored-repaint',
    objectId: 'object-a',
    replacementTargetLayerId: 'local-repaint-target',
    visible: true,
    opacity: 1,
    strength: 1,
    blendMode: 'normal',
    adjustments: { hue: 0, saturation: 0, lightness: 0 },
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const frozenOrdinaryProjection = {
    ...authoritativeRepaint,
    id: 'ordinary-projection',
    imageUrl: 'memory://ordinary',
    replacementTargetLayerId: undefined,
    order: 1,
  };
  assert.deepEqual(
    projectedPreviewAuthority
      .mergeAuthoritativeLocalRepaintLayers(
        [authoritativeRepaint, frozenOrdinaryProjection],
        [frozenOrdinaryProjection],
        'object-a',
      )
      .map((layer) => layer.id),
    ['local-repaint-projection-restored', 'ordinary-projection'],
    'A frozen projected preview batch must not suppress a restored local repaint layer.',
  );
  const featheredAlpha = bakeOverlayComposition.getProjectionOverlayAlpha(0.2, 0, 'feathered');
  assert(
    featheredAlpha >= 0.15 && featheredAlpha < 0.2,
    'Ordinary overlay alpha must retain the historical 0.75-1 quality feather.',
  );
  const residentUvTexture = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    THREE.RGBAFormat,
  );
  residentUvTexture.needsUpdate = true;
  const residentContentAwareTexture = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    THREE.RGBAFormat,
  );
  residentContentAwareTexture.needsUpdate = true;
  const material = await projection.createProjectedLayerStackMaterial(
    {
      layers,
      objectId: 'regression-object',
      currentObjectMatrixWorld: identity,
      depthTest: true,
      uvOverlayTexture: residentUvTexture,
      uvOverlayOpacity: 1,
      uvOverlayBelowProjected: true,
      baseTexture: residentContentAwareTexture,
      baseTextureOpacity: 1,
    },
    { maxTextureImageUnits: 64 },
  );
  assert(material, 'Expected the six-layer projected material to be created.');
  const state = material.userData.liclickProjectedLayerStackState;
  assert.equal(state.bindings.length, 6);
  // Multi-layer ordered subsets must reuse the original sampler slots.
  // Empty/single inputs preserve the white/single-shader factory semantics.
  const subsetInput = {
    layers, baseTexture: residentContentAwareTexture, uvOverlayTexture: residentUvTexture,
    uvOverlayOpacity: 1, uvOverlayBelowProjected: true, baseTextureOpacity: 1,
  };
  const originalShader = material.fragmentShader;
  const originalVersion = material.version;
  const originalLayers = JSON.stringify(layers);
  const uniformSnapshot = () => JSON.stringify(Object.fromEntries(
    Object.entries(material.uniforms).map(([name, uniform]) => [
      name, uniform.value instanceof THREE.Texture ? uniform.value.uuid : uniform.value,
    ]),
  ));
  for (let cycle = 0; cycle < 10; cycle++) {
    for (let mask = 1; mask < 64; mask++) {
      const subset = layers.filter((_, index) => mask & (1 << index));
      if (subset.length === 1) continue;
      const eraserLayer = subset.at(-1);
      assert.equal(projection.updateProjectedLayerStackMaterial(material, {
        ...subsetInput, layers: subset, liveEraserLayerId: eraserLayer.layerId,
        liveEraserMaskTexture: residentContentAwareTexture,
      }), true);
      state.bindings.forEach((binding, index) => {
        assert.equal(material.uniforms[binding.opacityUniform].value, mask & (1 << index) ? 1 : 0);
      });
      assert.equal(material.uniforms.liveEraserLayerIndex.value, layers.indexOf(eraserLayer));
      assert.equal(material.uniforms.useLiveEraserMask.value, 1);
    }
  }
  assert.equal(material.fragmentShader, originalShader);
  assert.equal(material.version, originalVersion, 'Visibility reuse must never request recompilation.');
  assert.equal(JSON.stringify(layers), originalLayers, 'Authored layers must remain unchanged.');
  assert.equal(projection.updateProjectedLayerStackMaterial(material, {
    ...subsetInput, layers: [layers[3], layers[4]], liveEraserLayerId: layers[0].layerId,
    liveEraserMaskTexture: residentContentAwareTexture,
  }), true);
  assert.equal(material.uniforms.liveEraserLayerIndex.value, -1);
  assert.equal(material.uniforms.useLiveEraserMask.value, 0);
  const rejectedSubsets = [
    [], [layers[2]], [layers[4], layers[1]], [layers[1], layers[1]],
    [{ ...layers[2], layerId: 'unknown' }],
    ...[
      { imageUrl: 'memory://changed' }, { maskUrl: 'memory://mask', useMask: true },
      { depthUrl: 'memory://depth', useDepthCheck: true }, { normalUrl: 'memory://normal', useNormalCheck: true },
      { renderedColor: true }, { compositeRole: 'underlay' }, { ignoreSourceAlpha: true },
      { camera: { ...camera, position: [11, 12, 13] } }, { objectMatrixWorld: Array(16).fill(2) },
    ].map((patch) => [layers[0], { ...layers[2], ...patch }]),
  ];
  for (const rejected of rejectedSubsets) {
    const before = uniformSnapshot();
    assert.equal(projection.updateProjectedLayerStackMaterial(material, { ...subsetInput, layers: rejected }), false);
    assert.equal(uniformSnapshot(), before, 'Rejected structure must not partially change live uniforms.');
  }
  for (const feature of ['baseRenderedColorMaskTexture', 'uvOverlayRenderedColorMaskTexture', 'topUvOverlayTexture']) {
    const before = uniformSnapshot();
    assert.equal(projection.updateProjectedLayerStackMaterial(material, {
      ...subsetInput, layers: [layers[0], layers[2]], [feature]: residentUvTexture,
    }), false);
    assert.equal(uniformSnapshot(), before);
  }
  assert.equal(projection.updateProjectedLayerStackMaterial(material, subsetInput), true);
  console.log('Resident subset reuse passed: 570 transitions, eraser slot ownership, single/structural rejection and unchanged inputs/shader.');
  const { RetainedProjectedMaterials } = await server.ssrLoadModule(
    '/src/engine/projection/retainedProjectedMaterials.ts',
  );
  const retained = new RetainedProjectedMaterials();
  const singleInput = { ...subsetInput, layers: [layers[0]] };
  const singleMaterial = await projection.createProjectedLayerStackMaterial(singleInput);
  assert(singleMaterial);
  // Full -> single -> canonical white -> single -> ordered multi subsets.
  // Keeping the distinct single shader must not evict the uploaded full stack.
  retained.retain(material);
  retained.retain(singleMaterial);
  for (let cycle = 0; cycle < 10; cycle++) {
    assert.equal(retained.take(singleInput), singleMaterial);
    assert.equal(retained.take(singleInput), undefined, 'Attached materials leave cache ownership.');
    retained.retain(singleMaterial);
    for (let count = 2; count <= layers.length; count++) {
      assert.equal(retained.take({ ...subsetInput, layers: layers.slice(0, count) }), material);
      retained.retain(material);
    }
  }
  assert.equal(material.version, originalVersion);
  assert.equal(retained.take(subsetInput), material);
  const replacementSingle = await projection.createProjectedLayerStackMaterial(singleInput);
  retained.retain(replacementSingle);
  assert.equal(retained.take(singleInput), replacementSingle, 'Only the latest detached single is retained.');
  retained.retain(replacementSingle);
  assert.equal(retained.take({
    ...singleInput, layers: [{ ...layers[0], imageUrl: 'memory://changed-source' }],
  }), undefined, 'Source changes must rebuild rather than reveal stale pixels.');
  assert.equal(retained.take(singleInput), undefined, 'Incompatible revisions are evicted.');
  const disposableSingle = await projection.createProjectedLayerStackMaterial(singleInput);
  retained.retain(disposableSingle);
  retained.dispose();
  assert.equal(retained.take(singleInput), undefined, 'Model teardown empties retained resources.');
  retained.dispose();
  console.log('Retained visibility lifecycle passed: 60 single/multi restores, exclusive ownership, replacement, invalidation and teardown.');
  assert.equal(material.uniforms.uvOverlayBelowProjected.value, 1);
  assert.deepEqual(
    state.bindings.map((binding) => binding.layerId),
    layers.map((layer) => layer.layerId),
  );
  assert.match(
    material.fragmentShader,
    /float coverageConfidence = 1\.0 -/,
    'Projected transitions must preserve a continuous coverage confidence.',
  );
  assert.match(
    material.fragmentShader,
    /coverage > 0\.0001/,
    'Low-coverage candidates must fade continuously instead of appearing at a 2% hard edge.',
  );
  assert.match(
    material.fragmentShader,
    /float computeOrderedOverlayAlpha\(float coverage, float quality\)[\s\S]*?return clamp\(coverage \* mix\(0\.75, 1\.0, qualityFade\), 0\.0, 1\.0\)/,
    'Explicit live overlays must share one feathered ordered-alpha function.',
  );
  assert.match(
    material.fragmentShader,
    /float overlayAlpha = computeOrderedOverlayAlpha\(\s*coverage,\s*quality\s*\)/,
    'Projected overlay composition must route through the shared ordered-alpha function.',
  );
  assert.match(
    material.fragmentShader,
    /vec3 consistencyBase =/,
    'Live projections must apply the UV compositor colour-consistency pass.',
  );
  assert.match(
    material.fragmentShader,
    /float adjustedQuality0 = topQuality0/,
    'Colour-inconsistent side projections must be downweighted before live blending.',
  );
  assert.doesNotMatch(
    material.fragmentShader,
    /overlayFacingGate|overlayCoverageGate/,
    'Live overlays must not crop already validated frontal coverage a second time.',
  );
  const liveRepaintOverlay = await projection.createProjectedLayerMaterial({
    ...layers[0],
    layerId: 'local-repaint-live-overlay',
    transparentProjectionOnly: true,
    renderedColor: false,
    useMask: false,
    depthTest: true,
  });
  assert.equal(liveRepaintOverlay.transparent, true);
  assert.equal(liveRepaintOverlay.depthWrite, false);
  assert.equal(liveRepaintOverlay.depthFunc, THREE.LessEqualDepth);
  assert.equal(liveRepaintOverlay.polygonOffsetFactor, 0);
  assert.equal(liveRepaintOverlay.polygonOffsetUnits, 0);
  assert.equal(liveRepaintOverlay.uniforms.transparentProjectionOnly.value, 1);
  assert.equal(
    repaintOverlaySync.syncLocalRepaintGpuOverlayLighting(
      { material: liveRepaintOverlay },
      {
        enabled: true,
        exposure: 1.12,
        ambientIntensity: 0.5,
        keyLightIntensity: 1.22,
        keyLightDirection: [0.35, 0.7, 0.45],
      },
    ),
    true,
  );
  liveRepaintOverlay.uniformsNeedUpdate = false;
  assert.equal(
    repaintOverlaySync.syncLocalRepaintGpuOverlayLighting(
      { material: liveRepaintOverlay },
      {
        enabled: false,
        exposure: 1.12,
        ambientIntensity: 0.5,
        keyLightIntensity: 1.22,
        keyLightDirection: [0.35, 0.7, 0.45],
      },
    ),
    true,
    'PBR -> Flat must synchronously disable lighting on the resident repaint overlay.',
  );
  assert.equal(liveRepaintOverlay.uniforms.previewLightingEnabled.value, 0);
  assert.equal(
    liveRepaintOverlay.uniformsNeedUpdate,
    true,
    'The display-mode switch must force the updated uniforms into the next GPU frame.',
  );
  assert.match(
    liveRepaintOverlay.fragmentShader,
    /literalReplacementAlpha/,
    'The live repaint overlay must keep rejected pixels transparent instead of replacing the model material.',
  );
  assert.match(
    liveRepaintOverlay.fragmentShader,
    /float lockedSafetyCoverage = mix\([\s\S]*useDepthCheck/,
    'The live repaint shader must use depth as the authoritative surface guard.',
  );
  assert.match(
    liveRepaintOverlay.fragmentShader,
    /gl_FragDepthEXT = projectedRasterDepth\(gl_FragCoord.z, projectedDepthPriority\)/,
    'Live repaint must share the resident surface depth instead of pushing inner faces through the shell.',
  );
  assert.equal(liveRepaintOverlay.polygonOffset, false);
  const rasterDepth = await server.ssrLoadModule('/src/engine/projection/projectionRasterDepth.ts');
  for (const material of [liveRepaintOverlay, hybrid, simpleHybrid, liveDepth]) {
    assert.ok(material.fragmentShader.includes(rasterDepth.PROJECTED_RASTER_DEPTH_GLSL));
    assert.doesNotMatch(material.fragmentShader, /-0\.000080|-0\.000006/);
  }
  assert.match(rasterDepth.PROJECTED_RASTER_DEPTH_GLSL, /geometricDepth \+ \(1\.0 - accepted\) \* 0\.000006/,
    'Accepted pixels keep geometric depth; only the existing empty diagnostic retreat remains.');
  projection.syncProjectedLayerMaterialDisplayState(liveRepaintOverlay, []);
  assert.equal(
    liveRepaintOverlay.uniforms.layerOpacity.value,
    1,
    'Persisted layer visibility reconciliation must not hide renderer-owned repaint feedback.',
  );
  projection.disposeGeneratedMaterialTree(liveRepaintOverlay);

  const staleSourceTexture = new THREE.Texture();
  const currentSourceTexture = new THREE.Texture();
  const staleMaskTexture = new THREE.Texture();
  const currentMaskTexture = new THREE.Texture();
  const staleParent = new THREE.Group();
  const currentModelGroup = new THREE.Group();
  const overlayRoot = new THREE.Group();
  const overlayMesh = new THREE.Mesh(new THREE.BufferGeometry());
  const detachedMesh = new THREE.Mesh(new THREE.BufferGeometry());
  overlayRoot.add(overlayMesh);
  staleParent.add(overlayRoot);
  staleParent.add(detachedMesh);
  const overlayMaterial = new THREE.ShaderMaterial({
    uniforms: {
      projectedMap: { value: staleSourceTexture },
      maskMap: { value: staleMaskTexture },
      layerOpacity: { value: 0 },
      layerStrength: { value: 1 },
      hueShift: { value: 0 },
      saturationShift: { value: 0 },
      lightnessShift: { value: 0 },
    },
  });
  overlayRoot.visible = false;
  overlayMesh.visible = false;
  detachedMesh.visible = false;
  assert.equal(repaintOverlaySync.isLocalRepaintOverlayVisible('pbr', true), true);
  assert.equal(repaintOverlaySync.isLocalRepaintOverlayVisible('flat', true), true);
  assert.equal(repaintOverlaySync.isLocalRepaintOverlayVisible('normal', true), false);
  assert.equal(repaintOverlaySync.isLocalRepaintOverlayVisible('wire', true), false);
  assert.equal(
    repaintOverlaySync.isLocalRepaintOverlayVisible('pbr', false),
    false,
    'A hidden repaint layer must remain hidden in a colour display mode.',
  );
  assert.equal(
    repaintOverlaySync.syncLocalRepaintGpuOverlayBinding(
      { material: overlayMaterial, root: overlayRoot, meshes: [overlayMesh, detachedMesh] },
      {
        modelGroup: currentModelGroup,
        sourceTexture: currentSourceTexture,
        maskTexture: currentMaskTexture,
        visible: true,
        opacity: 0.63,
        strength: 1.75,
        hue: 0.12,
        saturation: -0.28,
        lightness: 0.34,
      },
    ),
    true,
    'A stale repaint overlay must repair its model attachment and live texture bindings.',
  );
  assert.equal(overlayRoot.parent, currentModelGroup);
  assert.equal(overlayMesh.parent, overlayRoot);
  assert.equal(detachedMesh.parent, overlayRoot);
  assert.equal(overlayMaterial.uniforms.projectedMap.value, currentSourceTexture);
  assert.equal(overlayMaterial.uniforms.maskMap.value, currentMaskTexture);
  assert.equal(overlayMaterial.uniforms.layerOpacity.value, 0.63);
  assert.equal(overlayMaterial.uniforms.layerStrength.value, 1.75);
  assert.equal(overlayMaterial.uniforms.hueShift.value, 0.12);
  assert.equal(overlayMaterial.uniforms.saturationShift.value, -0.28);
  assert.equal(overlayMaterial.uniforms.lightnessShift.value, 0.34);
  assert.equal(overlayRoot.visible, true);
  assert.equal(overlayMesh.visible, true);
  assert.equal(detachedMesh.visible, true);
  assert.equal(
    repaintOverlaySync.syncLocalRepaintGpuOverlayBinding(
      { material: overlayMaterial, root: overlayRoot, meshes: [overlayMesh, detachedMesh] },
      {
        modelGroup: currentModelGroup,
        sourceTexture: currentSourceTexture,
        maskTexture: currentMaskTexture,
        visible: true,
        opacity: 0.63,
        strength: 1.75,
        hue: 0.12,
        saturation: -0.28,
        lightness: 0.34,
      },
    ),
    false,
    'A healthy repaint overlay must stay on the zero-work hot path.',
  );
  const replacementTextures = [];
  for (let replacementIndex = 0; replacementIndex < 50; replacementIndex += 1) {
    const replacementSourceTexture = new THREE.Texture();
    const replacementMaskTexture = new THREE.Texture();
    replacementTextures.push(replacementSourceTexture, replacementMaskTexture);
    assert.equal(
      repaintOverlaySync.syncLocalRepaintGpuOverlayBinding(
        { material: overlayMaterial, root: overlayRoot, meshes: [overlayMesh, detachedMesh] },
        {
          modelGroup: currentModelGroup,
          sourceTexture: replacementSourceTexture,
          maskTexture: replacementMaskTexture,
          visible: true,
          opacity: 0.63,
          strength: 1.75,
          hue: 0.12,
          saturation: -0.28,
          lightness: 0.34,
        },
      ),
      true,
      `Live repaint texture replacement ${replacementIndex + 1} must repair the overlay binding.`,
    );
    assert.equal(overlayMaterial.uniforms.projectedMap.value, replacementSourceTexture);
    assert.equal(overlayMaterial.uniforms.maskMap.value, replacementMaskTexture);
  }
  overlayMaterial.dispose();
  overlayMesh.geometry.dispose();
  detachedMesh.geometry.dispose();
  staleSourceTexture.dispose();
  currentSourceTexture.dispose();
  staleMaskTexture.dispose();
  currentMaskTexture.dispose();
  replacementTextures.forEach((texture) => texture.dispose());

  const materialId = material.uuid;
  const withThirdLayerHidden = layers.map((layer, index) => ({
    ...layer,
    visible: index !== 2,
  }));
  assert.equal(
    projection.syncProjectedLayerMaterialDisplayState(material, withThirdLayerHidden),
    true,
  );
  assert.equal(material.uniforms.layerOpacity2.value, 0);
  assert.equal(material.uniforms.layerOpacity1.value, 1);
  assert.equal(material.uuid, materialId, 'Visibility must not replace the GPU material.');

  projection.syncProjectedLayerMaterialDisplayState(
    material,
    layers.map((layer) => ({ ...layer, visible: false })),
  );
  assert.equal(material.uniforms.showEmptyProjectionHatch.value, 0);

  projection.syncProjectedLayerMaterialDisplayState(material, layers);
  assert.equal(material.uniforms.layerOpacity2.value, 1);
  assert.equal(material.uniforms.showEmptyProjectionHatch.value, 1, 'visible projections show the viewport-only empty hatch');
  assert.equal(material.uuid, materialId);

  assert.equal(
    projection.updateProjectedLayerStackMaterial(material, {
      layers,
      objectId: 'regression-object',
      currentObjectMatrixWorld: identity,
      depthTest: true,
      uvOverlayTexture: residentUvTexture,
      uvOverlayOpacity: 0,
      uvOverlayBelowProjected: false,
      baseTexture: residentContentAwareTexture,
      baseTextureOpacity: 0,
    }),
    true,
    'Closing a resident UV eye must update uniforms without rebuilding the shader.',
  );
  assert.equal(material.uniforms.uvOverlayOpacity.value, 0);
  assert.equal(material.uniforms.uvOverlayBelowProjected.value, 0);
  assert.equal(material.uniforms.useUvOverlayMap.value, 1);
  assert.equal(material.uniforms.baseTextureOpacity.value, 0);
  assert.equal(material.uniforms.useBaseMap.value, 1);
  assert.match(
    material.fragmentShader,
    /baseTexel\.a \* baseTextureOpacity/,
    'Content-aware visibility must be applied in the shader without releasing its sampler.',
  );
  assert.match(
    material.fragmentShader,
    /shadedBase = mix\([\s\S]*uvOverlayAlpha \* uvOverlayBelowProjected[\s\S]*vec3 mixedColor/,
    'Merged UV must be available as the base underneath higher projected repaint layers.',
  );
  assert.equal(material.uuid, materialId, 'UV visibility must not replace the GPU material.');
  projection.disposeGeneratedMaterialTree(material);
  assert.equal(
    material.userData.liclickProjectedProgramResidentAnchor,
    true,
    'Retired projected shaders must remain as texture-free program anchors.',
  );
  projection.disposeGeneratedMaterialTree(material);
  assert.notEqual(
    material.userData.liclickDisposedMaterial,
    true,
    'Repeated mesh disposal must not evict a resident shader anchor.',
  );
  residentUvTexture.dispose();
  residentContentAwareTexture.dispose();

  const hiddenLayers = layers.map((layer) => ({ ...layer, visible: false }));
  const whiteMembraneMaterial = await projection.createProjectedLayerStackMaterial(
    {
      layers: hiddenLayers,
      objectId: 'white-membrane-object',
      currentObjectMatrixWorld: identity,
      depthTest: true,
      previewLighting: {
        enabled: true,
        exposure: 1,
        ambientIntensity: 0.5,
        keyLightIntensity: 1.22,
        keyLightDirection: [0.35, 0.8, 0.48],
      },
    },
    { maxTextureImageUnits: 64 },
  );
  assert(whiteMembraneMaterial, 'Expected the hidden-layer white membrane material.');
  assert.equal(
    whiteMembraneMaterial.uniforms.previewLightingEnabled.value,
    1,
    'The all-hidden fallback must retain form-defining preview lighting.',
  );
  assert.equal(
    whiteMembraneMaterial.uniforms.showEmptyProjectionHatch.value,
    0,
    'The white membrane must not show the empty-projection hatch.',
  );
  assert.match(
    whiteMembraneMaterial.fragmentShader,
    /baseSurfaceColor \* lighting/,
    'The white membrane base colour must receive form-defining light and shadow.',
  );
  projection.disposeGeneratedMaterialTree(whiteMembraneMaterial);

  const flatWhiteMembraneMaterial = projection.createDisplayModeMaterial('flat', false);
  assert.equal(flatWhiteMembraneMaterial.name, 'LiclickWhiteMembranePreview');
  assert(flatWhiteMembraneMaterial instanceof THREE.MeshStandardMaterial);
  assert.equal(flatWhiteMembraneMaterial.roughness, 0.78);
  assert.equal(flatWhiteMembraneMaterial.metalness, 0);
  assert.equal(flatWhiteMembraneMaterial.emissiveIntensity, 0);
  projection.disposeGeneratedMaterialTree(flatWhiteMembraneMaterial);

  const mergedUv = new THREE.DataTexture(new Uint8Array([160, 120, 80, 255]), 1, 1);
  const renderedColorMask = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const mergedUvMaterial = projection.createUvOverlayPreviewMaterial({
    displayMode: 'pbr',
    selected: false,
    uvOverlayTexture: mergedUv,
    uvOverlayRenderedColorMaskTexture: renderedColorMask,
  });
  assert.equal(mergedUvMaterial.uniforms.useUvOverlayRenderedColorMaskMap.value, 1);
  assert.equal(mergedUvMaterial.uniforms.uvOverlayRenderedColorMaskMap.value, renderedColorMask);
  const updatedUvLightDirection = [-0.8, 0.5, 0.25];
  const expectedUvLightDirection = new THREE.Vector3(...updatedUvLightDirection).normalize();
  assert.equal(
    projection.syncProjectedLayerMaterialDisplayState(mergedUvMaterial, [], false, false, {
      enabled: true,
      exposure: 1.1,
      ambientIntensity: 0.45,
      keyLightIntensity: 1.4,
      keyLightDirection: updatedUvLightDirection,
    }),
    true,
    'Merged UV preview lighting controls must update the resident UV material.',
  );
  assert(
    mergedUvMaterial.uniforms.keyLightDirection.value.equals(expectedUvLightDirection),
    'Changing PBR light azimuth must update the merged UV key-light direction.',
  );
  mergedUvMaterial.userData.liclickResidentUvProjectionLayers = ['atlas-layer'];
  assert.equal(
    projection.syncProjectedLayerMaterialDisplayState(mergedUvMaterial, [], false, false, {
      enabled: true,
      exposure: 0.8,
      ambientIntensity: 0.45,
      keyLightIntensity: 1.4,
      keyLightDirection: updatedUvLightDirection,
    }),
    false,
    'Updating atlas lighting cannot acknowledge a removed projection contribution.',
  );
  assert.equal(mergedUvMaterial.uniforms.previewExposure.value, 0.8);
  assert.match(sceneRootSource,
    /layer.visible \|\| previousLayerVisibilityById.get\(layer.layerId\)/,
    'Closing the last projected eye must still reconcile the old atlas');
  assert.match(sceneRootSource,
    /currentMergedUvBoundaryOrder !==\s*getVisibleMergedUvBoundaryOrder\(previousState.layers, importedModel.objectId\)/,
    'Changing the merged UV boundary must reconcile projected contributions');
  projection.disposeGeneratedMaterialTree(mergedUvMaterial);

  const wholeRenderedUvMaterial = projection.createUvOverlayPreviewMaterial({
    displayMode: 'flat',
    selected: false,
    uvOverlayTexture: mergedUv,
    uvOverlayRenderedColor: true,
  });
  assert.equal(
    wholeRenderedUvMaterial.uniforms.uvOverlayRenderedColor.value,
    1,
    'A UV with baked PBR lighting must bypass preview lighting without a full-size mask.',
  );
  assert.match(
    wholeRenderedUvMaterial.fragmentShader,
    /max\(\s*uvOverlayRenderedColor,/,
    'The whole-layer rendered-color flag must override the optional per-pixel mask.',
  );
  projection.disposeGeneratedMaterialTree(wholeRenderedUvMaterial);

  const missingNormalLayers = layers.map((layer, index) => ({
    ...layer,
    normalUrl: `memory://missing-normal-${index}`,
    useNormalCheck: true,
  }));
  const originalWarn = globalThis.console.warn;
  let materialWithMissingNormals;
  try {
    globalThis.console.warn = () => undefined;
    materialWithMissingNormals = await projection.createProjectedLayerStackMaterial(
      {
        layers: missingNormalLayers,
        objectId: 'normal-fallback-object',
        currentObjectMatrixWorld: identity,
        depthTest: true,
      },
      { maxTextureImageUnits: 64 },
    );
  } finally {
    globalThis.console.warn = originalWarn;
  }
  assert.equal(
    materialWithMissingNormals,
    undefined,
    'A layer requiring normal rejection must stay closed until its normal map is available.',
  );

  const repaintPreview = {
    id: 'local-repaint-preview',
    generationId: 'generation-1',
    replacementTargetLayerId: 'target-layer-1',
    maskUrl: 'memory://local-repaint-mask',
  };
  const mismatchedActivation = repaintActivation.resolveLocalRepaintPreviewActivation({
    consumedKey: '',
    paintTool: 'none',
    preview: repaintPreview,
    currentPreview: repaintPreview,
    currentSource: { generationId: 'generation-2', targetLayerId: 'target-layer-1' },
    processedLayerIds: [repaintPreview.id],
  });
  assert.equal(mismatchedActivation.shouldActivate, false);
  assert.equal(
    mismatchedActivation.nextConsumedKey,
    '',
    'A source mismatch must not consume the repaint activation key.',
  );

  const firstActivation = repaintActivation.resolveLocalRepaintPreviewActivation({
    consumedKey: mismatchedActivation.nextConsumedKey,
    paintTool: 'none',
    preview: repaintPreview,
    currentPreview: repaintPreview,
    currentSource: { generationId: 'generation-1', targetLayerId: 'target-layer-1' },
    processedLayerIds: [repaintPreview.id],
  });
  assert.equal(firstActivation.shouldActivate, true);
  const consumedActivation = repaintActivation.resolveLocalRepaintPreviewActivation({
    consumedKey: firstActivation.nextConsumedKey,
    paintTool: 'none',
    preview: repaintPreview,
    currentPreview: repaintPreview,
    currentSource: { generationId: 'generation-1', targetLayerId: 'target-layer-1' },
    processedLayerIds: [repaintPreview.id],
  });
  assert.equal(consumedActivation.shouldActivate, false);

  const clearedActivation = repaintActivation.resolveLocalRepaintPreviewActivation({
    consumedKey: firstActivation.nextConsumedKey,
    paintTool: 'none',
    processedLayerIds: [],
  });
  assert.equal(clearedActivation.nextConsumedKey, '');
  const reenteredActivation = repaintActivation.resolveLocalRepaintPreviewActivation({
    consumedKey: clearedActivation.nextConsumedKey,
    paintTool: 'none',
    preview: repaintPreview,
    currentPreview: repaintPreview,
    currentSource: { generationId: 'generation-1', targetLayerId: 'target-layer-1' },
    processedLayerIds: [repaintPreview.id],
  });
  assert.equal(
    reenteredActivation.shouldActivate,
    true,
    'The same generation and target must activate again after its preview is cleared.',
  );

  stdout.write('Projected-layer visibility regression test passed.\n');
} finally {
  await server.close();
}
