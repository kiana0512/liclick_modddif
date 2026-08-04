import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  getBakeHighObjects,
  replaceBakeHighSnapshot,
} from '../apps/web/src/services/bakeHighSnapshot.ts';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function sceneObject(id, name, sourcePath) {
  return {
    id,
    name,
    type: 'mesh',
    sourcePath,
    format: 'fbx',
    materialSlots: [{ id: `${id}-material`, name: 'Material' }],
    uvSets: ['UV0'],
    transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    selected: true,
  };
}

const textureObject = sceneObject('texture-object', '贴图源.fbx', '/models/texture-source.fbx');
const otherObject = sceneObject('other-object', '其他模型.fbx', '/models/other.fbx');
const untouchedSet = { objectId: 'other-object', low: { name: 'other-low.fbx', url: '/other-low.fbx' } };
const originalProject = {
  id: 'project-1',
  name: 'Isolation fixture',
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z',
  thumbnail: '',
  objects: [textureObject, otherObject],
  references: [],
  captures: [],
  generations: [],
  layers: [{ id: 'layer-1', objectId: 'texture-object' }],
  bakedTextures: [],
  bakeWorkspace: {
    version: 1,
    activeStage: 'alignment',
    selectedObjectId: 'texture-object',
    bakeSets: {
      'texture-object': {
        objectId: 'texture-object',
        low: { name: 'low.fbx', url: '/low.fbx' },
        cage: { name: 'cage.fbx', url: '/cage.fbx' },
        color: { name: 'base.png', url: '/base.png' },
        settings: { resolution: 2048 },
        lastJobId: 'job-1',
      },
      'other-object': untouchedSet,
    },
  },
  assetManifest: {
    models: ['models/texture-source.fbx'],
    references: [],
    generations: [],
    layers: [],
    baked: [],
  },
  settings: {
    resolution: '2K',
    displayMode: 'pbr',
    projectionMode: 'perspective',
    colorManagement: 'srgb',
  },
  activeObjectId: 'texture-object',
};

const frozenProject = deepFreeze(originalProject);
const replacementObject = sceneObject(
  'temporary-loader-id',
  '烘焙专用高模.fbx',
  'blob:temporary-high',
);
const next = replaceBakeHighSnapshot(frozenProject, {
  objectId: 'texture-object',
  asset: {
    name: '烘焙专用高模.fbx',
    url: '/models/bake-high-v2.fbx',
    relativePath: 'models/bake-high-v2.fbx',
  },
  highObject: replacementObject,
});

assert.strictEqual(next.objects, originalProject.objects, 'Texture objects must not be replaced.');
assert.deepEqual(next.objects, originalProject.objects);
assert.equal(next.activeObjectId, originalProject.activeObjectId);
assert.strictEqual(next.layers, originalProject.layers);
assert.deepEqual(next.bakeWorkspace.bakeSets['texture-object'].low, { name: 'low.fbx', url: '/low.fbx' });
assert.equal(next.bakeWorkspace.bakeSets['texture-object'].lastJobId, 'job-1');
assert.strictEqual(next.bakeWorkspace.bakeSets['other-object'], untouchedSet);
assert.equal(next.bakeWorkspace.bakeSets['texture-object'].high.name, '烘焙专用高模.fbx');
assert.equal(next.bakeWorkspace.bakeSets['texture-object'].highObject.id, 'texture-object');
assert.equal(next.bakeWorkspace.bakeSets['texture-object'].highObject.sourcePath, '/models/bake-high-v2.fbx');
assert.notStrictEqual(next.bakeWorkspace.bakeSets['texture-object'].highObject, replacementObject);
assert.notStrictEqual(
  next.bakeWorkspace.bakeSets['texture-object'].highObject.transform,
  replacementObject.transform,
);
assert.deepEqual(next.assetManifest.models, [
  'models/texture-source.fbx',
  'models/bake-high-v2.fbx',
]);

const v3 = replaceBakeHighSnapshot(next, {
  objectId: 'texture-object',
  asset: { name: 'v3.fbx', url: '/models/bake-high-v3.fbx' },
  highObject: sceneObject('another-loader-id', 'v3.fbx', 'blob:v3'),
});
assert.strictEqual(v3.objects, originalProject.objects);
assert.equal(v3.objects[0].name, '贴图源.fbx');
assert.equal(v3.bakeWorkspace.bakeSets['texture-object'].high.name, 'v3.fbx');
assert.deepEqual(
  getBakeHighObjects(v3).map((object) => object.name),
  ['v3.fbx', '其他模型.fbx'],
);
assert.deepEqual(getBakeHighObjects({ ...originalProject, bakeWorkspace: undefined }), []);

const bakePageSource = await readFile(
  new URL('../apps/web/src/routes/BakeWorkspacePage.tsx', import.meta.url),
  'utf8',
);
const highImportSource = bakePageSource.slice(
  bakePageSource.indexOf('async function handleHighImport'),
  bakePageSource.indexOf('function openStage'),
);
assert.equal(highImportSource.includes('setImportedModel('), false);
assert.equal(highImportSource.includes('current.objects.map('), false);
assert.equal(
  bakePageSource.includes('replaceCurrentProject({ ...project, objects: workspaceObjects'),
  false,
);

process.stdout.write(
  'Bake high snapshot smoke passed: high-poly replacement is isolated from texture objects.\n',
);
