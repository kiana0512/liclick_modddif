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
const projectedLayerMaterialSource = readFileSync(
  path.join(root, 'src/engine/projection/ProjectedLayerMaterial.ts'),
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
  /const alreadyPresentsWhiteMembrane = hasPresentedMaterial && presentsOnlyWhiteMembrane;\s*if \(showWhiteMembrane && alreadyPresentsWhiteMembrane\) return;\s*if \(\s*!showWhiteMembrane &&\s*hasResidentProjectedMaterial/,
  'PBR changes must reuse the resident white or projected material instead of rebuilding it.',
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
  /importedModel\.restoreStage === 'bounds'[\s\S]*?liclickRestoreOutlinePrepared === true[\s\S]*?initialMaterialPresentationReadyForGroup/,
  'A refresh must stay non-empty from saved bounds through prepared outline and final material.',
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
  /const localRepaintEraseContact =\s*isLocalRepaintApplyMode && \(event\.button === 2 \|\| penEraserContact\)/,
  'Button 3 must reserve right mouse and pen eraser contact for subtracting local repaint.',
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
  /erasesLocalRepaint \? undefined : opacityByte/,
  'Local repaint erasing must use a binary stamp so one pass cannot leave a blended residue.',
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
  /createInwardFeatheredMask\(maskPixels, featherRadius\)[\s\S]*?removeEdgeConnectedNeutralBackground\(sourcePixels, 'dark-only'\)[\s\S]*?output\.data\[offset \+ 3\] = Math\.round/,
  'The worker must keep feathering inside the authored mask and multiply it by cleaned source alpha.',
);
assert.match(
  projectedLayerMaterialSource,
  /float lockedSurfaceCoverage =[\s\S]*?sourceAlpha[\s\S]*?float coverage = mix\(continuousCoverage, lockedSurfaceCoverage, surfaceLockedVisibility\)/,
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
  const authoredMaskPixels = new Uint8ClampedArray(7 * 7 * 4);
  for (let y = 1; y <= 5; y += 1) {
    for (let x = 1; x <= 5; x += 1) {
      const offset = (y * 7 + x) * 4;
      authoredMaskPixels[offset] = 255;
      authoredMaskPixels[offset + 1] = 255;
      authoredMaskPixels[offset + 2] = 255;
      authoredMaskPixels[offset + 3] = 255;
    }
  }
  const inwardFeather = repaintPreviewUtils.createInwardFeatheredMask(
    new ImageData(authoredMaskPixels, 7, 7),
    3,
  );
  assert.equal(
    inwardFeather.data[(3 * 7 + 0) * 4 + 3],
    0,
    'Inward feathering must never add coverage outside the authored selection.',
  );
  assert(
    inwardFeather.data[(3 * 7 + 1) * 4 + 3] <
      inwardFeather.data[(3 * 7 + 3) * 4 + 3],
    'Coverage must rise smoothly from the selection edge into its interior.',
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
