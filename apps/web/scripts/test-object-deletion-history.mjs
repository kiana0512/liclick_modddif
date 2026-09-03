import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storage = new Map();
const dispatchedEvents = [];
const localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.localStorage = localStorage;
globalThis.window = {
  localStorage,
  dispatchEvent: (event) => {
    dispatchedEvents.push(event.type);
    return true;
  },
};

const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

function makeObject(id, position, selected = false) {
  return {
    id,
    name: `model-${id}`,
    type: 'mesh',
    sourcePath: `https://assets.example/${id}.glb`,
    format: 'glb',
    materialSlots: [],
    uvSets: ['uv0'],
    transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    selected,
  };
}

function makeRuntimeModel(object) {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
  group.position.fromArray(object.transform.position);
  group.updateMatrixWorld(true);
  return {
    objectId: object.id,
    name: object.name,
    format: 'glb',
    group,
    sourceFileName: `${object.id}.glb`,
    materialSlots: [],
    uvSets: ['uv0'],
    boundingBox: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5], center: [0, 0, 0], size: [1, 1, 1] },
    originalBoundingBox: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5], center: [0, 0, 0], size: [1, 1, 1] },
    importNormalizationTransform: {
      position: object.transform.position,
      scale: [1, 1, 1],
      targetMaxDimension: 3,
      grounded: true,
      normalized: true,
    },
    childMeshCount: 1,
    warnings: [],
  };
}

try {
  const { createObjectDeletionTransaction } = await server.ssrLoadModule(
    '/src/engine/history/objectDeletionTransaction.ts',
  );
  const { useProjectStore } = await server.ssrLoadModule('/src/stores/projectStore.ts');
  const { useSceneStore } = await server.ssrLoadModule('/src/stores/sceneStore.ts');
  const { useLayerStore } = await server.ssrLoadModule('/src/stores/layerStore.ts');
  const { useGenerationStore } = await server.ssrLoadModule('/src/stores/generationStore.ts');

  const objectA = makeObject('a', [-2, 0, 0]);
  const objectB = makeObject('b', [2, 0, 0], true);
  const runtimeA = makeRuntimeModel(objectA);
  const runtimeB = makeRuntimeModel(objectB);
  const layerB = {
    id: 'layer-b',
    name: 'layer-b',
    type: 'uv',
    objectId: 'b',
    imageUrl: 'https://assets.example/layer-b.png',
    visible: true,
    opacity: 1,
    strength: 1,
    blendMode: 'normal',
    adjustments: { hue: 0, saturation: 0, lightness: 0 },
    order: 0,
    createdAt: '2026-09-03T00:00:00.000Z',
  };
  const generationB = {
    id: 'generation-b',
    createdAt: '2026-09-03T00:00:00.000Z',
    status: 'succeeded',
    metadata: { objectId: 'b', projectId: 'project-delete-history' },
  };
  const captureB = { id: 'capture-b', objectId: 'b' };
  const project = {
    id: 'project-delete-history',
    name: 'delete-history',
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    thumbnail: '',
    objects: [objectA, objectB],
    references: [{ id: 'reference-b', objectId: 'b', name: 'reference-b', imageUrl: 'ref' }],
    captures: [captureB],
    generations: [generationB],
    layers: [layerB],
    bakedTextures: [{ id: 'baked-b', objectId: 'b', sourceLayerId: 'layer-b' }],
    bakeWorkspace: {
      selectedObjectId: 'b',
      bakeSets: { b: { objectId: 'b' } },
    },
    activeObjectId: 'b',
    activeLayerId: 'layer-b',
    revision: { revision: 1 },
    settings: {},
  };

  useProjectStore.getState().setProjects([project]);
  useProjectStore.getState().setCurrentProject(project.id);
  useSceneStore.getState().setObjects([objectA, objectB], 'b');
  useSceneStore.getState().restoreImportedModels([runtimeA, runtimeB], 'b');
  useLayerStore.getState().setLayers([layerB]);
  useLayerStore.setState({ activeProjectedLayerId: 'layer-b' });
  useGenerationStore.setState({
    generations: [generationB],
    currentGeneration: generationB,
    lastCapture: captureB,
    isGenerating: false,
  });

  const transaction = createObjectDeletionTransaction('b');
  assert.ok(transaction, 'a present scene object must create a reversible delete transaction');
  transaction.redo();
  assert.deepEqual(useSceneStore.getState().objects.map((object) => object.id), ['a']);
  assert.deepEqual(useSceneStore.getState().importedModels.map((model) => model.objectId), ['a']);
  assert.equal(useLayerStore.getState().layers.length, 0);
  assert.equal(useGenerationStore.getState().generations.length, 0);
  assert.equal(useProjectStore.getState().getCurrentProject().captures.length, 0);
  assert.match(
    storage.get('liclick:pending-object-deletions:v1'),
    /project-delete-history[\s\S]*b/,
    'redo must preserve the local deletion tombstone until a successful save',
  );

  const revisionAfterDelete = { revision: 2 };
  useProjectStore.getState().updateCurrentProject({ revision: revisionAfterDelete });
  transaction.undo();
  const restoredScene = useSceneStore.getState();
  const restoredProject = useProjectStore.getState().getCurrentProject();
  assert.deepEqual(restoredScene.objects.map((object) => object.id), ['a', 'b']);
  assert.strictEqual(
    restoredScene.importedModels.find((model) => model.objectId === 'b'),
    runtimeB,
    'undo must republish the retained Three.js model instead of waiting for a source reload',
  );
  assert.deepEqual(runtimeA.group.position.toArray(), [-2, 0, 0]);
  assert.deepEqual(runtimeB.group.position.toArray(), [2, 0, 0]);
  assert.equal(restoredScene.selectedObjectId, 'b');
  assert.equal(useLayerStore.getState().activeProjectedLayerId, 'layer-b');
  assert.equal(useGenerationStore.getState().currentGeneration.id, 'generation-b');
  assert.equal(restoredProject.references.length, 1);
  assert.equal(restoredProject.captures.length, 1);
  assert.equal(restoredProject.generations.length, 1);
  assert.equal(restoredProject.bakedTextures.length, 1);
  assert.ok(restoredProject.bakeWorkspace.bakeSets.b);
  assert.deepEqual(restoredProject.revision, revisionAfterDelete);
  assert.equal(storage.get('liclick:pending-object-deletions:v1'), undefined);
  assert.equal(
    dispatchedEvents.includes('liclick:object-runtime-restore-request'),
    false,
    'the normal undo path must be synchronous when the deleted runtime is retained',
  );

  transaction.redo();
  transaction.undo();
  assert.strictEqual(
    useSceneStore.getState().importedModels.find((model) => model.objectId === 'b'),
    runtimeB,
    'redo followed by undo must remain reversible with the same runtime instance',
  );

  const panelSource = await readFile(
    path.join(root, 'src/components/panels/ObjectsPanel.tsx'),
    'utf8',
  );
  const editorSource = await readFile(path.join(root, 'src/routes/EditorPage.tsx'), 'utf8');
  assert.match(panelSource, /createObjectDeletionTransaction\(objectId\)[\s\S]{0,300}captureRuntimeHistory/);
  assert.match(
    editorSource,
    /addEventListener\(OBJECT_RUNTIME_RESTORE_REQUEST_EVENT, restoreMissingObjectRuntime\)/,
  );
  assert.match(editorSource, /restoreProjectModelRef\.current\(currentProject\)/);
  console.log('object deletion history tests passed');
} finally {
  await server.close();
  delete globalThis.window;
  delete globalThis.localStorage;
}
