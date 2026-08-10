import assert from 'node:assert/strict';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import * as THREE from 'three';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  const projection = await server.ssrLoadModule(
    '/src/engine/projection/ProjectedLayerMaterial.ts',
  );
  const repaintActivation = await server.ssrLoadModule(
    '/src/engine/viewport/localRepaintPreviewActivation.ts',
  );
  const repaintOverlaySync = await server.ssrLoadModule(
    '/src/engine/viewport/localRepaintGpuOverlaySync.ts',
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
    renderedColor: true,
    useMask: false,
    depthTest: true,
  });
  assert.equal(liveRepaintOverlay.transparent, true);
  assert.equal(liveRepaintOverlay.depthWrite, false);
  assert.equal(liveRepaintOverlay.depthFunc, THREE.LessEqualDepth);
  assert.equal(liveRepaintOverlay.polygonOffsetFactor, -16);
  assert.equal(liveRepaintOverlay.polygonOffsetUnits, -16);
  assert.equal(liveRepaintOverlay.uniforms.transparentProjectionOnly.value, 1);
  assert.match(
    liveRepaintOverlay.fragmentShader,
    /literalReplacementAlpha/,
    'The live repaint overlay must keep rejected pixels transparent instead of replacing the model material.',
  );
  assert.match(
    liveRepaintOverlay.fragmentShader,
    /mix\(0\.000006, -0\.000080, projectedDepthPriority\)/,
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
  assert.equal(flatWhiteMembraneMaterial.emissiveIntensity, 0);
  assert.equal(
    flatWhiteMembraneMaterial.emissive.getHexString(),
    '000000',
    'The non-projected fallback must not flatten shading with white emission.',
  );
  projection.disposeGeneratedMaterialTree(flatWhiteMembraneMaterial);

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
