import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const schedulerSource = ts.transpileModule(read('utils/browserScheduling.ts'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
}}).outputText;
function environment(visibility) {
  const timers = new Map();
  const frames = new Map();
  let id = 0;
  const document = { visibilityState: visibility };
  const window = {
    requestAnimationFrame: (fn) => { frames.set(++id, fn); return id; },
    cancelAnimationFrame: (key) => frames.delete(key),
    setTimeout: (fn) => { timers.set(++id, fn); return id; },
    clearTimeout: (key) => timers.delete(key),
  };
  const exports = {};
  new Function('exports', 'window', 'document', schedulerSource)(exports, window, document);
  return { ...exports, document, timers, frames, tick() {
    const tasks = [...timers.values()];
    timers.clear();
    tasks.forEach((fn) => fn());
  } };
}

// Execute the two production submit barriers using the actual shared scheduler.
const panel = read('components/panels/GeneratePanel.tsx');
const barriers = panel.slice(panel.indexOf('// Commit the button state and progress text'), panel.indexOf('// ModelView receives one square 2K composite'));
assert.doesNotMatch(barriers, /requestAnimationFrame/);
assert.equal((barriers.match(/await waitForBrowserPaint\(\)/g) ?? []).length, 2);
for (const initialVisibility of ['hidden', 'visible']) {
  const env = environment(initialVisibility);
  let submitted = false;
  const submit = new Function('waitForBrowserPaint', `return async () => { ${barriers} };`)(env.waitForBrowserPaint);
  const pending = submit().then(() => { submitted = true; });
  env.document.visibilityState = 'hidden'; // Covers hiding after rAF was queued.
  for (let i = 0; i < 6; i++) { env.tick(); await Promise.resolve(); }
  await pending;
  assert(submitted, 'Submission must pass both barriers without any animation callback');
  assert.equal(env.frames.size, 0, 'Fallback must cancel suspended animation callbacks');
}
const hidden = environment('hidden');
let starts = 0;
const cancel = hidden.scheduleAfterBrowserPaint(() => { starts++; });
cancel(); hidden.tick();
assert.equal(starts, 0, 'Cancelled GPU bootstrap must not start');
hidden.scheduleAfterBrowserPaint(() => { starts++; });
hidden.tick(); hidden.tick();
assert.equal(starts, 1, 'Background bootstrap must run exactly once');
const visible = environment('visible');
let continuations = 0;
visible.scheduleAfterBrowserPaint(() => { continuations++; });
const queuedFrame = [...visible.frames.values()][0];
queuedFrame(); visible.tick(); visible.tick();
assert.equal(continuations, 1, 'Paint and fallback racing must not duplicate work');

const viewport = read('engine/viewport/ViewportCanvas.tsx');
const preparation = viewport.slice(viewport.indexOf('const finishGpuPreparation = trackLocalRepaintPreparation'), viewport.indexOf('bindLocalRepaintResidentMaskOverride,', viewport.indexOf('const finishGpuPreparation = trackLocalRepaintPreparation')));
assert.match(preparation, /const waitForFrame = waitForBrowserPaint/);
assert.match(preparation, /const cancelStart = scheduleAfterBrowserPaint/);
assert.match(preparation, /cancelStart\(\)/);
assert.doesNotMatch(preparation, /window\.requestAnimationFrame/);
assert.match(preparation, /isPaintingRef\.current/); // Do not bypass unfinished strokes.
assert.match(preparation, /preparationDeadline/); // Keep bounded failure handling.
console.log('Local repaint background scheduling passed: hidden-at-start, hidden-after-queue, no-rAF submission, cancellation and exactly-once bootstrap.');

// Run the actual GPU upload sequence; an idle Promise alone does not yield a
// frame. Keep cancellation between uploads and no-rAF fallback operational.
const uploads = preparation.slice(preparation.indexOf('if (sourceTexture) gl.initTexture'),
  preparation.indexOf('const preparedComposite = composite;'));
assert.equal((uploads.match(/gl.initTexture/g) ?? []).length, 3);
const runUploads = (waitForFrame, cancelAtFrame = Infinity, sourceTexture = 'source') => {
  const calls = [];
  let frame = 0;
  const run = new Function('gl', 'composite', 'sourceTexture', 'waitForFrame',
    'waitForViewportIdle', 'reportLocalRepaintPrewarmProgress', 'cancelAtFrame', `return (async () => {
      let cancelled = false;
      const nextFrame = waitForFrame;
      waitForFrame = async () => { if (await nextFrame() === cancelAtFrame) cancelled = true; };
      ${uploads}
    })();`);
  const done = run({ initTexture: (texture) => calls.push({ texture, frame }) },
    { maskTexture: 'authored', blendMaskTexture: 'blend' }, sourceTexture,
    async () => { await waitForFrame(); return ++frame; }, async () => {}, () => {}, cancelAtFrame);
  return { done, calls };
};
for (const cancelAt of [Infinity, 1, 2]) {
  const result = runUploads(async () => {}, cancelAt);
  await result.done;
  assert.deepEqual(result.calls, [
    { texture: 'source', frame: 0 },
    ...(cancelAt > 1 ? [{ texture: 'authored', frame: 1 }] : []),
    ...(cancelAt > 2 ? [{ texture: 'blend', frame: 2 }] : []),
  ], 'each upload must be separated even when the viewport is already idle');
}
const onlyMasks = runUploads(async () => {}, Infinity, null);
await onlyMasks.done;
assert.deepEqual(onlyMasks.calls, [{ texture: 'authored', frame: 1 }, { texture: 'blend', frame: 2 }]);
const hiddenUploads = environment('hidden');
const hiddenResult = runUploads(hiddenUploads.waitForBrowserPaint);
for (let i = 0; i < 24; i++) { hiddenUploads.tick(); await Promise.resolve(); }
await hiddenResult.done;
assert.equal(hiddenResult.calls.length, 3);
assert.equal(hiddenUploads.frames.size, 0);
console.log('Local repaint GPU uploads passed: separate yields, cancellation after either yield, absent source, hidden-page completion.');
