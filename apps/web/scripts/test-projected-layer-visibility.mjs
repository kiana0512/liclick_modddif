import assert from 'node:assert/strict';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

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

  const material = await projection.createProjectedLayerStackMaterial(
    {
      layers,
      objectId: 'regression-object',
      currentObjectMatrixWorld: identity,
      depthTest: true,
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
  projection.disposeGeneratedMaterialTree(material);

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

  stdout.write('Projected-layer visibility regression test passed.\n');
} finally {
  await server.close();
}
