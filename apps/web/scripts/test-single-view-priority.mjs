import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, logLevel: 'silent', server: { middlewareMode: true } });

try {
  const priority = await server.ssrLoadModule(
    '/src/engine/projection/priorityProjectionComposition.ts',
  );
  const overlay = await server.ssrLoadModule('/src/engine/bake/projectedOverlayComposition.ts');
  const { useLayerStore } = await server.ssrLoadModule('/src/stores/layerStore.ts');
  const projection = await server.ssrLoadModule('/src/engine/projection/ProjectedLayerMaterial.ts');

  const boundaryAlpha = priority.getPriorityProjectionAlpha(0.2, 0.05);
  const coreAlpha = priority.getPriorityProjectionAlpha(0.9, 0.9);
  assert(boundaryAlpha > 0 && boundaryAlpha < 0.15, 'boundary must stay softly feathered');
  assert(coreAlpha > 0.98, 'high-confidence core must be nearly opaque');
  assert.equal(
    overlay.getProjectedLayerOverlayMode({
      type: 'projected',
      id: 'single-priority',
      imageUrl: 'memory://single-priority',
      blendMode: 'normal',
      projectionCompositeMode: 'single-view-priority-v1',
    }),
    'priority-feathered',
  );

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
    createdAt: '2026-08-22T00:00:00.000Z',
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
  useLayerStore.setState({ layers: [], activeProjectedLayerId: undefined });
  const single = useLayerStore.getState().addProjectedLayerFromGeneration(
    {
      id: 'generation-single',
      mode: 'single',
      prompt: '',
      referenceIds: [],
      captureId: capture.id,
      resultUrl: 'memory://single-result',
      status: 'succeeded',
      metadata: {
        workflow: 'texture-map',
        multiview: false,
        alphaMode: 'geometry-mask-separated',
        cameraViewLabel: '当前视角',
      },
    },
    capture,
    capture.objectId,
  );
  assert.equal(single.order, 0, 'new single view must be inserted at the top');
  assert.equal(single.projectionCompositeMode, 'single-view-priority-v1');
  assert.equal(single.maskUrl, capture.maskUrl, 'single view must retain its capture silhouette');
  assert.equal(single.maskSpace, 'projection');
  assert.equal(
    single.ignoreSourceAlpha,
    true,
    'provider alpha must not define single-view coverage',
  );
  assert.equal(single.minimumProjectionFacing, 0);
  assert.equal(single.projectionVisibilityPolicy, 'surface-locked-v1');

  const blendedSingle = useLayerStore.getState().addProjectedLayerFromGeneration(
    {
      id: 'generation-single-blended',
      mode: 'single',
      prompt: '',
      referenceIds: [],
      captureId: capture.id,
      resultUrl: 'memory://single-blended-result',
      status: 'succeeded',
      metadata: {
        workflow: 'texture-map',
        multiview: false,
        alphaMode: 'geometry-mask-separated',
        projectionEdgeBlendMode: 'distance-field-v1',
        cameraViewLabel: '当前视角',
      },
    },
    capture,
    capture.objectId,
  );
  assert.equal(
    blendedSingle.ignoreSourceAlpha,
    false,
    'editor-authored single-view distance-field alpha must participate in composition',
  );

  const multiview = useLayerStore.getState().addProjectedLayerFromGeneration(
    {
      id: 'generation-multiview',
      mode: 'multiview',
      prompt: '',
      referenceIds: [],
      captureId: capture.id,
      resultUrl: 'memory://multiview-result',
      status: 'succeeded',
      metadata: {
        workflow: 'texture-map',
        multiview: true,
        alphaMode: 'geometry-mask-separated',
        cameraViewLabel: '正面',
      },
    },
    capture,
    capture.objectId,
  );
  assert.equal(multiview.projectionCompositeMode, undefined, 'multiview must keep quality blend');
  assert.equal(multiview.maskUrl, undefined, 'multiview keeps its existing coverage contract');
  assert.equal(multiview.projectionVisibilityPolicy, undefined);

  useLayerStore.getState().setLayers([
    {
      ...single,
      maskUrl: undefined,
      maskSpace: undefined,
      ignoreSourceAlpha: undefined,
      minimumProjectionFacing: undefined,
      projectionVisibilityPolicy: undefined,
    },
  ]);
  const migratedSingle = useLayerStore.getState().layers[0];
  assert.equal(migratedSingle.ignoreSourceAlpha, true, 'saved single views must migrate safely');
  assert.equal(migratedSingle.minimumProjectionFacing, 0);
  assert.equal(migratedSingle.projectionVisibilityPolicy, 'surface-locked-v1');

  projection.primeProjectedImageTexture('memory://quality-layer', { width: 2, height: 2 });
  projection.primeProjectedImageTexture('memory://priority-layer', { width: 2, height: 2 });
  const material = await projection.createProjectedLayerStackMaterial(
    {
      objectId: capture.objectId,
      currentObjectMatrixWorld: identity,
      depthTest: true,
      layers: [
        {
          layerId: 'quality-layer',
          imageUrl: 'memory://quality-layer',
          camera: capture.camera,
          opacity: 1,
          strength: 1,
          blendMode: 'normal',
          compositeRole: 'normal',
          visible: true,
        },
        {
          layerId: 'priority-layer',
          imageUrl: 'memory://priority-layer',
          camera: capture.camera,
          opacity: 1,
          strength: 1,
          blendMode: 'normal',
          compositeRole: 'overlay',
          priorityOverlay: true,
          visible: true,
        },
      ],
    },
    { maxTextureImageUnits: 64 },
  );
  assert(material, 'priority projection stack material must be created');
  assert.equal(material.uniforms.layerOverlayMode0.value, 0);
  assert.equal(material.uniforms.layerOverlayMode1.value, 2);
  assert.match(material.fragmentShader, /computeOrderedOverlayAlpha/);
  projection.disposeGeneratedMaterialTree(material);

  const residentShaderSource = readFileSync(
    new URL('../src/engine/projection/ProjectedLayerMaterial.ts', import.meta.url),
    'utf8',
  );
  const progressiveShaderSource = readFileSync(
    new URL('../src/engine/projection/ProjectedLayerPreviewCompositor.ts', import.meta.url),
    'utf8',
  );
  assert.match(residentShaderSource, /computeOrderedOverlayAlpha[\s\S]*?coreConfidence/);
  assert.match(progressiveShaderSource, /priorityOverlay[\s\S]*?coreConfidence/);

  const generatePanelSource = readFileSync(
    new URL('../src/components/panels/GeneratePanel.tsx', import.meta.url),
    'utf8',
  );
  const modelviewClientSource = readFileSync(
    new URL('../src/services/modelviewApiClient.ts', import.meta.url),
    'utf8',
  );
  assert.match(generatePanelSource, /data-single-view-provider=\{singleViewProvider\}/);
  assert.match(generatePanelSource, /value: 'gpt', label: 'GPT2'/);
  assert.match(generatePanelSource, /value: 'remote', label: '远端'/);
  assert.match(
    generatePanelSource,
    /usesRemoteSingleView[\s\S]*?modelviewClient\.generateSingleView[\s\S]*?client\.generateTextureSingleView/,
    'remote single-view must be additive while preserving the GPT2 submission path',
  );
  assert.match(generatePanelSource, /urlToDataUrl\(capture\.colorUrl\)/);
  assert.match(generatePanelSource, /urlToDataUrl\(materialReference\.url\)/);
  assert.match(
    generatePanelSource,
    /createCaptureMaskedProjectionImage\([\s\S]*?readableResultUrl,[\s\S]*?generationCapture\.maskUrl/,
    'single-view projection must persist a full-frame edge-decontaminated colour image',
  );
  assert.match(modelviewClientSource, /'\/api\/modelview\/single-view'/);
  assert.match(modelviewClientSource, /provider: 'modelview-single-view'/);
  assert.match(
    modelviewClientSource,
    /modelviewWorkflow: '2026\.08\.26-c0e6218-single-view-4step-r1'/,
  );

  console.log('Single-view priority projection invariants passed.');
} finally {
  await server.close();
}
