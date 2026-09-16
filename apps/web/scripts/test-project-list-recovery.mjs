import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await fs.readFile(new URL('../src/routes/ProjectsPage.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('ProjectsPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let refresh;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'refreshWorkspace') refresh = node.getText(parsed);
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.ok(refresh);
class WorkspaceApiError extends Error { constructor(status) { super('request failed'); this.status = status; } }
const previous = [{ id: 'existing-project' }];
let projects = previous;
let notice;
let state;
let pending;
let failure = new Error('Connection terminated unexpectedly');
let calls = 0;
const context = vm.createContext({
  WorkspaceApiError,
  getWorkspaceHealth: async () => {},
  listProjects: async () => { calls++; if (failure) throw failure; return { projects: [{ id: 'restored-project' }] }; },
  listFolders: async () => ({ folders: [] }),
  setFolders: () => {},
  setProjects: value => { projects = value; },
  setPageNotice: value => { notice = value; },
  setServerState: value => { state = value; },
  setWorkspaceRefreshing: value => { pending = value; },
  projectFromSummary: value => value,
  mergeWorkspaceProjects: value => value,
  useProjectStore: { getState: () => ({ projects }) },
  pushToast: () => {},
  t: key => key,
});
vm.runInContext(ts.transpileModule(refresh, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
await context.refreshWorkspace(true);
assert.equal(state, 'offline');
assert.equal(projects, previous, 'A failed list request must not replace cached projects with an empty list');
assert.equal(notice.title, 'workspaceOfflineToast');
assert.equal(pending, false);
assert.equal(calls, 1, 'No automatic request loop');
failure = undefined;
await context.refreshWorkspace(true);
assert.equal(state, 'online');
assert.equal(projects[0].id, 'restored-project');
assert.equal(notice, undefined);
assert.equal(pending, false);
failure = new WorkspaceApiError(401);
await context.refreshWorkspace(true);
assert.equal(notice.title, '需要飞书登录');
assert.equal(state, 'online');
assert.equal(pending, false);
assert.match(source, /disabled=\{workspaceRefreshing\}/);
assert.match(source, /onClick=\{\(\) => void refreshWorkspace\(true\)\}/);
const translations = await fs.readFile(new URL('../src/stores/i18nStore.ts', import.meta.url), 'utf8');
assert.doesNotMatch(translations, /Keep the Liclick launcher terminal open|请保持 Liclick 启动终端开启/);
console.log('Project list recovery passed: failure preserves cache, explicit retry recovers, auth remains separate.');
