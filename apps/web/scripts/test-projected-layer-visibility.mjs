import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import * as THREE from 'three';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sceneRootSource = readFileSync(
  path.join(root, 'src/engine/viewport/SceneRoot.tsx'),
  'utf8',
);
const editorPageSource = readFileSync(path.join(root, 'src/routes/EditorPage.tsx'), 'utf8');
const generatePanelSource = readFileSync(
  path.join(root, 'src/components/panels/GeneratePanel.tsx'),
  'utf8',
);
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
const liveSurfacePaintPreviewRegistrySource = readFileSync(
  path.join(root, 'src/engine/paint/liveSurfacePaintPreviewRegistry.ts'),
  'utf8',
);
const viewportPanelSource = readFileSync(
  path.join(root, 'src/components/panels/ViewportPanel.tsx'),
  'utf8',
);
const sceneStoreSource = readFileSync(path.join(root, 'src/stores/sceneStore.ts'), 'utf8');
const editorShellSource = readFileSync(path.join(root, 'src/layouts/EditorShell.tsx'), 'utf8');
const localRepaintDialogSource = readFileSync(
  path.join(root, 'src/components/localRepaint/LocalRepaintDialog.tsx'),
  'utf8',
);
const localRepaintMaskWorkerSource = readFileSync(
  path.join(root, 'src/workers/localRepaintMaskPreparation.worker.ts'),
  'utf8',
);
const renderTargetUtilsSource = readFileSync(
  path.join(root, 'src/engine/capture/renderTargetUtils.ts'),
  'utf8',
);
const gpuReadbackWorkerSource = readFileSync(
  path.join(root, 'src/workers/encodeGpuReadbackPng.worker.ts'),
  'utf8',
);

