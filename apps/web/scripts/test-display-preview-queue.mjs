import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const { AbortController } = globalThis;

const read = (path) => fs.readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const source = read('engine/localRepaint/displayPreviewQueue.ts');
let busy = true;
const timers = new Map();
let nextTimer = 0;
const doc = { visibilityState: 'visible' };
const js = ts.transpileModule(source.replace(/^import .*;\r?\n/gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const exports = {};
new Function('exports', 'isViewportInteractionBusy', 'setTimeout', 'clearTimeout', 'document', js)(
  exports, () => busy,
  (fn) => { timers.set(++nextTimer, fn); return nextTimer; },
  (id) => timers.delete(id), doc,
);
const tick = async () => {
  const callbacks = [...timers.values()]; timers.clear();
  callbacks.forEach((fn) => void fn());
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const value = (name) => ({ alignedUrl: name, fittedUrl: name });
const queue = exports.createDisplayPreviewQueue();
let runs = 0;
const cancelled = [];
for (let i = 0; i < 71; i++) {
  const controller = new AbortController();
  cancelled.push(queue(`old-${i}`, async () => { runs++; return value('old'); }, controller.signal)
    .then(() => assert.fail('cancelled consumer resolved'), (error) => assert.equal(error.name, 'AbortError')));
  controller.abort();
}
await tick(); await Promise.all(cancelled);
assert.equal(runs, 0, '71 obsolete selections must perform zero image work');
assert.equal(timers.size, 0, 'no timer retained for an empty queue');
const a = new AbortController(), b = new AbortController();
const p1 = queue('shared', async () => { runs++; return value('shared'); }, a.signal).catch((e) => e.name);
const p2 = queue('shared', async () => assert.fail('duplicate job'), b.signal);
a.abort(); await tick();
assert.equal(runs, 0, 'foreground interaction owns the frame');
busy = false; await tick();
assert.equal(await p1, 'AbortError'); assert.deepEqual(await p2, value('shared'));
assert.equal(runs, 1, 'cancelling one consumer must preserve the other');
assert.deepEqual(await queue('shared', async () => assert.fail('cache miss')), value('shared'));

// Cancel a running job, then immediately reacquire the same key. Its late
// completion must neither cache stale pixels nor delete the replacement job.
let finishOld;
const old = new AbortController();
const oldPromise = queue('replace', () => new Promise((resolve) => { finishOld = resolve; }), old.signal)
  .catch((error) => error.name);
await tick(); old.abort();
let replacementRuns = 0;
const replacement = queue('replace', async () => { replacementRuns++; return value('new'); });
await tick(); assert.equal(replacementRuns, 0, 'one running job at a time');
finishOld(value('stale')); await tick(); await tick();
assert.equal(await oldPromise, 'AbortError');
assert.deepEqual(await replacement, value('new'));
assert.deepEqual(await queue('replace', async () => assert.fail('late old task evicted cache')), value('new'));

// 27 previews from nine models fit; cache hits refresh recency. Revision,
// source and depth identities are separate keys, not mutable model selection.
for (let i = 0; i < 27; i++) { const p = queue(`image-${i}`, async () => value(`${i}`)); await tick(); await p; }
for (let i = 0; i < 27; i++) await queue(`image-${i}`, async () => assert.fail('nine-model cache thrash'));
const tiny = exports.createDisplayPreviewQueue(28, 2);
const put = async (key) => { const p = tiny(key, async () => value(key)); await tick(); return p; };
await put('a'); await put('b'); await tiny('a', async () => assert.fail('LRU hit'));
await put('c');
await tiny('a', async () => assert.fail('recent entry evicted'));
let reloaded = 0;
const reload = tiny('b', async () => { reloaded++; return value('b'); }); await tick(); await reload;
assert.equal(reloaded, 1);
let largeRuns = 0;
for (let i = 0; i < 2; i++) {
  const p = tiny('huge', async () => { largeRuns++; return value('x'.repeat(100)); }); await tick(); await p;
}
assert.equal(largeRuns, 2, 'over-budget values must not be retained');
const failure = queue('retry', async () => { throw new Error('decode'); }).catch((e) => e.message);
await tick(); assert.equal(await failure, 'decode');
const retry = queue('retry', async () => value('ok')); await tick(); assert.deepEqual(await retry, value('ok'));
busy = true; doc.visibilityState = 'hidden';
const hidden = queue('hidden', async () => value('background')); await tick();
assert.deepEqual(await hidden, value('background'), 'no background rAF dependency');

const editor = read('routes/EditorPage.tsx');
const effect = editor.slice(editor.indexOf('const layerPanelOwnerRef'), editor.indexOf('function handleManualSaveShortcut'));
let owner = 'model-0', opened = 0;
const run = new Function('activeProjectedLayerId', 'activeLayer', 'layerPanelOwnerRef', 'showPanel', 'setPanelCollapsed',
  ts.transpileModule(effect.slice(effect.indexOf('useEffect(() => {') + 17, effect.indexOf('}, [activeProjectedLayerId')),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
const ref = { current: owner };
for (let i = 1; i <= 71; i++) {
  owner = `model-${i % 9}`;
  run(`layer-${i}`, { objectId: owner }, ref, () => opened++, () => opened++);
}
assert.equal(opened, 0, 'model restoration must preserve collapsed panels');
run('explicit-layer', { objectId: owner }, ref, () => opened++, () => opened++);
assert.equal(opened, 2, 'explicit same-model layer selection still opens the panel');
const panel = read('components/panels/GeneratePanel.tsx');
assert.match(panel, /!previewProcessingVisible \|\| !sourceUrl \|\| !previewProcessingMode/);
assert.match(panel, /generatePanelExpanded && displayedTexturePreviewMode !== 'multi'/);
assert.match(panel, /cancelled = true;\s*controller.abort\(\);/);
assert.match(read('engine/localRepaint/resultPreviewUtils.ts'), /\['display', sourceUrl, depthUrl, request.revision\]/);
console.log('Display preview scheduling, cancellation, LRU/byte budget and panel ownership passed.');

// Run the real panel hook: thumbnail and zoom consumers stay separate, and
// neither a source/revision change nor a late cancelled job can show old pixels.
const layerSource = read('components/panels/LayersPanel.tsx');
const hookTree = ts.createSourceFile('panel.tsx', layerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const hook = hookTree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'useProjectedLayerDisplayPreview').getText(hookTree);
let previewState, dependencies, pendingEffect, cleanup;
const requests = [];
const request = kind => (...args) => new Promise((resolve, reject) => requests.push({kind,args,resolve,reject}));
const render = new Function('useState','useEffect','createLayerThumbnail','createGeneratedDisplayPreview','isLocalRepaintPreviewLayer','getLiveProjectedTextureSourceState',
  ts.transpileModule(hook,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText + '\nreturn useProjectedLayerDisplayPreview;')(
  () => [previewState, value => {previewState=value;}],
  (callback, deps) => {if (!dependencies || deps.some((v,i) => v !== dependencies[i])) {pendingEffect=callback; dependencies=deps;}},
  request('thumbnail'),request('full'), layer => Boolean(layer.localRepaintMaskUrl), url => url.startsWith('live:') ? {} : undefined,
);
const effects = () => {if(pendingEffect){cleanup?.(); cleanup=pendingEffect(); pendingEffect=undefined;}};
const layer = {type:'projected',imageUrl:'image',depthUrl:'depth',contentRevision:1};
assert.equal(render(layer,true),undefined); effects();
assert.equal(requests[0].kind,'thumbnail');
assert.equal(requests[0].args[3],true);
requests[0].resolve(value('small')); await tick();
assert.equal(render(layer,true).fittedUrl,'small');
const revised = {...layer,contentRevision:2};
assert.equal(render(revised,true),undefined,'A new revision never paints the previous thumbnail'); effects();
assert.equal(render({...revised,imageUrl:'replacement'},true),undefined); effects();
assert(requests[1].args[2].signal.aborted);
requests[1].resolve(value('stale')); await tick();
assert.equal(render({...revised,imageUrl:'replacement'},true),undefined);
requests[2].resolve(value('current')); await tick();
assert.equal(render({...revised,imageUrl:'replacement'},true).fittedUrl,'current');
assert.equal(render(layer,false),undefined); effects();
assert.equal(requests.at(-1).kind,'full','Zoom keeps the original complete display pipeline');
requests.at(-1).resolve(value('full')); await tick();
assert.equal(render(layer,false).fittedUrl,'full');
for (const excluded of [{...layer,localRepaintMaskUrl:'author-mask'}, {...layer,type:'uv',imageUrl:'live:canvas'}]) {
  const count=requests.length; assert.equal(render(excluded,true),undefined); effects();
  assert.equal(requests.length,count,'Authored/live masks retain the existing canvas path');
}
render({...layer,type:'uv'},true); effects();
assert.equal(requests.at(-1).args[3],false,'UV thumbnails skip generated-image masking');
requests.at(-1).reject(new Error('decode failure')); await tick();
assert.equal(render({...layer,type:'uv'},true).fittedUrl,'image','Failure retains the original image fallback');
cleanup?.();
assert.match(layerSource,/if \(!isLocalRepaintPreview\) return null;/,'Pending thumbnails must not start a full-resolution img decode');
console.log('Layer thumbnail ownership passed: revision/type/mode identity, cancellation, live masks, zoom and error fallback.');
