import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, logLevel: 'silent', server: { middlewareMode: true } });

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const capture = {
  id: 'capture-current',
  objectId: 'object-a',
  colorUrl: 'memory://capture',
  maskUrl: 'memory://capture-mask',
  depthUrl: 'memory://capture-depth',
  depthEncoding: 'linear-view',
  width: 1024,
  height: 1024,
  createdAt: '2026-09-04T00:00:00.000Z',
  camera: {
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
  },
};

const generation = (id, mode = 'single') => ({
  id,
  mode,
  prompt: '',
  referenceIds: [],
  captureId: capture.id,
  resultUrl: `memory://${id}`,
  status: 'succeeded',
  metadata: {
    workflow: 'texture-map',
    multiview: mode === 'multiview',
    alphaMode: 'geometry-mask-separated',
    cameraViewLabel: mode === 'single' ? '当前视角' : '正面',
  },
});

try {
  const overlay = await server.ssrLoadModule('/src/engine/bake/projectedOverlayComposition.ts');
  const { useLayerStore } = await server.ssrLoadModule('/src/stores/layerStore.ts');
  const projection = await server.ssrLoadModule('/src/engine/projection/ProjectedLayerMaterial.ts');

  useLayerStore.setState({ layers: [], activeProjectedLayerId: undefined });
  const firstSingle = useLayerStore
    .getState()
    .addProjectedLayerFromGeneration(generation('single-a'), capture, capture.objectId);
  const secondSingle = useLayerStore
    .getState()
    .addProjectedLayerFromGeneration(generation('single-b'), capture, capture.objectId);
  const multiview = useLayerStore
    .getState()
    .addProjectedLayerFromGeneration(generation('multi', 'multiview'), capture, capture.objectId);

  for (const single of [firstSingle, secondSingle]) {
    assert.equal(single.projectionCompositeMode, undefined);
    assert.equal(single.projectionCoverageMode, 'capture-mask');
    assert.equal(single.maskUrl, capture.maskUrl);
    assert.equal(single.maskSpace, 'projection');
    assert.equal(single.ignoreSourceAlpha, true);
    assert.equal(single.minimumProjectionFacing, 0.18);
    assert.equal(single.projectionVisibilityPolicy, 'standard');
    assert.equal(overlay.getProjectedLayerOverlayMode(single), undefined);
  }
  assert.equal(multiview.projectionCompositeMode, undefined);
  assert.equal(multiview.projectionVisibilityPolicy, undefined);
  assert.equal(overlay.getProjectedLayerOverlayMode(multiview), undefined);

  useLayerStore.getState().setLayers([
    {
      ...firstSingle,
      minimumProjectionFacing: undefined,
    },
  ]);
  const normalizedCanonicalSingle = useLayerStore.getState().layers[0];
  assert.equal(normalizedCanonicalSingle.minimumProjectionFacing, 0.18);

  useLayerStore.getState().setLayers([
    {
      ...firstSingle,
      maskUrl: undefined,
      maskSpace: undefined,
      projectionCoverageMode: undefined,
      projectionCompositeMode: 'single-view-priority-v1',
      ignoreSourceAlpha: false,
      minimumProjectionFacing: 0,
      projectionVisibilityPolicy: 'surface-locked-v1',
    },
  ]);
  const migrated = useLayerStore.getState().layers[0];
  assert.equal(migrated.projectionCompositeMode, undefined);
  assert.equal(migrated.projectionCoverageMode, 'capture-mask');
  assert.equal(migrated.ignoreSourceAlpha, true);
  assert.equal(migrated.minimumProjectionFacing, 0.18);
  assert.equal(migrated.projectionVisibilityPolicy, 'standard');

  projection.primeProjectedImageTexture(firstSingle.imageUrl, { width: 2, height: 2 });
  projection.primeProjectedImageTexture(secondSingle.imageUrl, { width: 2, height: 2 });
  const material = await projection.createProjectedLayerStackMaterial(
    {
      objectId: capture.objectId,
      currentObjectMatrixWorld: identity,
      depthTest: true,
      layers: [firstSingle, secondSingle].map((layer) => ({
        layerId: layer.id,
        imageUrl: layer.imageUrl,
        camera: capture.camera,
        opacity: 1,
        strength: 1,
        blendMode: 'normal',
        compositeRole: 'normal',
        visible: true,
        ignoreSourceAlpha: true,
        minimumProjectionFacing: layer.minimumProjectionFacing,
        projectionVisibilityPolicy: 'standard',
      })),
    },
    { maxTextureImageUnits: 64 },
  );
  assert(material, 'quality projection stack material must be created');
  assert.equal(material.uniforms.layerOverlayMode0.value, 0);
  assert.equal(material.uniforms.layerOverlayMode1.value, 0);
  assert.match(material.fragmentShader, /insertBlendCandidate\(texel\.rgb, coverage, quality\)/);
  assert.match(
    material.fragmentShader,
    /smoothstep\(0\.180, 0\.260, abs\(dot\(captureViewVertexNormal/,
    'The resident stack must apply the single-view grazing-face guard.',
  );
  projection.disposeGeneratedMaterialTree(material);

  const layerStoreSource = readFileSync(new URL('../src/stores/layerStore.ts', import.meta.url), 'utf8');
  const sceneRootSource = readFileSync(new URL('../src/engine/viewport/SceneRoot.tsx', import.meta.url), 'utf8');
  const generatePanelSource = readFileSync(new URL('../src/components/panels/GeneratePanel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(
    layerStoreSource,
    /projectionCompositeMode:\s*singleViewTexture\s*\?\s*'single-view-priority-v1'/,
  );
  assert.match(sceneRootSource, /projectionCoverageMode === 'capture-mask'/);
  assert.doesNotMatch(sceneRootSource, /layer\.projectionCompositeMode === 'single-view-priority-v1'/);
  assert.match(
    generatePanelSource,
    /createCaptureMaskedProjectionImage\(\s*readableResultUrl,\s*generationCapture\.maskUrl,?\s*\)/,
  );
  assert.doesNotMatch(generatePanelSource, /hasVisibleTextureBase|projectionUsesSourceAlpha/);
  assert.doesNotMatch(generatePanelSource, /projectionEdgeBlendMode:\s*'distance-field-v1'/);

  console.log('Unified single-view and multiview quality composition invariants passed.');
} finally {
  await server.close();
}