assert.match(
  projectedPreviewCompositorSource,
  /vec4 maskTexel = texture\(maskMap, maskUv\);\s*float maskValue = dot\(maskTexel\.rgb,[\s\S]*?\) \* maskTexel\.a;/,
  'Projected preview compositing must preserve continuous mask alpha.',
);
assert.match(
  projectedPreviewCompositorSource,
  /float lockedCoverage =\s*layerOpacity \*\s*sourceAlpha \*\s*lockedSafetyCoverage/,
  'Surface-locked preview compositing must not binarize local-repaint feather.',
);
assert.match(
  projectedLayerMaterialSource,
  /float lockedCoverage =\s*layerOpacity \*\s*sourceAlpha \*\s*projectionFacingCoverage \*\s*lockedSafetyCoverage/,
  'The resident surface-locked material must preserve continuous local-repaint coverage.',
);
assert.match(
  liveSurfacePaintPreviewRegistrySource,
  /currentPreview\?\.objectId === preview\.objectId[\s\S]*?currentPreview\.layerId === preview\.layerId[\s\S]*?currentPreview\.assetUrl === preview\.assetUrl[\s\S]*?return;/,
  'Repeated short eraser strokes must not republish an identical live preview and restart the projected-material effect.',
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
assert.match(
  viewportCanvasInteractionSource,
  /if \(isInpaintMode \|\| isLocalRepaintApplyMode\) event\.preventDefault\(\);/,
  'Both repaint brushes must suppress the browser context menu while right-button erasing.',
);
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
assert.match(
  viewportCanvasInteractionSource,
  /erasesLocalRepaint && paintTool === 'eraser'[\s\S]*?paintToolSettings\.eraserFeather/,
  'The dedicated eraser feather must also control completed local-repaint masks.',
);
assert.match(
  readFileSync(path.join(root, 'src/components/editor/BottomToolDock.tsx'), 'utf8'),
  /paintToolSettings\.eraserFeather[\s\S]*?setPaintToolSettings\(\{ eraserFeather:/,
  'The eraser parameter popover must expose a feather control.',
);
assert.match(
  generatePanelSource,
  /const viewportReference = await captureCurrentColorPreview\([\s\S]*?colorMode: 'flat-target'[\s\S]*?cameraSnapshot: captureCameraSnapshot/,
  'The local-repaint viewport reference must capture frozen-camera BaseColor without PBR lighting.',
);
assert.match(
  generatePanelSource,
  /const completedGeneration: Generation = \{[\s\S]*?syncGeneration\(completedGeneration\);[\s\S]*?setGenerateNotice\(undefined\);[\s\S]*?void Promise\.all\(\[persistedResultUrlPromise, persistedPaintMaskUrlPromise\]\)/,
  'A returned repaint result must leave the foreground spinner before local persistence continues in the background.',
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
  /localRepaintInteractiveCaptureSize = 512[\s\S]*?mutatedShaderMaterials[\s\S]*?return source;/,
  'Button 2 must reuse the resident flat shader at a bounded interactive capture size.',
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
  /const showWhiteMembrane = Boolean\(\s*!hasAuthoritativeVisibleTextureLayer &&\s*!liveTopUvTexture &&\s*!liveSurfacePaintPreview/,
  'All hidden content-bearing layers must authoritatively keep the model in white-membrane mode.',
);
assert.match(
  sceneRootSource,
  /const exactBakedBootstrapTexture =\s*loadedBakedTexture &&\s*!showWhiteMembrane &&\s*stableVisibleProjectedLayers\.length > 0 &&/,
  'Changing PBR lighting with every projected eye closed must not restore a stale baked bootstrap texture.',
);
assert.match(
  sceneRootSource,
  /const alreadyPresentsWhiteMembrane = hasPresentedMaterial && presentsOnlyWhiteMembrane;\s*if \(showWhiteMembrane && alreadyPresentsWhiteMembrane\) \{[\s\S]*?revealInitialMaterialPresentation\(\);[\s\S]*?return;[\s\S]*?\}\s*if \(\s*!showWhiteMembrane &&\s*hasResidentProjectedMaterial/,
  'PBR changes must publish the current Group before reusing the resident white or projected material.',
);
assert.match(
  sceneRootSource,
  /const allowProgressiveDirectBootstrap = false as boolean/,
  'Cold projection restore must not expose a one-camera partial bootstrap.',
);
assert.match(
  sceneRootSource,
  /const hasAuthoritativeVisibleProjectedLayer = useLayerStore\([\s\S]*?layer\.type === 'projected'[\s\S]*?Boolean\(layer\.camera\)/,
  'Cold restore must determine visible projected content directly from the authoritative layer store.',
);
assert.match(
  sceneRootSource,
  /!hasAuthoritativeVisibleProjectedLayer &&[\s\S]*?loadedUvTexture/,
  'A UV bootstrap must never cover a visible projected stack while its final material is building.',
);
assert.match(
  sceneRootSource,
  /visible=\{initialMaterialPresentationVisibleForGroup\}/,
  'Cold restore must explicitly control placeholder, outline and final-material presentation.',
);
assert.match(
  sceneRootSource,
  /!hasAuthoritativeVisibleTextureLayer \|\|[\s\S]*?importedModel\.restoreStage === 'bounds'[\s\S]*?liclickRestoreOutlinePrepared === true[\s\S]*?initialMaterialPresentationReadyForGroup/,
  'A refresh must stay non-empty from saved bounds through prepared outline and final material.',
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
  /requestAnimationFrame[\s\S]*?requestAnimationFrame[\s\S]*?liclick:initial-model-frame-presented/,
  'The editor reveal signal must wait until the first WebGL model frame has actually been presented.',
);
assert.match(
  editorPageSource,
  /presentedViewportProjectId !== projectId[\s\S]*?fixed inset-0 z-\[220\]/,
  'The project loading cover must remain above an initializing viewport until model content is presented.',
);
assert.match(
  sceneRootSource,
  /model\.restoreStage === 'outline'[\s\S]*?createFlatPreviewMaterial[\s\S]*?revealInitialMaterialPresentation\(\)/,
  'Cold restore must reveal exact geometry with the canonical flat material instead of leaving an empty viewport.',
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
  /captureCurrentLocalRepaintView[\s\S]*?captureCurrentColorPreview[\s\S]*?generationPromise[\s\S]*?captureCurrentDepthPreview[\s\S]*?Promise\.all/,
  'The two aligned colour inputs must submit before the local-only depth guard finishes in parallel.',
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
  /const prewarmProjectedUvSamplers = async \([\s\S]*?\r?\n    async function applyMaterials/,
)?.[0];
assert(uvSamplerWarmupSource, 'Expected the projected UV sampler warmup implementation.');
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
  /const localRepaintEraseContact =\s*isLocalRepaintApplyMode &&[\s\S]*?event\.button === 2 \|\|[\s\S]*?penEraserContact \|\|[\s\S]*?isEditingPersistedLocalRepaint && event\.button === 0/,
  'Button 3, pen erasers, and the primary eraser gesture must subtract local repaint.',
);
assert.match(
  viewportCanvasSource,
  /const isLocalRepaintApplyMode =\s*paintTool === 'inpaint-apply' \|\| isEditingPersistedLocalRepaint/,
  'The ordinary eraser must enter the non-destructive local repaint path for a completed repaint layer.',
);
assert.match(
  viewportCanvasSource,
  /!canUseSurfacePaint \|\|\s*isEditingPersistedLocalRepaint[\s\S]*?beginLiveEraserPreview/,
  'A completed local repaint must never prewarm the all-white generic projected-layer eraser mask.',
);
assert.match(
  viewportCanvasSource,
  /setLocalRepaintProjectionSource\(\{[\s\S]*?imageUrl: sourceUrl,[\s\S]*?allowedMaskUrl,[\s\S]*?camera: projectionCamera/,
  'Re-entering the eraser must restore the persisted local repaint editing source.',
);
assert.match(
  viewportCanvasSource,
  /const shouldPrewarmPersistedLocalRepaint =\s*isEditableLocalRepaintProjectionLayer\(activePaintLayer\) &&\s*\(paintTool === 'none' \|\| isEditingPersistedLocalRepaint\)/,
  'A selected persisted local repaint must restore its editing source before the eraser is pressed.',
);
assert.match(
  viewportCanvasSource,
  /if \(!shouldPrewarmPersistedLocalRepaint && paintTool !== 'inpaint-apply'\) return;[\s\S]*?getFeatheredBrushStamp\(localRepaintBrushSettings\.brushFeather\)/,
  'The active local repaint feather stamp must be allocated before the first pointer sample.',
);
assert.match(
  viewportCanvasSource,
  /if \(!shouldPrewarmPersistedLocalRepaint \|\| !activePaintLayer\?\.camera\) return;[\s\S]*?currentPaintTool !== 'none' && currentPaintTool !== 'eraser'/,
  'Persisted local repaint prewarming must stay active while the viewport is idle or erasing.',
);
assert.match(
  viewportCanvasSource,
  /const sourceUrl = activePaintLayer\.imageUrl \|\| activePaintLayer\.localRepaintSourceUrl;\s*const savedMaskUrl = activePaintLayer\.maskUrl \|\| activePaintLayer\.localRepaintMaskUrl;/,
  'Reloaded repaint editing must prefer workspace-resolved canonical asset URLs.',
);
assert.match(
  viewportCanvasSource,
  /if \(composite\.restoredMaskUrl && !composite\.restoredMaskReady\) return;[\s\S]*?const commitRevision =/,
  'An unrecovered persisted mask must never publish an empty live canvas.',
);
assert.match(
  viewportCanvasSource,
  /!composite \|\|\s*\(composite\.restoredMaskUrl && !composite\.restoredMaskReady\) \|\|\s*!composite\.gpuOverlayReady[\s\S]*?return;\s*const surfaceFacesProjector/,
  'The eraser must reject its first stroke until persisted coverage and the GPU overlay are ready.',
);
assert.match(
  viewportCanvasSource,
  /isEditingPersistedLocalRepaint &&\s*!isLocalRepaintSourceForLayer\(source, activePaintLayer\)/,
  'The eraser must reject input until the selected repaint layer owns the restored source.',
);
assert.match(
  viewportCanvasSource,
  /currentPreviewLayer &&[\s\S]*?!isMatchingLocalRepaintProjectionLayer\([\s\S]*?sceneState\.setLocalRepaintPreviewLayer\(undefined\)/,
  'Switching repaint layers must unmute the previous persisted row before rebinding its overlay.',
);
assert.match(
  editorPageSource,
  /const selectedPersistedLocalRepaint = Boolean\([\s\S]*?activeLayer && isLocalRepaintProjectionLayer\(activeLayer\)[\s\S]*?selectedPersistedLocalRepaint \|\|/,
  'Background staging of the newest generation must yield while a persisted repaint row is selected.',
);
assert.match(
  editorPageSource,
  /const latestActiveLayer = latestLayerState\.layers\.find\([\s\S]*?isLocalRepaintProjectionLayer\(latestActiveLayer\)[\s\S]*?return;/,
  'A pending newest-generation preload must not overwrite a historical repaint source after selection changes.',
);
assert.match(
  viewportCanvasSource,
  /const persistedOverlayCanOwnPresentation = Boolean\([\s\S]*?!existingLayer \|\|[\s\S]*?composite\.hasContent &&[\s\S]*?composite\.gpuOverlayReady &&[\s\S]*?currentOverlay\?\.sourceKey === sourceKey &&[\s\S]*?currentOverlay\.root\.visible/,
  'A persisted repaint row must stay visible until its saved mask and GPU overlay are both ready and visible.',
);
assert.match(
  viewportCanvasSource,
  /currentPreviewLayer\?\.id === projectedLayer\.id &&[\s\S]*?!persistedOverlayCanOwnPresentation[\s\S]*?setLocalRepaintPreviewLayer\(undefined\)/,
  'Refresh must clear a stale live-owner marker instead of hiding both the saved repaint and its overlay.',
);
assert.match(
  viewportCanvasSource,
  /syncLocalRepaintGpuOverlayBinding\(overlay,[\s\S]*?if \(visible\) ensureLiveLocalRepaintComposite\(result\.model, source\)/,
  'Pointer-down must transfer repaint presentation ownership only after making the live overlay visible.',
);
assert.match(
  viewportCanvasSource,
  /const savedLiveMaskCanvas = savedMaskUrl[\s\S]*?getLiveProjectedCanvasState\(savedMaskUrl\)\?\.canvas[\s\S]*?createLocalRepaintComposite\(/,
  'Switching repaint layers must capture the old stable-URL mask before registering its replacement canvas.',
);
assert.doesNotMatch(
  viewportCanvasSource,
  /savedMaskUrl && savedMaskUrl !== composite\.maskUrl/,
  'A stable live mask URL must still be restored when a new canvas reuses that URL.',
);
assert.match(
  viewportCanvasSource,
  /if \(composite\.restoredMaskPromise\) await composite\.restoredMaskPromise;[\s\S]*?ensureLiveLocalRepaintComposite\(model, source\) !== composite/,
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
  /strokePaintToolRef\.current === 'inpaint-apply-erase';[\s\S]*?event\.buttons & \(usesSecondaryButton \? 2 : 1\)/,
  'A right-button local repaint stroke must remain active throughout pointer movement.',
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
  'The dedicated eraser must use its own feather while right-button erase keeps the repaint brush feather.',
);
assert.match(
  viewportCanvasSource,
  /strokePaintTool === 'inpaint-apply' \|\|[\s\S]*?strokePaintTool === 'inpaint-apply-erase'[\s\S]*?erasesLocalRepaint \? 'erase' : 'apply'/,
  'Local repaint apply and erase must share the same projected brush path.',
);
const repaintSourceTransparency = viewportCanvasSource.match(
  /function constrainLocalRepaintFalloffToSourceContent\([\s\S]*?\r?\n}\r?\n/,
)?.[0];
assert(
  repaintSourceTransparency,
  'Expected local repaint projection to constrain brush coverage to generated content alpha.',
);
assert.match(
  repaintSourceTransparency,
  /removeEdgeConnectedNeutralBackground\(sourcePixels, 'dark-only'\)[\s\S]*?globalCompositeOperation = 'destination-in'/,
  'Local repaint must remove the same dark backdrop as its generated-image preview before projection.',
);
assert.match(
  viewportCanvasSource,
  /const compileScene = new THREE\.Scene\(\);[\s\S]*?const compilePromise = gl\.compileAsync\(compileScene, camera\);[\s\S]*?overlayState\.compilePromise = compilePromise/,
  'Local repaint must compile only its isolated overlay instead of capturing replaceable scene materials.',
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
  /weightTotal[\s\S]*?farthestCornerRadius[\s\S]*?fadeEndRadius[\s\S]*?removeEdgeConnectedNeutralBackground\(sourcePixels, 'dark-only'\)[\s\S]*?globalCompositeOperation = 'destination-in'/,
  'The worker must preserve the authored core and fade across the complete captured view.',
);
assert.match(
  editorPageSource,
  /const getLocalRepaintProjectionImage = useCallback\(\(resultUrl: string\)[\s\S]*?const promise = Promise\.resolve\(resultUrl\)/,
  'An aligned local repaint result must reach the viewport without a second silhouette crop.',
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
  server: { middlewareMode: true },
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
  const repaintPreviewUtils = await server.ssrLoadModule(
    '/src/engine/localRepaint/resultPreviewUtils.ts',
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
    /float overlayAlpha = clamp\(coverage \* mix\(0\.75, 1\.0, qualityFade\), 0\.0, 1\.0\)/,
    'Live overlays must use the same alpha formula as merged UV overlays.',
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
  assert.equal(liveRepaintOverlay.polygonOffsetFactor, -1);
  assert.equal(liveRepaintOverlay.polygonOffsetUnits, -1);
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
    /float acceptedDepthOffset = -0\.000080;[\s\S]*mix\(0\.000006, acceptedDepthOffset, projectedDepthPriority\)/,
    'The final repaint pass must have deterministic depth priority above the projected background.',
  );
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
  assert.equal(overlayMaterial.uniforms.layerOpacity.value, 1);
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
  assert.equal(material.uniforms.showEmptyProjectionHatch.value, 1);
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
    projection.syncProjectedLayerMaterialDisplayState(
      mergedUvMaterial,
      [],
      false,
      false,
      {
        enabled: true,
        exposure: 1.1,
        ambientIntensity: 0.45,
        keyLightIntensity: 1.4,
        keyLightDirection: updatedUvLightDirection,
      },
    ),
    true,
    'Merged UV preview lighting controls must update the resident UV material.',
  );
  assert(
    mergedUvMaterial.uniforms.keyLightDirection.value.equals(expectedUvLightDirection),
    'Changing PBR light azimuth must update the merged UV key-light direction.',
  );
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
