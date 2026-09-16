import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/engine/projection/ResidentProjectedUvDisplay.ts', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('      const uploadStartedAt ='), source.indexOf('      request.onReady(buffer);') + '      request.onReady(buffer);'.length);
const code = ts.transpileModule(`async function run() { ${block} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
for (const cancelAt of [0, 1, 2]) {
  let now = 0, frames = 0, cancelled = false, ready = false;
  const events = [], stages = {}, created = [];
  class ImageData { constructor(data, width, height) { Object.assign(this, { data, width, height }); } }
  const renderer = { domElement: { isConnected: true } };
  const guard = () => { if (cancelled) throw new DOMException('Superseded', 'AbortError'); };
  const paint = async () => { now += 16; events.push('frame'); if (++frames === cancelAt) cancelled = true; };
  const scope = {
    performance: { now: () => now }, interactive: false, restored: true, draft: undefined, draftRevision: 0,
    result: { imageData: new ImageData(new Uint8ClampedArray(16), 2, 2), report: { performanceBreakdown: {} } },
    request: { renderer, resolution: 2, signature: 'new', sourceLayers: [], onReady() { guard(); ready = true; events.push('publish'); } },
    stages, created, cancelled: () => cancelled, guard, mask: new Uint8Array(4), hasRenderedColor: true,
    ImageData, ImageBitmap: class {}, THREE: { NoColorSpace: '' },
    createImageBitmap: async () => { now += 2; return {}; },
    uploadUvRgba: async () => { now += 5; events.push('color'); return { name: 'color' }; },
    createWorkerBackedPreviewTexture: async () => { now += 3; return { name: 'color' }; },
    createWorkerBackedMaskPreviewTexture: async () => { now += 3; return { name: 'mask' }; },
    markSparseAlphaBaseTexture() {}, releaseTransientPreviewUploadSource() {},
    uploadPreviewTextureInStripes: async (_, texture, options) => {
      events.push(texture.name); now += 5;
      if (options.timings) options.timings.submitMs = (options.timings.submitMs ?? 0) + 5;
      if (!options.deferVisiblePresentationBarrier) { await paint(); guard(); await paint(); guard(); }
    },
    waitForBrowserPaint: paint, waitForViewportInteractionIdle: async () => { now += 1; guard(); },
    key: 'new', maskBindings: [], startedAt: 0, document: { body: { dataset: {} } },
  };
  const run = new Function(...Object.keys(scope), code + ';return run;')(...Object.values(scope));
  const operation = run.call({ cache: new Map() });
  if (cancelAt) {
    await assert.rejects(operation, { name: 'AbortError' });
    assert.equal(ready, false, 'cancelled upload must not publish');
  } else {
    await operation;
    assert.deepEqual(events, ['color', 'mask', 'frame', 'frame', 'publish'], 'both uploads precede one shared presentation barrier');
    assert.equal(stages.displayUploadSubmitMs, 5);
    assert.equal(stages.displayUploadPresentationWaitMs, 32);
    const parts = ['displayUploadPrepareMs', 'displayUploadAllocationMs', 'displayUploadStripeWaitMs',
      'displayUploadSubmitMs', 'displayUploadInteractionWaitMs', 'displayUploadYieldMs',
      'displayUploadPresentationWaitMs', 'displayUploadOtherMs'];
    assert.equal(parts.reduce((sum, field) => sum + stages[field], 0), stages.displayUploadMs);
  }
}
console.log('Resident upload: shared barrier after both textures, cancellation before publication, exclusive timing totals passed.');
