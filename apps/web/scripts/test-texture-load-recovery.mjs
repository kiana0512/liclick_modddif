import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers';
import ts from 'typescript';
import * as THREE from 'three';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sceneRootSource = readFileSync(path.join(root, 'src/engine/viewport/SceneRoot.tsx'), 'utf8');
const previewTextureCacheSource = readFileSync(
  path.join(root, 'src/engine/viewport/previewTextureCache.ts'),
  'utf8',
);
const projectedMaterialSource = readFileSync(
  path.join(root, 'src/engine/projection/ProjectedLayerMaterial.ts'),
  'utf8',
);
const projectedWorkerSource = readFileSync(
  path.join(root, 'src/engine/projection/projectedTextureArrayWorker.ts'),
  'utf8',
);

const projectedMaterialBusyGuard = sceneRootSource.match(
  /const isViewportInteractionBusy = \(\) => \{([\s\S]*?)\n {4}\};/,
);
assert.ok(projectedMaterialBusyGuard, 'The projected material busy guard must remain explicit.');
assert.doesNotMatch(
  projectedMaterialBusyGuard[1],
  /paintTool === 'inpaint-apply'/,
  'Selecting a repaint tool must not indefinitely block projected material publication.',
);
assert.match(
  previewTextureCacheSource,
  /PREVIEW_BITMAP_DECODE_TIMEOUT_MS[\s\S]*?resetBitmapWorker\(new Error\('Preview texture decode timed out\.'\)\)/,
  'Preview bitmap decoding must reset a stalled worker instead of retaining a pending cache promise.',
);
assert.match(
  previewTextureCacheSource,
  /PREVIEW_BITMAP_STRIPE_TIMEOUT_MS[\s\S]*?Preview texture upload stripe timed out/,
  'Preview GPU stripe preparation must have a recovery timeout.',
);
assert.match(
  projectedMaterialSource,
  /PROJECTED_TEXTURE_REQUEST_TIMEOUT_MS[\s\S]*?Projected texture fallback load timed out/,
  'Projected texture compatibility loading must terminate stalled requests.',
);
assert.match(
  projectedMaterialSource,
  /const controller = new AbortController\(\);[\s\S]*?controller\.abort\(\)[\s\S]*?signal: controller\.signal/,
  'Projected texture fetch must abort a stalled network request.',
);
assert.match(
  projectedWorkerSource,
  /PROJECTED_ARRAY_WORKER_TIMEOUT_MS[\s\S]*?Projected texture-array worker timed out/,
  'Projected texture-array packing must restart a stalled worker slot.',
);

stdout.write('Texture load recovery regression test passed.\n');

