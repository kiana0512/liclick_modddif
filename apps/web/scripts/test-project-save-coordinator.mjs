import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const editorPageSource = readFileSync(path.join(root, 'src/routes/EditorPage.tsx'), 'utf8');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const id = nextId++;
      timers.set(id, { callback, dueAt: now + delayMs });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const advance = (durationMs) => {
    const target = now + durationMs;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.dueAt;
      timer.callback();
    }
    now = target;
  };
  return { clock, advance };
}

try {
  assert.match(
    editorPageSource,
    /flushProjectLayerSyncRef\.current\(\);[\s\S]*?const snapshot = getProjectSnapshot/,
    'Every save request must flush delayed layer edits before capturing editVersion.',
  );
  assert.match(
    editorPageSource,
    /async function handleManualSave[\s\S]*?getProjectSaveRequest\(\{ refreshThumbnail: false \}\)/,
    'Ctrl+S must not synchronously read back and encode the WebGL thumbnail.',
  );
  const { PROJECT_AUTOSAVE_MAX_WAIT_MS, PROJECT_AUTOSAVE_TRAILING_MS, ProjectSaveCoordinator } =
    await server.ssrLoadModule('/src/services/projectSaveCoordinator.ts');
  const { useProjectStore } = await server.ssrLoadModule('/src/stores/projectStore.ts');

  {
    const { clock, advance } = createFakeClock();
    let saves = 0;
    const coordinator = new ProjectSaveCoordinator(() => {
      saves += 1;
    }, clock);
    coordinator.scheduleEdit();
    advance(PROJECT_AUTOSAVE_TRAILING_MS - 1);
    assert.equal(saves, 0, 'Autosave must wait for the trailing window.');
    coordinator.scheduleEdit();
    advance(PROJECT_AUTOSAVE_TRAILING_MS - 1);
    assert.equal(saves, 0, 'A later edit must reset the trailing window.');
    advance(1);
    assert.equal(saves, 1, 'Autosave must run after editing settles.');
  }

  {
    const { clock, advance } = createFakeClock();
    let saves = 0;
    const coordinator = new ProjectSaveCoordinator(() => {
      saves += 1;
    }, clock);
    coordinator.scheduleEdit();
    for (let elapsed = 1_000; elapsed < PROJECT_AUTOSAVE_MAX_WAIT_MS; elapsed += 1_000) {
      advance(1_000);
      coordinator.scheduleEdit();
    }
    advance(1_000);
    assert.equal(saves, 1, 'Continuous edits must not postpone autosave beyond maxWait.');
  }

  const projectId = 'project-save-coordinator-test';
  const project = {
    id: projectId,
    name: 'Save coordinator test',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    objects: [],
    references: [],
    captures: [],
    generations: [],
    layers: [],
    bakedTextures: [],
    resolution: '2K',
    workspaceMode: 'local-server',
    thumbnail: '/assets/original-thumbnail.png',
    dirty: false,
  };
  useProjectStore.getState().setProjects([project]);
  useProjectStore.getState().setCurrentProject(projectId);
  assert.equal(useProjectStore.getState().getProjectEditVersion(projectId), 0);

  useProjectStore.getState().updateCurrentProject({ name: 'Edited once' });
  assert.equal(useProjectStore.getState().getProjectEditVersion(projectId), 1);
  assert.equal(useProjectStore.getState().getCurrentProject().dirty, true);

  const staleCompleted = useProjectStore
    .getState()
    .completeProjectSaveById(
      projectId,
      0,
      { revision: { id: 'revision-stale', number: 1, savedAt: '2026-08-27T00:01:00.000Z' } },
      { thumbnail: '/assets/stale-thumbnail.png' },
    );
  assert.equal(staleCompleted, false);
  assert.equal(
    useProjectStore.getState().getCurrentProject().dirty,
    true,
    'A stale save response must not clear dirty state.',
  );
  assert.equal(
    useProjectStore.getState().getCurrentProject().thumbnail,
    '/assets/original-thumbnail.png',
    'A stale save response must not overwrite latest-only fields.',
  );

  const latestCompleted = useProjectStore
    .getState()
    .completeProjectSaveById(
      projectId,
      1,
      { revision: { id: 'revision-latest', number: 2, savedAt: '2026-08-27T00:02:00.000Z' } },
      { thumbnail: '/assets/latest-thumbnail.png' },
    );
  assert.equal(latestCompleted, true);
  assert.equal(useProjectStore.getState().getCurrentProject().dirty, false);
  assert.equal(
    useProjectStore.getState().getCurrentProject().thumbnail,
    '/assets/latest-thumbnail.png',
  );

  useProjectStore.getState().markProjectEdited(projectId);
  assert.equal(useProjectStore.getState().getProjectEditVersion(projectId), 2);
  assert.equal(useProjectStore.getState().getCurrentProject().dirty, true);

  useProjectStore.getState().addCapture({ id: 'capture-version-test' });
  assert.equal(
    useProjectStore.getState().getProjectEditVersion(projectId),
    3,
    'Direct store mutations must advance the same edit version.',
  );

  stdout.write('Project save coordinator regression test passed.\n');
} finally {
  await server.close();
}
