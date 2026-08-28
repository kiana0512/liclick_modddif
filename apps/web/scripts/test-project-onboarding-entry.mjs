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
