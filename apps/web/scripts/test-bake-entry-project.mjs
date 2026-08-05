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
