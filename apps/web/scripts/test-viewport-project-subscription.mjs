import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
// Execute installed Zustand useShallow, replacing only React's hook storage.
const shallowSource = await fs.readFile(require.resolve('zustand/react/shallow'), 'utf8');
const shallowExports = {};
new Function('require', 'exports', shallowSource)(
  (id) => id === 'react' ? { useRef: () => ({ current: undefined }) } : require(id),
  shallowExports,
);
const source = await fs.readFile(new URL('../src/engine/viewport/SceneRoot.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('SceneRoot.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initializer;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'project' &&
      node.initializer?.getText(ast).startsWith('useProjectStore(')) initializer = node.initializer.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert(initializer, 'Find the actual ImportedModel project subscription');
const compiled = ts.transpileModule(`const selected = ${initializer};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const createSelector = () => new Function('useProjectStore', 'useShallow', `${compiled}; return selected;`)(
  (selector) => selector, shallowExports.useShallow,
);
const selectors = Array.from({ length: 9 }, createSelector);
let project = { id: 'a', name: 'A', captures: [{ id: 'capture' }], bakedTextures: [] };
let state = { currentProjectId: 'a', projects: [project] };
let previous = selectors.map((select) => select(state));
let notifications = 0;
for (let i = 0; i < 100; i += 1) {
  project = { ...project, name: `A-${i}`, updatedAt: String(i), activeObjectId: `object-${i}` };
  state = { ...state, projects: [project] };
  selectors.forEach((select, index) => {
    if (!Object.is(select(state), previous[index])) notifications += 1;
  });
}
assert.equal(notifications, 0, 'Unrelated project updates do not invalidate any of nine model subscriptions');
for (const next of [
  { ...project, captures: [...project.captures, { id: 'new-capture' }] },
  { ...project, bakedTextures: [{ id: 'new-texture' }] },
  { ...project, id: 'b' },
  undefined,
  project,
]) {
  state = { currentProjectId: next?.id, projects: next ? [next] : [] };
  previous = selectors.map((select, index) => {
    const value = select(state);
    assert.notEqual(value, previous[index], 'Capture/texture/project/removal/restoration changes remain observable');
    assert.equal(value?.id, next?.id);
    assert.equal(value?.captures, next?.captures);
    assert.equal(value?.bakedTextures, next?.bakedTextures);
    return value;
  });
}
console.log('Viewport project subscription passed: 900 unrelated invalidations -> 0; relevant references and project identity remain live.');
