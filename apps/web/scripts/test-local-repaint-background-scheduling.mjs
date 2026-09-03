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
