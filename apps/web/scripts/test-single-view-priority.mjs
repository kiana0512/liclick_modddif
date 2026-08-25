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
  const overlay = await server.ssrLoadModule(
    '/src/engine/bake/projectedOverlayComposition.ts',
  );
  const { useLayerStore } = await server.ssrLoadModule('/src/stores/layerStore.ts');
  const projection = await server.ssrLoadModule(
    '/src/engine/projection/ProjectedLayerMaterial.ts',
  );

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

  console.log('Single-view priority projection invariants passed.');
} finally {
  await server.close();
}
