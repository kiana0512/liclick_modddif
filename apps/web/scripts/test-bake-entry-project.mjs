import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bakeWorkspaceSource = readFileSync(
  path.join(root, 'src/routes/BakeWorkspacePage.tsx'),
  'utf8',
);
const bakeAnalysisSource = readFileSync(
  path.join(root, 'src/features/bake/useBakeModelAnalysis.ts'),
  'utf8',
);
const bakeOverlaySource = readFileSync(
  path.join(root, 'src/features/bake/BakeSceneOverlay.tsx'),
  'utf8',
);
const gltfLoaderSource = readFileSync(
  path.join(root, 'src/engine/loaders/loadGltfModel.ts'),
  'utf8',
);

assert.match(
  bakeWorkspaceSource,
  /function openBakeFilePicker[\s\S]*?input\.showPicker\(\)[\s\S]*?input\.click\(\)/,
  'Bake file controls must prefer the trusted native picker and retain a compatibility fallback.',
);
assert.match(
  bakeWorkspaceSource,
  /pickerInput=\{\s*<input[\s\S]*?id=\{bakeFileInputIds\.low\}[\s\S]*?className="absolute inset-0 z-30 h-full w-full cursor-pointer opacity-0"[\s\S]*?aria-label="选择低模文件"/,
  'The one-click low-poly card must be covered by the real native file input.',
);
assert.match(
  bakeWorkspaceSource,
  /function MaterialMapSlot[\s\S]*?<div className="relative flex w-full items-center gap-4 px-4 py-3\.5 text-left">\s*\{pickerInput\}/,
  'Material-map slots must embed the real native file input over the clickable row.',
);
assert.equal(
  bakeWorkspaceSource.match(
    /className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"/g,
  )?.length,
  4,
  'Base Color, Roughness, Metallic and Normal must each use a direct native picker overlay.',
);
assert.match(
  bakeWorkspaceSource,
  /async function handleLowImport[\s\S]*?setLowFiles[\s\S]*?await Promise\.all\([\s\S]*?inspectBakeModel[\s\S]*?void persistImportedFiles\('low', assigned/,
  'Low-poly import must acknowledge the local file immediately, validate it, and only then persist it.',
);
assert.match(
  bakeWorkspaceSource,
  /setColorFiles\(\(current\) => \(\{ \.\.\.restoredColor, \.\.\.current \}\)\)[\s\S]*?setRoughnessFiles\(\(current\) => \(\{ \.\.\.roughness\.files, \.\.\.current \}\)\)[\s\S]*?setMetallicFiles\(\(current\) => \(\{ \.\.\.metallic\.files, \.\.\.current \}\)\)[\s\S]*?setNormalFiles\(\(current\) => \(\{ \.\.\.normal\.files, \.\.\.current \}\)\)/,
  'Late server hydration must not overwrite newer local material-map selections.',
);
assert.match(
  bakeWorkspaceSource,
  /const bakeFeedback =\s*bakeError \?\?/,
  'Import errors must be visible without requiring a bake submission first.',
);
assert.match(
  bakeWorkspaceSource,
  /id=\{bakeFileInputIds\.low\}[\s\S]*?accept="\.fbx,\.obj,\.glb,\.gltf,\.bin,\.mtl,image\/\*"[\s\S]*?disabled=\{lowImporting\}/,
  'Low-poly import must accept the same model companion resources and loading lifecycle as high-poly import.',
);
assert.match(
  bakeAnalysisSource,
  /loadModelFromFile\([\s\S]*?resourceFiles,\s*\)[\s\S]*?inputs\.map\(inspectBakeModel\)/,
  'Low-poly inspection must resolve companion resources through the shared model loader.',
);
assert.match(
  bakeOverlaySource,
  /useOverlaySource\(lowFile, lowResourceFiles\)/,
  'The bake overlay must use the same companion resources as low-poly inspection.',
);
assert.match(
  gltfLoaderSource,
  /createGltfLoadingManager\(options\.resourceFiles \?\? \[\]\)[\s\S]*?new GLTFLoader\(resourceManager\.manager\)/,
  'External GLTF buffers and textures must resolve from the selected companion files.',
);
assert.match(
  bakeWorkspaceSource,
  /function handleColorImport[\s\S]*?setColorFiles[\s\S]*?void persistImportedFiles\('color', assigned, \{ selectedObjectId: targetObjectId \}\)/,
  'Base Color import must display immediately while persistence continues.',
);
assert.match(
  bakeWorkspaceSource,
  /function handleMaterialChannelImport[\s\S]*?setRoughnessFiles[\s\S]*?setMetallicFiles[\s\S]*?setNormalFiles[\s\S]*?void persistImportedFiles\(kind, assigned/,
  'Material-channel imports must display immediately while persistence continues.',
);
assert.match(
  bakeWorkspaceSource,
  /function resolveImportTargetId[\s\S]*?`bake-target-\$\{projectId\}`[\s\S]*?fileTargetIdRef\.current = targetObjectId[\s\S]*?setSelectedObjectId\(targetObjectId\)/,
  'Bake assets imported before a high-poly model must share a stable pending Bake Set id.',
);
assert.match(
  bakeWorkspaceSource,
  /function assignImportedFiles[\s\S]*?highObjects\.length > 0[\s\S]*?assignFilesToObjects[\s\S]*?\{ \[targetObjectId\]: files\[0\] \}/,
  'Low-poly and material files must remain assignable before a high-poly model exists.',
);
assert.doesNotMatch(
  bakeWorkspaceSource,
  /请先导入高模，再(?:为它添加对应的低模|添加对应的颜色贴图|添加对应的材质贴图)/,
  'Import handlers must not enforce a high-poly-first ordering.',
);
assert.match(
  bakeWorkspaceSource,
  /async function handleLowImport[\s\S]*?resolveImportTargetId\(\)[\s\S]*?assignImportedFiles\(modelFiles, targetObjectId\)/,
  'Low-poly import must use the order-independent Bake Set assignment.',
);
assert.match(
  bakeWorkspaceSource,
  /function handleColorImport[\s\S]*?resolveImportTargetId\(\)[\s\S]*?assignImportedFiles\(imageFiles, targetObjectId\)/,
  'Base Color import must use the order-independent Bake Set assignment.',
);
assert.match(
  bakeWorkspaceSource,
  /function handleMaterialChannelImport[\s\S]*?resolveImportTargetId\(\)[\s\S]*?assignImportedFiles\(imageFiles, targetObjectId\)/,
  'Material-channel imports must use the order-independent Bake Set assignment.',
);
assert.match(
  bakeWorkspaceSource,
  /objectId = firstNonEmptyId\([\s\S]*?loaded\.object\.id[\s\S]*?if \(!objectId\) throw new Error/,
  'High-poly import must never persist a Bake Set under an empty object id.',
);
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

function summary(id, updatedAt) {
  return {
    id,
    name: id,
    createdAt: updatedAt,
    updatedAt,
    thumbnail: '',
    local: true,
    slug: id,
  };
}

try {
  const { resolveBakeEntryProject, selectMostRecentProject } = await server.ssrLoadModule(
    '/src/features/workflow/resolveBakeEntryProject.ts',
  );
  const { normalizeBakeWorkspaceObjectIds, replaceBakeHighSnapshot } = await server.ssrLoadModule(
    '/src/services/bakeHighSnapshot.ts',
  );

  const legacyBakeProject = {
    id: 'legacy-empty-id',
    activeObjectId: '',
    objects: [],
    bakeWorkspace: {
      version: 1,
      activeStage: 'assets',
      selectedObjectId: '',
      bakeSets: {
        '': {
          objectId: '',
          high: { name: 'high.fbx', url: '/high.fbx' },
          highObject: { id: '', name: 'high.fbx' },
          low: { name: 'low.fbx', url: '/low.fbx' },
          color: { name: 'color.png', url: '/color.png' },
        },
      },
    },
  };
  const repairedBakeProject = normalizeBakeWorkspaceObjectIds(legacyBakeProject);
  const repairedId = 'bake-target-legacy-empty-id';
  assert.equal(repairedBakeProject.bakeWorkspace.selectedObjectId, repairedId);
  assert.equal(repairedBakeProject.bakeWorkspace.bakeSets[repairedId].objectId, repairedId);
  assert.equal(repairedBakeProject.bakeWorkspace.bakeSets[repairedId].highObject.id, repairedId);
  assert.equal(repairedBakeProject.bakeWorkspace.bakeSets[repairedId].low.name, 'low.fbx');
  assert.equal(repairedBakeProject.bakeWorkspace.bakeSets[repairedId].color.name, 'color.png');
  assert.equal(
    repairedBakeProject.bakeWorkspace.bakeSets[''],
    undefined,
    'Legacy empty Bake Set keys must be removed after normalization.',
  );

  const pendingObjectId = 'bake-target-order-independent';
  const pendingBakeProject = {
    id: 'order-independent',
    bakeWorkspace: {
      version: 1,
      activeStage: 'assets',
      selectedObjectId: pendingObjectId,
      bakeSets: {
        [pendingObjectId]: {
          objectId: pendingObjectId,
          low: { name: 'low-first.glb', url: '/low-first.glb' },
          color: { name: 'color-first.png', url: '/color-first.png' },
        },
      },
    },
  };
  const mergedHighProject = replaceBakeHighSnapshot(pendingBakeProject, {
    objectId: pendingObjectId,
    asset: { name: 'high-last.glb', url: '/high-last.glb' },
    highObject: {
      id: 'temporary-loaded-id',
      name: 'high-last.glb',
      type: 'mesh',
      format: 'glb',
      visible: true,
      selected: true,
      materialSlots: [],
      uvSets: [],
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    },
  });
  assert.equal(mergedHighProject.bakeWorkspace.bakeSets[pendingObjectId].high.name, 'high-last.glb');
  assert.equal(mergedHighProject.bakeWorkspace.bakeSets[pendingObjectId].low.name, 'low-first.glb');
  assert.equal(
    mergedHighProject.bakeWorkspace.bakeSets[pendingObjectId].color.name,
    'color-first.png',
    'Importing the high-poly model last must retain low-poly and texture assets imported first.',
  );
  assert.equal(mergedHighProject.bakeWorkspace.activeStage, 'alignment');

  const cachedProject = { id: 'cached-project' };
  let listCalls = 0;
  let loadCalls = 0;
  const cachedResult = await resolveBakeEntryProject(cachedProject, {
    listProjects: async () => {
      listCalls += 1;
      return { projects: [] };
    },
    loadProject: async () => {
      loadCalls += 1;
      return { project: { id: 'unexpected' } };
    },
  });
  assert.equal(cachedResult, cachedProject);
  assert.equal(listCalls, 0, 'A hydrated current project must not trigger a list request.');
  assert.equal(loadCalls, 0, 'A hydrated current project must not be loaded again.');

  const remoteProjects = [
    summary('older-project', '2026-08-03T10:00:00.000Z'),
    summary('newest-project', '2026-08-05T10:00:00.000Z'),
    summary('middle-project', '2026-08-04T10:00:00.000Z'),
  ];
  assert.equal(selectMostRecentProject(remoteProjects).id, 'newest-project');

  let loadedProjectId = '';
  const coldResult = await resolveBakeEntryProject(undefined, {
    listProjects: async () => ({ projects: remoteProjects }),
    loadProject: async (projectId) => {
      loadedProjectId = projectId;
      return { project: { id: projectId, objects: ['hydrated'] } };
    },
  });
  assert.equal(loadedProjectId, 'newest-project');
  assert.deepEqual(coldResult, { id: 'newest-project', objects: ['hydrated'] });

  assert.equal(
    selectMostRecentProject([
      summary('project-b', '2026-08-05T10:00:00.000Z'),
      summary('project-a', '2026-08-05T10:00:00.000Z'),
    ]).id,
    'project-a',
    'Equal timestamps must use a deterministic project id tie-breaker.',
  );
  assert.equal(
    selectMostRecentProject([
      summary('invalid-b', 'not-a-date'),
      summary('invalid-a', 'also-not-a-date'),
    ]).id,
    'invalid-a',
    'Invalid timestamps must still use the deterministic tie-breaker.',
  );

  let emptyLoadCalls = 0;
  const emptyResult = await resolveBakeEntryProject(undefined, {
    listProjects: async () => ({ projects: [] }),
    loadProject: async () => {
      emptyLoadCalls += 1;
      return { project: { id: 'unexpected' } };
    },
  });
  assert.equal(emptyResult, undefined);
  assert.equal(emptyLoadCalls, 0, 'An empty workspace must not issue a project load request.');

  await assert.rejects(
    resolveBakeEntryProject(undefined, {
      listProjects: async () => {
        throw new Error('workspace unavailable');
      },
      loadProject: async () => ({ project: { id: 'unexpected' } }),
    }),
    /workspace unavailable/,
  );

  stdout.write('Bake entry project regression test passed.\n');
} finally {
  await server.close();
}
