import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bakeWorkspaceSource = readFileSync(path.join(root, 'src/routes/BakeWorkspacePage.tsx'), 'utf8');

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
  /async function handleLowImport[\s\S]*?await persistImportedFiles\('low', assigned\)[\s\S]*?if \(!saved\)[\s\S]*?setActiveStage\('alignment'\)/,
  'Low-poly import must await persistence and only advance after a successful save.',
);
assert.match(
  bakeWorkspaceSource,
  /async function handleColorImport[\s\S]*?await persistImportedFiles\('color', assigned\)[\s\S]*?if \(!saved\)/,
  'Base Color import must await persistence and roll back its preview when saving fails.',
);
assert.match(
  bakeWorkspaceSource,
  /async function handleMaterialChannelImport[\s\S]*?await persistImportedFiles\(kind, assigned\)[\s\S]*?if \(!saved\)/,
  'Material-channel imports must await persistence and roll back their previews when saving fails.',
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
