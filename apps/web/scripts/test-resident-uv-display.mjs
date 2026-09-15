import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
import './test-resident-uv-visibility-scheduling.mjs';

const load = (file, dependencies) => {
  const source = fs.readFileSync(new URL(`../src/engine/bake/${file}.ts`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const exports = {};
  new Function('require', 'exports', js)((name) => {
    if (name in dependencies) return dependencies[name];
    throw Error(`Unexpected dependency: ${name}`);
  }, exports);
  return exports;
};
const { resolvePixelCpu } = load('qualityBlendCpuPixel', {});
{
  const {uploadUvRgba}=load('uvContributionTiles',{three:THREE,
    '@/utils/browserScheduling':{yieldToBrowserTask:async()=>{}}});
  for(const [width,height] of [[1,1],[65,67],[300,301],[1024,1025]])for(const flipRows of [false,true]) {
    const source=Uint8Array.from({length:width*height*4},(_,i)=>(i*37)&255),before=source.slice();
    const output=new Uint8Array(source.length);let maximum=0;
    const renderer={initTexture(texture){assert.equal(texture.source.dataReady,false);},copyTextureToTexture(stripe,_target,_region,position){
      maximum=Math.max(maximum,stripe.image.data.byteLength);output.set(stripe.image.data,position.y*width*4);
    }};
    const texture=await uploadUvRgba(renderer,source,width,height,{flipRows});
    for(let y=0;y<height;y++)assert.deepEqual(output.subarray(y*width*4,(y+1)*width*4),
      source.subarray((flipRows?height-1-y:y)*width*4,(flipRows?height-y:y+1)*width*4));
    assert.deepEqual(source,before);assert(maximum<=1048576);texture.dispose();
  }
  let released=0,checks=0;
  await assert.rejects(uploadUvRgba({initTexture(t){t.addEventListener('dispose',()=>released++);},copyTextureToTexture(){}},
    new Uint8Array(300*301*4),300,301,{check(){if(++checks===3)throw Error('cancelled');}}),/cancelled/);
  assert.equal(released,1,'Cancelled direct upload releases its unpublished destination');
}
let sentinels,
  packed,
  calls = 0;
const { ResidentQualityComposite } = load('residentQualityComposite', {
  three: THREE,
  './uvContributionTiles': load('uvContributionTiles', {three:THREE,
    '@/utils/browserScheduling':{yieldToBrowserTask:async()=>{}}}),
  './qualityBlendCpuPixel': {
    resolvePixelCpu(...args) {
      calls++;
      return resolvePixelCpu(...args);
    },
  },
  './gpuReadbackStripes': { readRenderTargetPixelsInStripes: async () => sentinels.slice() },
  '@/utils/browserScheduling': { yieldToBrowserTask: async () => {} },
  './uvBakeDebugControls': { isLegacyUvBakeDiagnosticEnabled: () => false },
});
{
  // Similar colors/alpha must not be mistaken for the internal correction marker.
  sentinels = new Uint8Array(4 * 4 * 4);
  sentinels.set([255, 0, 254, 0, 255, 0, 255, 1, 254, 0, 255, 0, 255, 255, 255, 255]);
  const probe = Object.create(ResidentQualityComposite.prototype);
  Object.assign(probe, { resolution: 4, resolve: () => ({}) });
  const result = await probe.readCorrected(true);
  assert.deepEqual(result.output, new Uint8ClampedArray(sentinels));
  assert.equal(result.correctedPixels, 0);
}
for (const preserveAlpha of [false, true])
  for (const runMarkers of [false, true]) {
    const resolution = 64,
      count = resolution * resolution;
    packed = new Uint32Array(count * 4);
    sentinels = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      // Long identical runs plus every-byte changes exercise both reuse and invalidation.
      const k = i < 2048 ? 19 : i;
      packed.set(
        [
          ((k * 71) & 0xffffff) | (201 << 24),
          ((k * 179) & 0xffffff) | (143 << 24),
          ((k * 991) & 0xffffff) | (87 << 24),
          (k * 137) & 0xffffff,
        ],
        i * 4,
      );
      sentinels.set([runMarkers && i > 0 && i < 2048 ? 254 : 255, 0, 255, 0], i * 4);
    }
    const reference = new Uint8ClampedArray(count * 4);
    const top = {
      colors: [0, 0, 0].map(() => new Uint32Array(1)),
      coverages: [0, 0, 0].map(() => new Float32Array(1)),
      qualities: [0, 0, 0].map(() => new Float32Array(1)),
      coverage: new Uint8Array([1]),
      writtenTexels: 1,
    };
    for (let i = 0; i < count; i++) {
      for (let slot = 0; slot < 3; slot++) {
        const color = packed[i * 4 + slot],
          coverage = (color >>> 24) / 255;
        top.colors[slot][0] = color & 0xffffff;
        top.coverages[slot][0] = coverage;
        top.qualities[slot][0] = Math.max(
          Math.fround(((packed[i * 4 + 3] >>> (slot * 8)) & 255) / 255),
          coverage * 0.08,
        );
      }
      resolvePixelCpu(top, 0, preserveAlpha, reference.subarray(i * 4, i * 4 + 4));
    }
    const instance = Object.create(ResidentQualityComposite.prototype);
    Object.assign(instance, {
      resolution,
      current: 0,
      targets: [{ texture: {} }],
      gatherMaterial: { uniforms: { previousCandidates: {}, coordinates: {} } },
      mesh: {},
      scene: {},
      camera: {},
      resolve: () => ({}),
      withTarget: (_, callback) => callback(),
      renderer: {
        capabilities: { maxTextureSize: 256 },
        render() {},
        async readRenderTargetPixelsAsync(_target, _x, _y, _w, _h, bytes) {
          const destination = new Uint32Array(bytes.buffer);
          let count = 0;
          for (let i = 0; i < sentinels.length; i += 4)
            if (sentinels[i] === 255) {
              destination.set(packed.subarray(i, i + 4), count * 4);
              count++;
            }
        },
      },
    });
    calls = 0;
    const result = await instance.readCorrected(preserveAlpha);
    assert.deepEqual(result.output, reference, 'Sparse correction must remain byte-exact');
    assert.equal(calls, 2049, 'Identical candidate tuples reuse the exact CPU result');
    assert.equal(result.correctedPixels, count);
    for(let i=3;i<packed.length;i+=4) packed[i]^=0x7f000000;
    calls=0;
    assert.deepEqual((await instance.readCorrected(preserveAlpha)).output,reference,
      'Coverage-count changes reuse exact color tuples across visibility combinations');
    assert(calls<100,'Warm integer tuples avoid redundant canonical pixel work');
    // Force a hash collision with the same first color but a different second.
    const a=packed[0],b=packed[1],c=packed[2];
    const q=(packed[3]&0xffffff)|(preserveAlpha?0x1000000:0x2000000);
    const hash=Math.imul(a^Math.imul(b,1597334677)^Math.imul(c,3812015801)^q,2654435761);
    const entry=((hash^(hash>>>16))&262143)*5;
    instance.correctedTuples.set([a,b^1,c,q,0],entry);
    assert.deepEqual((await instance.readCorrected(preserveAlpha)).output,reference,'Hash collisions must verify all four keys');
    const alternate=await instance.readCorrected(!preserveAlpha);
    assert.notDeepEqual(alternate.output,reference,'Preserve-alpha modes must never share an incorrect memo output');
    assert.deepEqual((await instance.readCorrected(preserveAlpha)).output,reference);
  }

const { ProjectedUvRasterCache } = load('ProjectedUvRasterCache', {
  three: THREE,
  './uvContributionTiles': {},
  './UvContributionArchive': {UvContributionArchive: class {dispose() {}}},
  './residentQualityComposite': { ResidentQualityComposite },
  '@/utils/browserScheduling': { yieldToBrowserTask: async () => {} },
});
const cache = new ProjectedUvRasterCache(16);
const renderer = { domElement: { addEventListener() {}, removeEventListener() {} } };
let disposed = 0;
const entry = () => {
  const qualityTexture = { format: THREE.RGBAFormat };
  return {
    color: {
      width: 1,
      height: 1,
      dispose() {
        disposed++;
      },
    },
    quality: {
      texture: qualityTexture,
      dispose() {
        disposed++;
      },
    },
    qualityTexture,
    sourceSize: {},
  };
};
cache.prepare(renderer, 'mesh-1/1K', ['a', 'b']);
const a = entry(),
  b = entry();
assert(cache.take('a', a));
assert(cache.take('b', b));
assert.equal(cache.get('a'), a);
assert.equal(cache.take('c', entry()), false, 'Active inputs cannot be evicted mid-composition');
cache.prepare(renderer, 'mesh-1/1K', ['a', 'c']);
assert(cache.take('c', entry()));
assert.equal(disposed, 2);
assert.equal(cache.get('b'), undefined);
cache.prepare(renderer, 'mesh-2/1K', ['a']);
assert.equal(cache.get('a'), undefined, 'Geometry changes invalidate derived rasters');
assert.equal(disposed, 6);
cache.dispose();

// Force a two-raster budget: third layer must spill, not disappear/re-project.
{
  class Archive {
    entries=new Map();
    has(key){return this.entries.has(key);}
    async store(key,value,_renderer,check){check?.();this.entries.set(key,value);}
    async restore(key,_renderer,check){check?.();return this.entries.get(key);}
    dispose(){this.entries.clear();}
  }
  const {ProjectedUvRasterCache: Contributions}=load('ProjectedUvRasterCache',{
    three:THREE,'./residentQualityComposite':{ResidentQualityComposite},
    '@/utils/browserScheduling':{yieldToBrowserTask:async()=>{}},
    './uvContributionTiles':{compactUvContribution:async()=>undefined},
    './UvContributionArchive':{UvContributionArchive:Archive},
  });
  globalThis.document ??= {body:{dataset:{}}};
  const owner=new Contributions(16,true);
  owner.prepare(renderer,'scope',['a','b','c']);
  const inputs=[entry(),entry(),entry()];
  assert(await owner.retainContribution('a',inputs[0],1));
  assert(await owner.retainContribution('b',inputs[1],1));
  assert.equal(await owner.retainContribution('c',inputs[2],1),false);
  assert(owner.hasArchivedContribution('c'));
  assert.equal(await owner.restoreContribution('c'),inputs[2]);
  owner.prepare(renderer,'scope',['b','d']);
  assert(await owner.retainContribution('d',entry(),1));
  assert(owner.hasArchivedContribution('a'),'Eviction first saves the UV input');
  assert.equal(await owner.restoreContribution('a'),inputs[0]);
  owner.prepare(renderer,'new geometry',['a']);
  assert.equal(owner.hasArchivedContribution('a'),false,'Geometry changes invalidate contributions');
  owner.dispose();
  for(const operation of ['store','restore']) for(const invalidate of ['scope','context','dispose']) {
    let resume,entered;
    const began=new Promise(resolve=>{entered=resolve;});
    class DelayedArchive extends Archive {
      async store(...args) {
        if(operation==='store') {entered();await new Promise(resolve=>{resume=resolve;});}
        return super.store(...args);
      }
      async restore(...args) {
        entered();await new Promise(resolve=>{resume=resolve;});return super.restore(...args);
      }
    }
    const {ProjectedUvRasterCache: Delayed}=load('ProjectedUvRasterCache',{
      three:THREE,'./residentQualityComposite':{ResidentQualityComposite},
      './uvContributionTiles':{compactUvContribution:async()=>undefined},
      './UvContributionArchive':{UvContributionArchive:DelayedArchive},
    });
    let contextLost;
    const target={domElement:{addEventListener(_event,handler){contextLost=handler;},removeEventListener(){}}};
    const pendingOwner=new Delayed(0,true);pendingOwner.prepare(target,'old',['x']);
    if(operation==='restore') await pendingOwner.retainContribution('x',entry(),1);
    const pending=operation==='store' ? pendingOwner.retainContribution('x',entry(),1) : pendingOwner.restoreContribution('x');
    const rejected=assert.rejects(pending,{name:'AbortError'});
    await began;
    if(invalidate==='scope') pendingOwner.prepare(target,'new',['x']);
    else if(invalidate==='context') contextLost(); else pendingOwner.dispose();
    resume();await rejected;
    assert.equal(pendingOwner.get('x'),undefined);
    assert.equal(pendingOwner.hasArchivedContribution('x'),false,'Late archive work cannot republish invalid UVs');
    if(invalidate!=='dispose') pendingOwner.dispose();
  }
}
globalThis.ImageData ??= class {
  constructor(data, width, height) {
    Object.assign(this, { data, width, height });
  }
};
assert.equal(cache.retainResolved, undefined, 'UV input storage cannot be displaced by duplicate raw aggregate snapshots');
// A completed all-normal aggregate can continue with newly appended top
// layers. Any non-prefix stack must reset, and taking a lease invalidates the
// old prefix until the new calculation commits successfully.
{
  const prefixCache = new ProjectedUvRasterCache(64);
  prefixCache.prepare(renderer, 'prefix-scope', ['a', 'b']);
  let resets = 0, slot = 0;
  const composite = {
    resolution: 1,
    reset() { resets++; slot = 0; },
    dispose() {},
    getCurrentSlot() { return slot; },
    selectSlot(next) { slot = next; },
  };
  prefixCache.resident = composite;
  let lease = prefixCache.leaseResident(renderer, 1, ['a', 'b']);
  assert.equal(lease.startIndex, 0);
  assert.equal(lease.composite, composite);
  assert.equal(resets, 1);
  prefixCache.commitResident(['a', 'b'], [{ width: 1 }, { width: 2 }]);
  lease = prefixCache.leaseResident(renderer, 1, ['a', 'b', 'c']);
  assert.equal(lease.startIndex, 2, 'Appending a top layer resumes the exact candidate prefix');
  assert.deepEqual(lease.sourceSizes, [{ width: 1 }, { width: 2 }]);
  assert.equal(resets, 1);
  lease = prefixCache.leaseResident(renderer, 1, ['a', 'b', 'c']);
  assert.equal(lease.startIndex, 0, 'An uncommitted lease cannot be reused after cancellation');
  assert.equal(resets, 2);
  prefixCache.commitResident(['a', 'b', 'c'], [{}, {}, {}]);
  lease = prefixCache.leaseResident(renderer, 1, ['a', 'x', 'c']);
  assert.equal(lease.startIndex, 0, 'Middle-layer changes require a full recomposition');
  assert.equal(resets, 3);
  const resized = prefixCache.leaseResident(renderer, 512, ['a', 'x', 'c']);
  assert.equal(resized.startIndex, 0, 'Region size changes invalidate candidate prefixes');
  assert.equal(resized.composite.resolution, 512);
  assert.notEqual(resized.composite, composite);
  prefixCache.dispose();
}
// The ping-pong candidate target that preceded a completed stack is still an
// exact Top-K prefix. Closing the highest-priority visible layer should select
// that resident slot instead of projecting every remaining layer again.
{
  const rewindCache = new ProjectedUvRasterCache(64);
  rewindCache.prepare(renderer, 'rewind-scope', ['a', 'b', 'c']);
  let currentSlot = 0, resets = 0;
  rewindCache.resident = {
    resolution: 1,
    reset() { resets++; currentSlot = 0; },
    dispose() {},
    getCurrentSlot() { return currentSlot; },
    selectSlot(next) { currentSlot = next; },
  };
  rewindCache.leaseResident(renderer, 1, ['a', 'b', 'c']);
  currentSlot = 1;
  rewindCache.recordResidentState(['a'], [{ id: 'a' }]);
  currentSlot = 0;
  rewindCache.recordResidentState(['a', 'b'], [{ id: 'a' }, { id: 'b' }]);
  currentSlot = 1;
  rewindCache.recordResidentState(
    ['a', 'b', 'c'],
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  );
  rewindCache.commitResident(
    ['a', 'b', 'c'],
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  );
  const rewind = rewindCache.leaseResident(renderer, 1, ['a', 'b']);
  assert.equal(rewind.startIndex, 2, 'One-layer suffix removal reuses the exact previous slot');
  assert.equal(currentSlot, 0);
  assert.deepEqual(rewind.sourceSizes, [{ id: 'a' }, { id: 'b' }]);
  rewindCache.commitResident(['a', 'b'], [{ id: 'a' }, { id: 'b' }]);
  const append = rewindCache.leaseResident(renderer, 1, ['a', 'b', 'c']);
  assert.equal(append.startIndex, 2, 'Re-enabling the top layer resumes the same exact prefix');
  assert.equal(resets, 1);
  rewindCache.dispose();
}
const compactCache = new ProjectedUvRasterCache(16);
compactCache.prepare(renderer, 'compact', ['a', 'b', 'c']);
const compactEntry = () => {
  const value = entry(); value.qualityTexture.format = THREE.RedFormat; return value;
};
assert(compactCache.take('a', compactEntry()));
assert(compactCache.take('b', compactEntry()));
assert(compactCache.take('c', compactEntry()), 'R8 quality is charged one byte per full-resolution texel');
assert.equal(compactCache.take('d', compactEntry()), false);
assert(compactCache.get('a'));assert(compactCache.get('b'));assert(compactCache.get('c'), 'all three 5-byte contributions remain resident');
compactCache.dispose();
// MRT color/quality attachments share one render-target owner. Eviction must
// dispose that owner exactly once while still charging the R8 byte footprint.
{
  let mrtDisposals = 0;
  const mrtCache = new ProjectedUvRasterCache(5);
  mrtCache.prepare(renderer, 'mrt-a', ['mrt']);
  assert(mrtCache.take('mrt', {
    color: { width: 1, height: 1, dispose() { mrtDisposals++; } },
    qualityTexture: { format: THREE.RedFormat }, sourceSize: {},
  }));
  mrtCache.prepare(renderer, 'mrt-b', []);
  assert.equal(mrtDisposals, 1, 'shared MRT attachment owner is released once');
  mrtCache.dispose();
}
{
  const {projectionAttributeRevision}=load('projectionBakeSignature',{
    './layerStackCache':{},'./uvBakeDebugControls':{},
    '@/utils/browserScheduling':{yieldToBrowserTask:async()=>{throw Error('Attribute revision must not schedule pixel copies');}},
    '@/engine/viewport/viewportInteractionState':{waitForViewportInteractionIdle:async()=>{throw Error('Attribute revision must not wait for interaction');}},
  });
  const uv=new THREE.Float32BufferAttribute([0,0,1,1],2);
  const first=projectionAttributeRevision(uv);
  assert.equal(projectionAttributeRevision(uv),first);
  assert.notEqual(projectionAttributeRevision(uv.clone()),first,'replacement UV at version zero invalidates');
  uv.array=uv.array.slice();assert.notEqual(projectionAttributeRevision(uv),first,'replacement array invalidates');
  const buffer=new THREE.InterleavedBuffer(new Float32Array(12),3);
  const interleaved=new THREE.InterleavedBufferAttribute(buffer,2,0);
  const packed=projectionAttributeRevision(interleaved);buffer.needsUpdate=true;
  assert.notEqual(projectionAttributeRevision(interleaved),packed,'interleaved upload revision invalidates');
  const offset=projectionAttributeRevision(interleaved);interleaved.offset=1;
  assert.notEqual(projectionAttributeRevision(interleaved),offset,'interleaved offset invalidates');
}
const cacheWorkerSource = fs.readFileSync(
  new URL('../src/workers/residentUvCache.worker.ts', import.meta.url),
  'utf8',
);
// Compression can lag behind eye gestures. Keep exactly the newest completed
// buffer while busy; dropping it leaves the current saved project without a UV.
{
const clientSource = fs.readFileSync(new URL('../src/engine/projection/ResidentUvCompressedCache.ts', import.meta.url), 'utf8');
const sent = [], workers = [];
class CacheWorker {
  constructor() { workers.push(this); }
  postMessage(message, transfer = []) { sent.push(globalThis.structuredClone(message, { transfer })); }
  terminate() {}
}
const clientExports = {};
new Function('Worker', 'document', 'exports', ts.transpileModule(clientSource.replaceAll('import.meta.url', "'file:///cache.ts'"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(CacheWorker, { body: { dataset: {} } }, clientExports);
const client = new clientExports.ResidentUvCompressedCache();
const image = () => ({ width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) });
const a = image(), b = image(), c = image();
client.offer('a', a); client.offer('b', b); client.offer('c', c);
assert.deepEqual(sent.map(message => message.key), ['a']);
assert.equal(a.data.byteLength, 0);
workers[0].onmessage({ data: { id: sent[0].id, keys: ['a'] } });
assert.deepEqual(sent.map(message => message.key), ['a', 'c'], 'Only the newest pending completed UV is compressed');
assert.equal(b.data.byteLength, 1024);
assert.equal(c.data.byteLength, 0);
client.offer('d', image()); client.dispose();
assert.equal(sent.length, 2, 'Disposal clears queued work before resolving in-flight work');
}
let cacheReply;
const cacheWorker = {
  postMessage(value, transfers = []) {
    cacheReply = globalThis.structuredClone(value, { transfer: transfers });
  },
};
new Function(
  'self',
  'exports',
  ts.transpileModule(cacheWorkerSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText,
)(cacheWorker, {});
const hiddenColor = Uint8Array.from({ length: 16 * 16 * 4 }, (_, i) => (i * 73) % 256);
const exactMask = Uint8Array.from({ length: 16 * 16 }, (_, i) => i % 3);
await cacheWorker.onmessage({
  data: {
    id: 1,
    type: 'store',
    key: 'a',
    resolution: 16,
    color: hiddenColor.buffer,
    mask: exactMask.buffer,
  },
});
assert.deepEqual(cacheReply.keys, ['a']);
await cacheWorker.onmessage({ data: { id: 2, type: 'restore', key: 'a' } });
assert.deepEqual(
  new Uint8Array(cacheReply.output, 0, hiddenColor.length),
  hiddenColor,
  'Deflate preserves even transparent RGB bytes',
);
assert.deepEqual(new Uint8Array(cacheReply.output, hiddenColor.length), exactMask);
await cacheWorker.onmessage({ data: { id: 3, type: 'restore', key: 'missing' } });
assert.equal(cacheReply.output, undefined);
// A fresh worker has no in-memory keys: F5 must recover exact RGBA and mask,
// while another input/account digest and corrupt bytes must miss.
const disk = new Map();
const previousCaches = globalThis.caches;
globalThis.caches = { async open() { return {
  async put(key, response) { disk.set(typeof key === 'string' ? key : key.url, response.clone()); },
  async match(key) { return disk.get(typeof key === 'string' ? key : key.url)?.clone(); },
  async keys() { return [...disk.keys()].map(key => new Request(key)); },
  async delete(key) { return disk.delete(typeof key === 'string' ? key : key.url); },
}; } };
const freshWorker = () => {
  const worker = { location: { origin: 'https://li3d.test' }, postMessage: cacheWorker.postMessage };
  new Function('self', 'exports', ts.transpileModule(cacheWorkerSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(worker, {});
  return worker;
};
try {
  const rgba = new Uint8Array(1024 ** 2 * 4).fill(71);
  const mask = new Uint8Array(1024 ** 2).fill(3);
  rgba[3] = 0; rgba[0] = 219;
  const persistentKey = 'a'.repeat(64);
  await freshWorker().onmessage({ data: { id: 1, type: 'store', key: 'runtime-a', persistentKey,
    resolution: 1024, color: rgba.buffer, mask: mask.buffer } });
  assert.equal(disk.size, 1);
  await freshWorker().onmessage({ data: { id: 2, type: 'restore', key: 'new-runtime-url', persistentKey } });
  assert.deepEqual(new Uint8Array(cacheReply.output, 0, rgba.length), rgba);
  assert.deepEqual(new Uint8Array(cacheReply.output, rgba.length), mask);
  await freshWorker().onmessage({ data: { id: 3, type: 'restore', key: 'new-runtime-url', persistentKey: 'b'.repeat(64) } });
  assert.equal(cacheReply.output, undefined, 'Changed source or ownership cannot reuse the saved UV');
  const activeWorker = freshWorker();
  await activeWorker.onmessage({ data: { id: 5, type: 'restore', key: 'a', persistentKey } });
  assert.deepEqual(cacheReply.keys, ['a'], 'F5-restored compressed bytes remain reusable');
  await activeWorker.onmessage({ data: { id: 6, type: 'activate', key: 'a' } });
  for (const [index, key] of ['b', 'c', 'd'].entries()) {
    await activeWorker.onmessage({ data: { id: 10 + index, type: 'store', key, persistentKey: key.repeat(64),
      resolution: 1024, color: new Uint8Array(rgba.length).fill(index).buffer, mask: new ArrayBuffer(0) } });
    await activeWorker.onmessage({ data: { id: 20 + index, type: 'activate', key } });
    await activeWorker.onmessage({ data: { id: 30 + index, type: 'activate', key: 'a' } });
    assert(disk.has('https://li3d.test/__li3d_internal/resident-uv/' + persistentKey), 'Returning to displayed A must keep its disk snapshot');
    assert.equal(disk.size, 2, 'Pinning the visible state must not increase disk capacity');
  }
  await freshWorker().onmessage({ data: { id: 40, type: 'restore', key: 'F5-after-toggles', persistentKey } });
  assert.deepEqual(new Uint8Array(cacheReply.output, 0, rgba.length), rgba, 'F5 after A/B/A/C/A recovers exact A without rebaking');
  const key = [...disk.keys()][0], old = disk.get(key);
  disk.set(key, new Response(new Uint8Array([1, 2, 3]), { headers: old.headers }));
  await freshWorker().onmessage({ data: { id: 4, type: 'restore', key: 'new-runtime-url', persistentKey } });
  assert.equal(cacheReply.output, undefined, 'Corrupt derived UV is rejected');
} finally { globalThis.caches = previousCaches; }
const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
let userId = 'owner-a', sourceByte = 17;
globalThis.window = { caches: {} };
globalThis.fetch = async () => new Response(new Uint8Array([sourceByte]));
try {
  const { persistentMergeKey } = load('persistentMergePreparation', {
    '@/stores/authStore': { useAuthStore: { getState: () => ({ user: userId ? { id: userId } : undefined }) } },
    './uvBakeDebugControls': { getDebugUvBakeStatus: () => ({}) },
    '@/engine/layers/mergeUvComposition': { getMergeUvPostprocessOptions: () => ({}) },
  });
  const group = new THREE.Group(); group.add(new THREE.Mesh(new THREE.PlaneGeometry()));
  const input = { projectId: 'p', objectId: 'o', resolution: 1024, group,
    purpose: 'resident-uv-display-1', layers: [{ id: 'a', imageUrl: '/verified.png', visible: true, order: 0 }] };
  const first = await persistentMergeKey(input);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(await persistentMergeKey(input), first);
  const helper = new THREE.Mesh(new THREE.PlaneGeometry()); helper.userData.liclickPaintOverlay = true;
  group.add(helper);
  assert.equal(await persistentMergeKey(input), first, 'Display-only helper meshes do not invalidate saved UV');
  sourceByte++; assert.notEqual(await persistentMergeKey(input), first, 'Changed bytes at the same URL invalidate UV');
  sourceByte--; userId = 'owner-b'; assert.notEqual(await persistentMergeKey(input), first);
  userId = 'owner-a'; group.children[0].geometry.attributes.uv.array[0] += .1;
  assert.notEqual(await persistentMergeKey(input), first, 'Unversioned geometry edits invalidate UV');
  userId = ''; assert.equal(await persistentMergeKey(input), undefined);
} finally { globalThis.window = oldWindow; globalThis.fetch = oldFetch; }
let maskRevision = 1;
let paints = 0,
  finish;
const presentation = load('../projection/residentUvPresentation', {
  './liveProjectedCanvasTextureRegistry': { getLiveProjectedCanvasState: () => ({ revision: maskRevision }) },
  '@/utils/browserScheduling': {
    async waitForBrowserPaint() {
      paints++;
      if (paints === 2) finish?.();
    },
  },
});
const scene = new THREE.Group(),
  object = new THREE.Group();
scene.add(object);
presentation.markResidentUvPending(object, 'a');
finish = () => presentation.finishResidentUvPresentation(object);
await presentation.waitForResidentUvPresentation(scene, 'a');
assert.equal(paints, 2, 'Capture waits until the UV buffer has actually been bound');
presentation.finishResidentUvPresentation(object, [{ layerId: 'layer', url: 'mask', revision: 1 }]);
assert(presentation.isResidentUvMaskPresented(object, 'layer', 'mask'));
assert(!presentation.isResidentUvMaskPresented(object, 'other', 'mask'));
maskRevision++;
assert(!presentation.isResidentUvMaskPresented(object, 'layer', 'mask'), 'An old UV cannot acknowledge a newer eraser revision');
presentation.markResidentUvPending(object, 'a');
assert(!presentation.isResidentUvMaskPresented(object, 'layer', 'mask'));
presentation.markResidentUvPending(object, 'a', new Error('UV failed'));
await assert.rejects(presentation.waitForResidentUvPresentation(scene, 'a'), /UV failed/);
await presentation.waitForResidentUvPresentation(scene, 'other-object');
// Exercise both page and Worker cache identity after direct UV edits, without
// needsUpdate. A page-only invalidation would still return the old Worker mask.
{
  const source = fs.readFileSync(new URL('../src/engine/bake/webGpuUvTopologyRaster.ts', import.meta.url), 'utf8')
    .replace(/import\.meta\.url/g, "'https://fixture.invalid/module.js'");
  const js = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const requests = [];
  class RasterWorker {
    postMessage(request) {
      requests.push(request);
      globalThis.queueMicrotask(() => this.onmessage({data:{type:'result',id:request.id,
        mask:new Uint8Array(request.width * request.height).buffer,
        backend:'offscreen-canvas-worker',gpuAccepted:false,mismatchedPixels:0,
        rawMismatchedPixels:0,maximumDifference:0,gpuMs:0,cpuGoldMs:0,totalMs:0}}));
    }
    terminate() {}
  }
  const exports = {};
  new Function('require','exports','Worker','window',js)(
    name => name === './uvSeamGeometrySnapshot' ? load('uvSeamGeometrySnapshot',{})
      : ({recordWebGpuProductionDispatch(){}}), exports, RasterWorker,
    {setTimeout,location:{search:''}},
  );
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1,1)); root.add(mesh);
  const uv = mesh.geometry.getAttribute('uv');
  let vertexReads = 0;
  const getX = uv.getX.bind(uv);
  uv.getX = index => {vertexReads++;return getX(index);};
  const first = await exports.rasterizeUvTopologyMaskWithWebGpu(root,8,8);
  assert.ok(vertexReads > 0);
  vertexReads = 0;
  assert.equal((await exports.rasterizeUvTopologyMaskWithWebGpu(root,8,8)).mask,first.mask);
  assert.equal(requests.length,1,'unchanged topology reuses its mask');
  assert.equal(vertexReads,0,'unchanged source bytes never re-expand UV triangles');
  mesh.position.x=2;
  assert.equal((await exports.rasterizeUvTopologyMaskWithWebGpu(root,8,8)).mask,first.mask,'model placement cannot change UV topology');
  uv.array[0] += 0.125;
  assert.notEqual(await exports.rasterizeUvTopologyMaskWithWebGpu(root,8,8),first);
  assert.equal(requests.length,2);
  assert.notEqual(requests[0].cacheKey,requests[1].cacheKey,'Worker also receives a new geometry revision');
  const overlay = new THREE.Mesh(new THREE.PlaneGeometry(1,1));
  overlay.userData.liclickPaintOverlay = true; root.add(overlay);
  await exports.rasterizeUvTopologyMaskWithWebGpu(root,8,8);
  assert.equal(requests.length,2,'paint helpers cannot change the model topology');
  mesh.geometry.index.array[0] = mesh.geometry.index.array[1];
  await exports.rasterizeUvTopologyMaskWithWebGpu(root,8,8);
  assert.equal(requests.length,3,'unversioned index edits also invalidate');
  exports.terminateWebGpuUvTopologyRasterWorker();
}
// The resident display must not expand a 4K one-byte mask into a 64 MiB RGBA
// allocation on the UI thread. Exercise the actual Worker conversion contract
// so channel values and orientation remain explicit and byte-exact.
{
  const displaySource = fs.readFileSync(
    new URL('../src/engine/projection/ResidentProjectedUvDisplay.ts', import.meta.url),
    'utf8',
  );
  assert.match(displaySource, /createWorkerBackedMaskPreviewTexture\(\s*mask,/);
  assert.doesNotMatch(displaySource, /new Uint8ClampedArray\(mask\.length \* 4\)/);
  assert.match(displaySource, /result\.renderedColorMask\?\.length/);
  assert.match(displaySource, /THREE\.RedFormat/);

  const bakeSource = fs.readFileSync(
    new URL('../src/engine/bake/bakeProjectedLayerToTexture.ts', import.meta.url),
    'utf8',
  );
  assert.match(bakeSource, /overlayRasters\.some\(\(\{ layer \}\) => usesUnlitRenderedColor\(layer\)\)/);
  const gpuBakeSource = fs.readFileSync(
    new URL('../src/engine/bake/gpuUvBakeRenderer.ts', import.meta.url),
    'utf8',
  );
  assert.match(gpuBakeSource, /renderedColorMask:new Uint8Array\(0\)/);
  assert.match(gpuBakeSource, /#if MRT == 1/);
  assert.match(gpuBakeSource, /createPostprocessTarget\(resolution, THREE\.RGBAFormat, 2\)/);
  assert.match(
    gpuBakeSource,
    /resident[\s\S]*?renderer\.capabilities\.isWebGL2[\s\S]*?resolution % 2 === 0[\s\S]*?!isOverlay/,
  );
  assert.match(gpuBakeSource, /resident!\.push\(layerColorTarget\.textures\[0\], layerQualityTexture\)/);

  const previewCacheSource = fs.readFileSync(
    new URL('../src/engine/viewport/previewTextureCache.ts', import.meta.url),
    'utf8',
  );
  assert.match(previewCacheSource, /adoptPreviewMaskInWorker[\s\S]*?THREE\.RedFormat/);
  assert.match(previewCacheSource, /webgl2\.RED/);

  const workerSource = fs.readFileSync(
    new URL('../src/workers/previewImageBitmap.worker.ts', import.meta.url),
    'utf8',
  );
  let reply;
  const created = [];
  class FixtureImageData {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  }
  const worker = {
    postMessage(message) {
      reply = message;
    },
  };
  const createFixtureBitmap = async (imageData, options) => {
    created.push({ imageData, options });
    return { width: imageData.width, height: imageData.height, close() {} };
  };
  new Function(
    'self',
    'exports',
    'createImageBitmap',
    'ImageData',
    ts.transpileModule(workerSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
  )(worker, {}, createFixtureBitmap, FixtureImageData);
  const mask = Uint8Array.from([0, 1, 127, 255, 23, 44]);
  await worker.onmessage({
    data: { type: 'adopt-mask', id: 17, mask: mask.buffer, width: 3, height: 2 },
  });
  assert.deepEqual(reply, { type: 'ready', id: 17, width: 3, height: 2 });
  assert.equal(created.length, 0, 'Mask adoption retains one byte per pixel without a bitmap');
  await worker.onmessage({
    data: { type: 'stripe', id: 17, requestId: 31, y: 0, height: 1 },
  });
  assert.equal(reply.type, 'mask-stripe');
  assert.deepEqual(
    [...new Uint8Array(reply.pixels)],
    [255, 23, 44],
    'First upload stripe reads the vertically flipped final mask row',
  );
  await worker.onmessage({
    data: { type: 'stripe', id: 17, requestId: 32, y: 1, height: 1 },
  });
  assert.deepEqual(
    [...new Uint8Array(reply.pixels)],
    [0, 1, 127],
    'Every mask byte keeps the exact red-channel contract',
  );
  await worker.onmessage({ data: { type: 'release', id: 17 } });
  await worker.onmessage({
    data: { type: 'stripe', id: 17, requestId: 33, y: 0, height: 1 },
  });
  assert.match(reply.message, /released/);
  // The same worker transports straight RGBA drafts without a bitmap roundtrip.
  const rgba = Uint8Array.from({ length: 24 }, (_, i) => (i * 47) % 256);
  await worker.onmessage({ data: { type: 'adopt-mask', id: 18, mask: rgba.buffer,
    width: 3, height: 2, channels: 4 } });
  assert.equal(reply.type, 'ready');
  for (const [y, expected] of [[0, rgba.slice(12)], [1, rgba.slice(0,12)]]) {
    await worker.onmessage({ data: { type: 'stripe', id: 18, requestId: 34, y, height: 1 } });
    assert.deepEqual(new Uint8Array(reply.pixels), expected, 'RGBA row/channel/alpha bytes are unchanged');
  }
  assert.equal(created.length, 0, 'RGBA adoption must not allocate a bitmap');
  await worker.onmessage({ data: { type: 'release', id: 18 } });
  await worker.onmessage({ data: { type: 'stripe', id: 18, requestId: 35, y: 0, height: 1 } });
  assert.match(reply.message, /released/);
  await worker.onmessage({ data: { type: 'adopt-mask', id: 19, mask: rgba.buffer,
    width: 3, height: 3, channels: 4 } });
  assert.match(reply.message, /dimensions/);
}
console.log(
  'Resident UV: exact rounding, duplicate candidate reuse, bounded ownership, geometry invalidation and one-byte mask upload passed.',
);
