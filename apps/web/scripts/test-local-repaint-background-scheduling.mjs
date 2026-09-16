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
const editor = read('routes/EditorPage.tsx');
assert.match(
  editor,
  /const activationRequested = detail\.activationRequested === true \|\| Boolean\(pendingRequest\);[\s\S]*?if \(!activationRequested\) return;[\s\S]*?pushToast\(/,
  'Background prewarm failures stay quiet while explicit button-3 failures remain visible',
);
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

// Run the production image cache with a decoder that can finish independently
// of onload. Consumers must not start a canvas/GPU upload before that barrier.
const imageLoaderSource = viewport.slice(viewport.indexOf('const LOCAL_REPAINT_IMAGE_CACHE_LIMIT'),
  viewport.indexOf('function reportLocalRepaintPrewarmProgress'));
function imageLoaderEnvironment() {
  const images=[];
  let assetReads=0, revoked=[];
  class Image {
    naturalWidth=4096; naturalHeight=2048;
    constructor() {images.push(this);}
    decode() {this.decodes=(this.decodes??0)+1;return new Promise((resolve,reject)=>{this.finishDecode=resolve;this.failDecode=reject;});}
  }
  const objectUrl = {
    createObjectURL: () => 'blob:authenticated-mask',
    revokeObjectURL: (url) => revoked.push(url),
  };
  const readWorkspaceAssetBlob = async () => {
    assetReads++;
    return new Blob(['mask'], { type: 'image/png' });
  };
  const load=new Function('Image','readWorkspaceAssetBlob','URL',ts.transpileModule(imageLoaderSource,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+'\nreturn loadImageElement;')(Image,readWorkspaceAssetBlob,objectUrl);
  return {load,images,get assetReads(){return assetReads;},revoked};
}
const flushImages=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const loader=imageLoaderEnvironment();
let published=false;
const first=loader.load('source'); first.then(()=>{published=true;});
assert.equal(loader.load('source'),first,'Concurrent consumers share loading and decoding');
const original=loader.images[0];
assert.equal(original.crossOrigin,'anonymous'); assert.equal(original.src,'source');
void original.onload(); await flushImages();
assert.equal(published,false,'onload alone must not start synchronous image consumers');
assert.equal(original.decodes,1);
assert.equal(loader.load('source'),first,'A pending decode stays shared');
original.finishDecode(); assert.equal(await first,original,'Return the unchanged full-resolution image');
assert.deepEqual([original.naturalWidth,original.naturalHeight],[4096,2048]);
assert.equal(loader.load('source'),first,'Ready cache hit does not decode again');
assert.equal(original.decodes,1);
for(const fallback of ['unsupported','rejected']) {
  const request=loader.load(fallback), image=loader.images.at(-1);
  if(fallback==='unsupported')image.decode=undefined;
  void image.onload();
  if(fallback==='rejected')image.failDecode(Error('optional decode hint rejected'));
  assert.equal(await request,image,'Loaded images remain usable when optional decode is unavailable/rejected');
}
const failed=loader.load('failed').catch(error=>error.message);
loader.images.at(-1).onerror(); assert.match(await failed,/无法读取/);
const beforeRetry=loader.images.length, retried=loader.load('failed');
assert.equal(loader.images.length,beforeRetry+1,'Load errors must not poison the cache');
void loader.images.at(-1).onload(); loader.images.at(-1).finishDecode(); await retried;
const protectedMask=loader.load('/workspace/project/assets/generations/repaint-mask.png');
loader.images.at(-1).onerror(); await flushImages();
const authenticatedImage=loader.images.at(-1);
assert.equal(authenticatedImage.src,'blob:authenticated-mask');
void authenticatedImage.onload(); authenticatedImage.finishDecode();
assert.equal(await protectedMask,authenticatedImage,'Durable masks retry through the authenticated asset reader');
assert.equal(loader.assetReads,1);
assert.deepEqual(loader.revoked,['blob:authenticated-mask']);
assert.equal(loader.load('/workspace/project/assets/generations/repaint-mask.png'),protectedMask,'Authenticated result stays shared');
const bounded=imageLoaderEnvironment();
const warm=async(url)=>{const p=bounded.load(url), image=bounded.images.at(-1);void image.onload();image.finishDecode();return p;};
for(let i=0;i<6;i++)await warm(`image-${i}`);
const oldest=bounded.load('image-0');
await warm('image-6');
assert.equal(bounded.load('image-0'),oldest,'A ready cache hit refreshes recency');
const beforeEvicted=bounded.images.length;
await warm('image-1'); assert.equal(bounded.images.length,beforeEvicted+1,'Decoded cache remains bounded to six entries');
console.log('Local repaint decode barrier passed: shared pending decode, original 4K image, fallback, retry and six-entry LRU.');
