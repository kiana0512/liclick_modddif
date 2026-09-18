import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';

const read = path => fs.readFileSync(new URL(`../src/${path}.ts`, import.meta.url), 'utf8');
const compile = (source, dependencies, globals = {}) => {
  const exports = {};
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  new Function('require', 'exports', ...Object.keys(globals), js)(name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  }, exports, ...Object.values(globals));
  return exports;
};
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const probe = compile(read('engine/performance/residentUvVisibilityProbe'), {
  three: THREE, '@/utils/browserScheduling': { waitForBrowserPaint: async () => {} },
});
const root = new THREE.Group();
const uv = new THREE.ShaderMaterial({ uniforms: { useBaseMap: { value: 1 } } });
uv.name = 'LiclickUvOverlayPreview';
uv.userData.liclickResidentUvProjectionLayers = ['b', 'a'];
root.add(new THREE.Mesh(new THREE.PlaneGeometry(), uv));
assert(probe.hasPresentedProjectedUvLayers(root, ['a', 'b']));
assert(!probe.hasPresentedProjectedUvLayers(root, ['a']), 'old colour must not acknowledge a new eye state');
uv.userData.liclickResidentUvProjectionLayers = ['a', 'a'];
assert(!probe.hasPresentedProjectedUvLayers(root, ['a', 'b']), 'duplicate bindings are not correct presentation');
uv.userData.liclickResidentUvProjectionLayers = ['a', 'b'];
uv.uniforms.useBaseMap.value = 0;
assert(!probe.hasPresentedProjectedUvLayers(root, ['a', 'b']), 'unbound UV cannot pass');
uv.uniforms.useBaseMap.value = 1;
uv.userData.liclickLiveLocalRepaintOverlayMaterial = true;
assert(!probe.hasPresentedProjectedUvLayers(root, ['a', 'b']), 'renderer repaint overlay is not the UV front');
await assert.rejects(probe.waitForProjectedUvLayers(root, ['a'], -1), /发布超时/);
uv.dispose(); root.children[0].geometry.dispose();

// Exercise the real idle function with a permanently busy camera. Cancellation
// must drain after a paint, without waiting for pointer release.
const interactionSource = read('engine/viewport/viewportInteractionState');
const ast = ts.createSourceFile('interaction.ts', interactionSource, ts.ScriptTarget.Latest, true);
const idleFunction = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'waitForViewportInteractionIdle');
let paints = 0;
const idle = compile(idleFunction.getText(ast), {}, {
  isViewportInteractionBusy: () => true,
  document: { visibilityState: 'visible' },
  waitForBrowserPaint: async () => { paints++; },
}).waitForViewportInteractionIdle;
let checks = 0;
await assert.rejects(idle(240, () => {
  if (++checks > 1) throw new DOMException('superseded', 'AbortError');
}), { name: 'AbortError' });
assert.equal(paints, 1, 'busy camera cannot hold an obsolete upload until release');