// Run production cache and hook code with decode/upload gates. More than the
// LRU capacity may be in flight: a sibling load must not release their bitmaps.
const selectDeclarations = (source, names) => {
  const ast = ts.createSourceFile('test.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return ast.statements.filter((node) =>
    (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => names.includes(d.name.getText(ast)))),
  ).map((node) => node.getText(ast).replace(/^export /, '')).join('\n');
};
const cacheRuntime = selectDeclarations(previewTextureCacheSource, [
  'MAX_PREVIEW_TEXTURE_CACHE_SIZE', 'bakedTextureCache', 'residentPreviewTextureCache',
  'pinnedPreviewTextureCacheKeys', 'getPreviewTextureCacheKey', 'retainPreviewTexture',
  'trimBakedTextureCache', 'configurePreviewTexture', 'loadPreviewTexture', 'getWorkerBitmapId',
  'prewarmPreviewTextures', 'registeredPreviewRenderer', 'registerPreviewTextureRenderer',
]);
const hookRuntime = selectDeclarations(sceneRootSource, ['useLoadedPreviewTextureState']);
const decodes = new Map();
const uploads = new Map();
const releasedBitmaps = new Set();
const cleanups = [];
const published = [];
const liveTextures = new Map();
const scope = {
  THREE, document: { body: { dataset: {} } },
  window: { setTimeout },
  decodePreviewBitmapInWorker: (url) => new Promise((resolve) => decodes.set(url, resolve)),
  loadPreviewTextureFallback: async () => { throw new Error('Unexpected fallback'); },
  releaseWorkerBitmap: (id) => releasedBitmaps.add(id),
  useState: () => [undefined, (value) => published.push(value)],
  useThree: () => ({ gl: {} }),
  useEffect: (callback) => cleanups.push(callback()),
  getReadyResidentPreviewTexture: () => undefined,
  isLiveProjectedCanvasUrl: (url) => url?.startsWith('liclick-live-projected-canvas:') ?? false,
  getLiveProjectedTexture: (url) => liveTextures.get(url),
  uploadPreviewTextureInStripes: (_renderer, texture) => new Promise((resolve) => uploads.set(texture.userData.liclickPreviewWorkerBitmapId, resolve)),
};
const runtime = ts.transpileModule(`${cacheRuntime}\n${hookRuntime}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const api = new Function(...Object.keys(scope), `${runtime}\nreturn { useLoadedPreviewTextureState, retainPreviewTexture, bakedTextureCache, pinnedPreviewTextureCacheKeys, prewarmPreviewTextures, registerPreviewTextureRenderer };`)(...Object.values(scope));
for (let id = 0; id < 26; id++) api.useLoadedPreviewTextureState(`asset-${id}`);
assert.equal(api.pinnedPreviewTextureCacheKeys.size, 26);
// Resolve out of order, keeping the oldest request pending under LRU pressure.
for (let id = 25; id >= 0; id--) decodes.get(`asset-${id}`)({ id, width: 4096, height: 4096 });
const settle = () => new Promise((resolve) => setImmediate(resolve));
await settle();
assert.equal(uploads.size, 26, 'All exact uploads start without an evicted worker bitmap');
assert.equal(releasedBitmaps.size, 0, 'Decode/upload transactions remain resident above capacity');
cleanups[0](); // Cancel one consumer while its shared upload is pending.
assert.equal(api.pinnedPreviewTextureCacheKeys.size, 26, 'Effect cleanup cannot evict an active upload');
for (let id = 0; id < 26; id++) {
  assert.equal(releasedBitmaps.has(id), false);
  uploads.get(id)();
  await settle();
}
assert.equal(published.length, 25, 'Cancelled consumer must not publish a late texture');
assert.equal(api.pinnedPreviewTextureCacheKeys.size, 0);
assert.equal(api.bakedTextureCache.size, 24, 'Cache returns to its existing bound after release');
const firstLease = api.retainPreviewTexture('shared');
const secondLease = api.retainPreviewTexture('shared');
firstLease(); firstLease();
assert.equal(api.pinnedPreviewTextureCacheKeys.get('shared'), 1, 'Release is idempotent and preserves other consumers');
secondLease();
api.useLoadedPreviewTextureState('cancel-before-decode');
cleanups.at(-1)();
decodes.get('cancel-before-decode')({ id: 99, width: 4096, height: 4096 });
await settle();
assert.equal(uploads.has(99), false, 'Superseded decode does not start unnecessary GPU work');
assert.equal(api.pinnedPreviewTextureCacheKeys.size, 0);
api.registerPreviewTextureRenderer({});
const bulk = api.prewarmPreviewTextures(Array.from({ length: 26 }, (_, id) => `bulk-${id}`));
for (let id = 0; id < 26; id++) decodes.get(`bulk-${id}`)({ id: id + 100, width: 4096, height: 4096 });
await settle();
for (let id = 100; id < 126; id++) {
  assert.equal(releasedBitmaps.has(id), false, 'Bulk siblings remain resident until the last upload');
  assert.equal(api.pinnedPreviewTextureCacheKeys.size, 26);
  uploads.get(id)();
  await settle();
}
assert.equal((await bulk).filter((result) => result.status === 'fulfilled').length, 26);
assert.equal(api.pinnedPreviewTextureCacheKeys.size, 0);
assert.equal(api.bakedTextureCache.size, 24);
stdout.write('Preview cache concurrency passed: 26 overlapping exact loads, cancellation, shared leases and bounded cleanup.\n');

const liveUrl = 'liclick-live-projected-canvas:old-repaint:rgba';
const borrowed = new THREE.Texture();
let disposed = false;
borrowed.addEventListener('dispose', () => { disposed = true; });
liveTextures.set(liveUrl, borrowed);
const decodeCount = decodes.size;
const uploadCount = uploads.size;
const liveState = api.useLoadedPreviewTextureState(liveUrl);
assert.equal(liveState.texture, borrowed, 'Lower repaint borrows its exact existing texture synchronously');
assert.equal(liveState.ready, true);
assert.equal(cleanups.at(-1), undefined, 'Consumer does not acquire disposal ownership');
assert.equal(api.bakedTextureCache.has(liveUrl), false);
assert.equal(api.pinnedPreviewTextureCacheKeys.has(liveUrl), false);
const committedCanvasTexture = new THREE.CanvasTexture();
liveTextures.set(liveUrl, committedCanvasTexture);
assert.equal(api.useLoadedPreviewTextureState(liveUrl).texture, committedCanvasTexture,
  'Same URL resolves the new owner or committed Canvas after GPU release');
liveTextures.delete(liveUrl);
assert.equal(api.useLoadedPreviewTextureState(liveUrl).ready, false,
  'An unavailable live owner cannot publish an unrelated ready texture');
assert.equal(decodes.size, decodeCount, 'Custom URLs never reach image decoding, including missing owners');
assert.equal(uploads.size, uploadCount, 'Borrowed render targets never enter ordinary texture upload');
assert.equal(disposed, false, 'Static cache must not dispose borrowed GPU textures');
stdout.write('Live UV borrowing passed: synchronous binding, owner replacement, no decode/upload/cache/disposal.\n');
