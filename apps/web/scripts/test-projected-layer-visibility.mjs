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
const uvSamplerWarmupSource = sceneRootSource.match(
  /const prewarmProjectedUvSamplers = async \([\s\S]*?\n    async function applyMaterials/,
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
const repaintSourceTransparency = viewportCanvasSource.match(
  /function constrainLocalRepaintFalloffToSourceContent\([\s\S]*?\n}\n/,
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
  /removeEdgeConnectedNeutralBackground\(sourcePixels, 'dark-only'\)[\s\S]*?globalCompositeOperation = 'destination-in'/,
  'Dark-background rejection must run inside the local repaint worker before publishing coverage.',
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
      constructor(data, width, height) {
        this.data = data;
        this.width = width;
        this.height = height;
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
    true,
    'Local repaint must keep its authored colour and bypass the PBR sweep.',
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
      baseTexture: residentContentAwareTexture,
      baseTextureOpacity: 1,
    },
    { maxTextureImageUnits: 64 },
  );
  assert(material, 'Expected the six-layer projected material to be created.');
  const state = material.userData.liclickProjectedLayerStackState;
  assert.equal(state.bindings.length, 6);
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
      baseTexture: residentContentAwareTexture,
      baseTextureOpacity: 0,
    }),
    true,
    'Closing a resident UV eye must update uniforms without rebuilding the shader.',
  );
  assert.equal(material.uniforms.uvOverlayOpacity.value, 0);
  assert.equal(material.uniforms.useUvOverlayMap.value, 1);
  assert.equal(material.uniforms.baseTextureOpacity.value, 0);
  assert.equal(material.uniforms.useBaseMap.value, 1);
  assert.match(
    material.fragmentShader,
    /baseTexel\.a \* baseTextureOpacity/,
    'Content-aware visibility must be applied in the shader without releasing its sampler.',
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