for (const busy of [false, true]) {
  const events = [], jobs = [], ready = [], datasets = {}, composites = [];
  let acknowledge = true;
  let eraserDraft;
  let livePaintPreview;
  const model = { group: new THREE.Group(), objectId: 'o' };
  const renderer = { domElement: { addEventListener() {}, removeEventListener() {} },
    getContext: () => ({ isContextLost: () => false }) };
  class ImageData { constructor(data, width, height) { Object.assign(this, { data, width, height }); } }
  class Bitmap { close() {} }
  class Cache {
    restore = async () => undefined;
    offer() { events.push('compress'); }
    activate() {}
    dispose() {}
  }
  const api = compile(read('engine/projection/ResidentProjectedUvDisplay'), {
    three: THREE,
    '@/engine/bake/uvContributionTiles': {uploadUvRgba: async()=>new THREE.DataTexture(new Uint8Array(4),1,1)},
    '@/engine/bake/incrementalUvComposite': {}, './uploadUvDisplayPatch': {},
    '@/engine/layers/mergeUvComposition': { getMergeUvPostprocessOptions: () => ({}) },
    '@/engine/viewport/previewTextureCache': {
      createWorkerBackedPreviewTexture: async () => new THREE.DataTexture(new Uint8Array(4), 1, 1),
      uploadPreviewTextureInStripes: async () => {}, releaseTransientPreviewUploadSource() {},
    },
    '@/utils/browserScheduling': { yieldToBrowserTask: async () => { events.push('yield'); } },
    '@/engine/viewport/viewportInteractionState': { isViewportInteractionBusy: () => false },
    './ProjectedLayerMaterial': { markSparseAlphaBaseTexture() {} },
    '@/engine/bake/ProjectedUvRasterCache': { ProjectedUvRasterCache: class { dispose() {} } },
    './residentUvPresentation': { markResidentUvPending() {}, finishResidentUvPresentation() {}, releaseResidentUvManagement() {} },
    './ResidentUvCompressedCache': { ResidentUvCompressedCache: Cache },
    './liveProjectedCanvasTextureRegistry': { getLiveProjectedCanvasState() {} },
    '@/engine/paint/eraserUvDraft': { getEraserUvDraft: () => eraserDraft }, '@/utils/blobUrlRegistry': { revokeRegisteredObjectUrl() {} },
    '@/engine/paint/liveSurfacePaintPreviewRegistry': { getLiveSurfacePaintPreview: () => livePaintPreview },
    '@/engine/bake/bakeProjectedLayerToTexture': {
      bakeVisibleProjectedLayersToTexture: async input => {
        events.push('bake');
        return new Promise((resolve, reject) => jobs.push({ input, resolve, reject }));
      },
    },
    '@/engine/bake/prepareMergeProjectionLayers': { prepareMergeProjectionLayers: async layers => layers },
    './createMaskedProjectedImage': {},
    '@/engine/bake/persistentMergePreparation': { persistentMergeKey: async () => {
      events.push('hash'); return 'verified-key';
    } },
    '@/engine/performance/webGpuRgbaComposite': { compositeRgbaUrlUnderWithWebGpu: (pixels, url, width, height, opacity, signal) => {
      assert.equal(typeof signal?.addEventListener, 'function', 'Resident eye changes must cancel obsolete underlay work');
      return new Promise((resolve, reject) => {
        const task = { signal, resolve: () => resolve({ data: pixels.slice() }), url, width, height, opacity };
        signal.addEventListener('abort', () => reject(new DOMException('superseded underlay', 'AbortError')), { once: true });
        composites.push(task);
      });
    } },
  }, { document: { body: { dataset: datasets } }, ImageData, ImageBitmap: Bitmap,
    createImageBitmap: async () => new Bitmap() });
  const display = new api.ResidentProjectedUvDisplay();
  const request = (signature, projectId) => ({ signature, projectId, renderer, sourceModel: model,
    sourceLayers: [{ id: signature, visible: true, opacity: 1 }], resolution: 1,
    onReady(result) { events.push('ready'); ready.push(result); if (acknowledge) display.acknowledgePresentation(result.colorTexture); },
    onError(error) { throw error; },
  });
  let draftFlushes = 0;
  eraserDraft = { revision: 1, owner: { target: 'projected-mask', objectId: 'o', layerId: 'fast' },
    flush() { draftFlushes++; } };
  livePaintPreview = { displayArmed: true, target: 'projected-mask', objectId: 'o', layerId: 'fast' };
  display.request(request('fast')); display.step(); await flush();
  assert.equal(jobs.length, 0, 'armed GPU mask must prevent Resident UV work');
  assert.equal(draftFlushes, 0, 'armed GPU mask must return before a full-resolution draft flush');
  eraserDraft = undefined; livePaintPreview = undefined;
  display.cancelPending();
  display.request(request('old')); display.step(); await flush();
  assert.equal(jobs.length, 1);
  eraserDraft = { revision: 2, owner: { target: 'projected-mask', objectId: 'o', layerId: 'old' } };
  livePaintPreview = { displayArmed: true, target: 'projected-mask', objectId: 'o', layerId: 'old' };
  assert.throws(() => jobs[0].input.checkCancelled(), { name: 'AbortError' },
    'a new GPU-mask stroke cancels an in-flight final Resident UV convergence');
  eraserDraft = undefined; livePaintPreview = undefined;
  display.request(request('intermediate')); display.request(request('latest'));
  display.step(busy);
  jobs[0].reject(new DOMException('superseded', 'AbortError')); await flush();
  assert.equal(jobs.length, busy ? 1 : 2, 'latest immutable request wakes immediately, but not during a camera gate');
  if (busy) { display.step(false); await flush(); }
  assert.equal(jobs.length, 2, 'intermediate eye state must never start a bake');
  const pixels = () => ({ imageData: new ImageData(new Uint8ClampedArray([17, 18, 19, 255]), 1, 1),
    renderedColorMask: new Uint8Array(0), report: { performanceBreakdown: {} } });
  jobs[1].resolve(pixels()); await flush();
  assert.equal(ready.length, 1); assert.equal(ready[0].signature, 'latest');
  events.length = 0;
  acknowledge = false;
  display.request(request('persisted', 'p')); display.step(); await flush();
  assert(events.includes('bake') && events.includes('hash'), 'preserve original geometry/source verification timing');
  jobs[2].resolve(pixels()); await flush();
  assert(events.includes('ready') && !events.includes('compress'), 'onReady alone is not material presentation; compression must wait');
  display.acknowledgePresentation(ready.at(-1).colorTexture); await flush();
  assert(events.indexOf('compress') > events.indexOf('ready'), 'cache publication follows actual presentation handoff');
  assert(events.indexOf('compress') > events.indexOf('hash'), 'never persist under an unverified digest');
  display.request(request('latest'));
  assert.equal(datasets.residentUvProjectionCacheHit, 'true');
  assert.equal(jobs.length, 3, 'cache hit publishes without a new bake');
  acknowledge = true;
  for (let round = 0; round < 5; round++) {
    const published = ready.length, firstJob = jobs.length;
    display.request(request(`burst-${round}-old`)); display.step(false); await flush();
    for (let click = 0; click < 40; click++) display.request(request(`burst-${round}-${click}`));
    display.step(false);
    // A slow upstream may finish successfully after it was superseded.
    jobs[firstJob].resolve(pixels()); await flush();
    assert.equal(ready.length, published, 'obsolete successful bake must not publish');
    assert.equal(jobs.length, firstJob + 2, 'burst calculates only old plus final, not 39 intermediate states');
    assert.equal(jobs.at(-1).input.transientLayers[0].id, `burst-${round}-39`);
    jobs.at(-1).resolve(pixels()); await flush();
    assert.equal(ready.length, published + 1);
    assert.equal(ready.at(-1).signature, `burst-${round}-39`, 'last click wins across repeated bursts');
  }
  const underlayRequest = signature => ({ ...request(signature), underlayLayers: [{ id: 'underlay', imageUrl: 'verified-underlay', opacity: 1 }] });
  const published = ready.length;
  display.request(underlayRequest('underlay-old')); display.step(false); await flush();
  jobs.at(-1).resolve(pixels()); await flush();
  assert.equal(composites.length, 1);
  display.request(underlayRequest('underlay-intermediate')); display.request(underlayRequest('underlay-latest'));
  await flush();
  assert(composites[0].signal.aborted, 'Old underlay is cancelled without waiting for its result');
  assert.equal(jobs.at(-1).input.transientLayers[0].id, 'underlay-latest');
  assert.equal(ready.length, published, 'Cancelled pixels never publish');
  jobs.at(-1).resolve(pixels()); await flush();
  composites.at(-1).resolve(); await flush();
  assert.equal(ready.at(-1).signature, 'underlay-latest');
  assert.deepEqual(ready.at(-1).layerIds, ['underlay-latest']);
  display.request(underlayRequest('underlay-dispose')); display.step(false); await flush();
  jobs.at(-1).resolve(pixels()); await flush();
  display.dispose(); await flush();
  assert(composites.at(-1).signal.aborted, 'Disposal cancels the pending worker operation');
}
console.log('Resident UV visibility: bound source-set proof, cancellable busy-camera idle, latest-wins wake, deferred verified persistence and cache-hit publication passed.');
