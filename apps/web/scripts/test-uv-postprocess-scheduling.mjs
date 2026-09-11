import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/engine/bake/bakeProjectedLayerToTexture.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('bake.ts', source, ts.ScriptTarget.Latest, true);
let declaration;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'yieldPostprocess') declaration = node;
  ts.forEachChild(node, visit);
}
visit(tree);
assert(declaration?.initializer);
const js = ts.transpileModule('const pause = ' + declaration.initializer.getText(tree), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
let cancelled = false, resume, yields = 0;
const input = { checkCancelled() { if (cancelled) throw new DOMException('Superseded', 'AbortError'); } };
const yieldToUi = () => { yields++; return new Promise(resolve => { resume = resolve; }); };
const pause = new Function('input', 'isViewportInteractionBusy', 'waitForBrowserPaint', 'yieldToBrowserTask', js + '; return pause;')(
  input, () => false, yieldToUi, yieldToUi,
);
// A superseded job must not wait for another slice or execute pixels after the
// browser has delivered the newer eye gesture during its cooperative yield.
cancelled = true;
await assert.rejects(pause(), { name: 'AbortError' });
assert.equal(yields, 0);
cancelled = false;
let continued = false;
const pending = pause().then(() => { continued = true; });
assert.equal(yields, 1);
cancelled = true; resume();
await assert.rejects(pending, { name: 'AbortError' });
assert.equal(continued, false);
cancelled = false;
const current = pause(); resume(); await current;
assert.equal(yields, 2);
console.log('UV postprocess scheduling: stale requests stop before/after yielding; current requests resume.');

// Execute the queue consumer's real preflight: a request superseded while
// waiting behind another bake must not flush pending UV work or load assets.
const bake = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'bakeVisibleProjectedLayersToTextureUnlocked');
const preflight = bake.body.statements.slice(0, 3).map(node => node.getText(tree)).join('\n');
const runPreflight = new Function('input', 'flushLiveUvCommits', ts.transpileModule(
  'return (async () => {' + preflight + '})();', { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText);
let flushes = 0;
const flush = () => { flushes++; return new Promise(resolve => { resume = resolve; }); };
cancelled = true;
await assert.rejects(runPreflight(input, flush), { name: 'AbortError' });
assert.equal(flushes, 0);
cancelled = false;
const preflightPending = runPreflight(input, flush);
cancelled = true; resume();
await assert.rejects(preflightPending, { name: 'AbortError' });
assert.equal(flushes, 1);
