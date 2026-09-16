import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'src');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const projectsPage = read('routes/ProjectsPage.tsx');
const app = read('App.tsx');
const editor = read('routes/EditorPage.tsx');
const tour = read('components/editor/TextureOnboardingTour.tsx');

assert.match(
  projectsPage,
  /onOpenProject\(result\.project\.id, \{ showOnboarding: module === 'texture' \}\)/,
  '新建贴图项目必须显式请求新人引导，不能只依赖服务器时间戳',
);
assert.match(app, /showOnboarding\?: boolean/, '路由状态必须携带新人引导意图');
assert.match(editor, /forceStart=\{showOnboarding\}/, '编辑器必须把路由意图交给引导组件');
assert.match(
  tour,
  /forceStart \|\| new URLSearchParams\(window\.location\.search\)/,
  '引导组件必须优先响应显式的新项目入口',
);

console.log('新建贴图项目新人引导入口回归通过。');

// Exercise the real progress/migration and placement functions, not duplicate logic.
const { createServer } = await import('vite');
const server = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { middlewareMode: true },
  appType: 'custom',
});
try {
  const { loadTour, saveTour, nextTour, tutorials, placeTourCard, tourStorageKey } =
    await server.ssrLoadModule(path.join(root, 'engine/onboarding/textureOnboarding.ts'));
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(tutorials.basic.length, 3);
  assert.equal(tutorials.repaint.at(-1).confirm, true);
  let progress = loadTour(storage, 'new', true);
  assert.equal(progress.status, 'active');
  progress = nextTour(progress);
  saveTour(storage, 'new', { ...progress, status: 'paused' });
  assert.deepEqual(loadTour(storage, 'new', true), { ...progress, status: 'paused' });
  assert.equal(loadTour(storage, 'different-project', true).step, 0);
  assert.equal(nextTour(nextTour(progress)).status, 'done');
  for (const version of [1, 2]) {
    for (const legacy of ['done', '3', '4', '5']) {
      const id = `legacy-${version}-${legacy}`;
      values.set(`li3d:texture-onboarding:v${version}:${id}`, legacy);
      assert.equal(loadTour(storage, id, true).status, 'done');
    }
    const id = `resume-v${version}`;
    values.set(`li3d:texture-onboarding:v${version}:${id}`, '1');
    assert.equal(loadTour(storage, id, true).step, 1);
    assert.equal(loadTour(storage, id, true).status, 'paused');
  }
  values.set(tourStorageKey('invalid'), '{broken');
  assert.equal(loadTour(storage, 'invalid', false).status, 'paused');
  values.set(
    tourStorageKey('bad-index'),
    JSON.stringify({ track: 'basic', step: 99, status: 'active', review: false }),
  );
  assert.equal(loadTour(storage, 'bad-index', true).step, 0);
  const unavailable = {
    getItem() {
      throw Error('denied');
    },
    setItem() {
      throw Error('quota');
    },
  };
  saveTour(unavailable, 'fallback', { ...progress, status: 'paused' });
  assert.equal(loadTour(unavailable, 'fallback', true).status, 'paused');
  const rect = { left: 20, top: 200, right: 250, bottom: 350, width: 230, height: 150 };
  const position = placeTourCard(rect, 304, 220, 1000, 700);
  assert.ok(position.left > rect.right);
  assert.equal(
    placeTourCard({ left: 8, top: 8, right: 350, bottom: 620 }, 304, 220, 360, 640).compact,
    true,
  );
  assert.doesNotMatch(tour, /先清空当前图层/);
  assert.match(editor, /suspended=\{editorTaskRunning\}/);
  assert.match(editor, /key=\{project.id\}[\s\S]{0,180}forceStart=\{showOnboarding\}/);
  console.log(
    'Onboarding: migration, pause/remount, project isolation, completion and placement passed.',
  );
} finally {
  await server.close();
}
