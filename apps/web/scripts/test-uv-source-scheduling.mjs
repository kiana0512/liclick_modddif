import assert from 'node:assert/strict';
import './test-readback-worker-lifecycle.mjs';
import fs from 'node:fs';
import { setImmediate } from 'node:timers';
import ts from 'typescript';
import * as oldCleanup from './fixtures/uv-cleanup-b3431cb.mjs';
import { padUvIslandGuttersWithTopology } from '../src/engine/bake/dilation.ts';

const bake = fs.readFileSync(new URL('../src/engine/bake/bakeProjectedLayerToTexture.ts', import.meta.url), 'utf8');
const cleanup = bake.slice(bake.indexOf('async function fillTransparentTexelsForViewport'), bake.indexOf('function clampByte'));
let paints = 0;
const next = new Function('waitForBrowserPaint', `const UNPROJECTED_TEXTURE_FILL=[8,9,13], MIN_TRANSPARENT_OUTPUT_ALPHA=8, BAKE_PIXELS_PER_YIELD=32768;
const isViewportInteractionBusy = () => false, yieldToBrowserTask = waitForBrowserPaint;
${ts.transpileModule(cleanup, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}
return {fillTransparentTexelsForViewport, clearWeakTransparentTexels};`)(
  () => new Promise((resolve) => setImmediate(() => { paints++; resolve(); })),
);
let seed = 987;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
for (const width of [1, 17, 257, 2048]) {
  const data = Uint8ClampedArray.from({ length: width * width * 4 }, () => random() % 256);
  // Explicitly include every alpha threshold and all coverage tags.
  for (let i = 3; i < data.length; i += 4) data[i] = [0, 1, 7, 8, 9, 128, 255][(i >>> 2) % 7];
  for (const name of Object.keys(next)) for (const withCoverage of [false, true]) {
    const a = { width, height: width, data: data.slice() }, b = { ...a, data: data.slice() };
    const ac = withCoverage ? Uint8Array.from({ length: width * width }, () => random() % 3) : undefined;
    const bc = ac?.slice();
    await oldCleanup[name](a, ac);
    await next[name](b, bc);
    assert.deepEqual(b, a, `${name}: all RGBA at ${width}`);
    assert.deepEqual(bc, ac, `${name}: coverage at ${width}`);
  }
}
assert(paints > 0, 'large scans allow actual event-loop delivery');

// The skipped second cleanup is an idempotence proof, not a quality shortcut.
// Include filter-only alpha=0/coverage=2 seeds, which MUST retain that cleanup.
let closedCases=0, filterCases=0;
for(let trial=0;trial<300;trial++) {
  const width=1+random()%47,height=1+random()%41,count=width*height;
  const data=Uint8ClampedArray.from({length:count*4},()=>random()%256);
  for(let i=0;i<count;i++)data[i*4+3]=[0,1,5,8,9,64,255][random()%7];
  const mask=Uint8Array.from({length:count},()=>random()%(trial%2?3:2));
  const image={width,height,data}, topology=Uint8Array.from({length:count},()=>random()%2);
  const closed=await next.clearWeakTransparentTexels(image,mask);
  // Mirror seam's missing-coverage donor transfers in random order.
  for(let i=0;i<count;i++) {
    const a=random()%count,b=random()%count;
    if(mask[a] && data[a*4+3] && !(mask[b] && data[b*4+3])) {
      data.set(data.subarray(a*4,a*4+4),b*4);mask[b]=1;
    }
  }
  padUvIslandGuttersWithTopology(image,mask,topology,trial%5,true);
  const expected={...image,data:data.slice()}, expectedMask=mask.slice();
  await oldCleanup.clearWeakTransparentTexels(expected,expectedMask);
  if(closed)closedCases++;else {filterCases++;await next.clearWeakTransparentTexels(image,mask);}
  assert.deepEqual(data,expected.data);assert.deepEqual(mask,expectedMask);
}
assert(closedCases>0 && filterCases>0);
assert.match(bake,/else if \(!copyOnlyAlphaInvariant \|\| input\.enableDilation \|\|\s*\(input\.uvCoverageGapPixels \?\? 0\) > 0 \|\| \(input\.uvInteriorHolePixels \?\? 0\) > 0\)/);
console.log(`UV alpha closure: ${closedCases} copy-only fast paths, ${filterCases} filter-only fallback cases, zero byte/coverage differences.`);

const imageSource = fs.readFileSync(new URL('../src/engine/bake/imageSampler.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('imageSampler.ts', imageSource, ts.ScriptTarget.Latest, true);
const fn = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.body && n.name?.text === 'loadImageData');
const js = ts.transpileModule(fn.getText(tree).replace('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
for (const mode of ['decode', 'reject', 'absent', 'load-error']) {
  const events = [], images = [];
  class Image {
    naturalWidth = 8; naturalHeight = 4;
    constructor() { images.push(this); if (mode === 'absent') this.decode = undefined; }
    set src(value) { this.url = value; }
    decode() { events.push('decode'); return new Promise((resolve, reject) => { this.finish = resolve; this.fail = reject; }); }
  }
  const env = {
    Image, getLiveProjectedTextureSourceState: () => undefined,
    resolveImageAssetUrl: x => x, getImageDataCacheKey: x => x,
    imageDataCache: new Map(), rememberImageData: () => events.push('cache'),
    waitForBrowserPaint: async () => events.push('paint'),
    describeUrlKind: () => 'fixture', isLiveProjectedCanvasUrl: () => false,
    document: { createElement: () => ({ getContext: () => ({
      drawImage: () => events.push('draw'), getImageData: () => ({ data: new Uint8ClampedArray(128) }),
    }) }) },
  };
  const load = new Function('env', `const {${Object.keys(env).join(',')}}=env; ${js}; return loadImageData;`)(env);
  const pending = load('blob:fixture');
  if (mode === 'load-error') {
    images[0].onerror();
    await assert.rejects(pending, /Could not load/);
    assert.equal(events.length, 0);
    continue;
  }
  images[0].onload();
  await Promise.resolve();
  if (mode !== 'absent') {
    assert.deepEqual(events, ['decode'], 'onload cannot publish or draw during decoding');
    if (mode === 'reject') images[0].fail(Error('optional decode rejected'));
    else images[0].finish();
  }
  await pending;
  assert.deepEqual(events.slice(-3), ['paint', 'draw', 'cache']);
}
console.log('UV source scheduling: frozen cleanup RGBA/coverage, event loop, decode barrier/fallback and load failure passed.');

const stripeTree = ts.createSourceFile('imageSampler.ts', imageSource, ts.ScriptTarget.Latest, true);
const stripeFunction = stripeTree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'readStaticSamplingCanvas');
const stripeJs = ts.transpileModule(stripeFunction.getText(stripeTree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const readStripes = new Function('ImageData', 'waitForBrowserPaint', `${stripeJs}; return readStaticSamplingCanvas;`)(
  class { constructor(width, height) { this.width = width; this.height = height; this.data = new Uint8ClampedArray(width * height * 4); } },
  () => new Promise(resolve => setImmediate(resolve)),
);
for (const [width, height] of [[1, 1], [257, 1031], [4097, 2051]]) {
  const pixels = Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => i % 256);
  const output = await readStripes({ getImageData(x, y, w, h) {
    assert.equal(x, 0); assert.equal(w, width); assert(y + h <= height);
    return { data: pixels.slice(y * width * 4, (y + h) * width * 4) };
  } }, width, height);
  assert.deepEqual(output.data, pixels, 'all channels and partial final stripe preserved');
}
await assert.rejects(readStripes({ getImageData() { throw new Error('read failed'); } }, 4096, 4096), /read failed/);
console.log('Static canvas stripe reads: all RGBA, odd dimensions, tail rows and read failure passed.');

const liveSource = { width: 4096, height: 4096, value: 3 };
const liveEnv = {
  getLiveProjectedTextureSourceState: () => ({ revision: 1, source: liveSource }),
  resolveImageAssetUrl: x => x, getImageDataCacheKey: x => x,
  imageDataCache: new Map(), rememberImageData: () => {},
  HTMLImageElement: class {},
  readStaticSamplingCanvas: () => { throw new Error('live snapshot must not yield'); },
  document: { createElement: () => ({ getContext: () => ({
    drawImage: () => {}, getImageData: () => ({ data: new Uint8ClampedArray([liveSource.value]) }),
  }) }) },
};
const liveLoad = new Function('env', `const {${Object.keys(liveEnv).join(',')}}=env; ${js}; return loadImageData;`)(liveEnv);
const snapshot = liveLoad('live:test', 4096);
liveSource.value = 9;
assert.equal((await snapshot).data[0], 3, '4K live source is captured before the caller can mutate it');
console.log('4K live source synchronous snapshot timing preserved.');

// Bitmap consumers must bypass full RGBA reads while retaining synchronous live draw.
{
  let reads=0,drawn=0,closedCanvas;
  const canvas={width:0,height:0,getContext:()=>({drawImage(){drawn=liveSource.value;},getImageData(){reads++;throw Error('unexpected readback');}})};
  const env={...liveEnv,document:{createElement:()=>canvas},createImageBitmap:async source=>{
    closedCanvas=source;return {width:source.width,height:source.height,drawn};
  }};
  const load=new Function('env',`const {${Object.keys(env).join(',')}}=env;${js};return loadImageData;`)(env);
  liveSource.value=4;
  const pending=load('live:test',4096,'bitmap',true);liveSource.value=8;
  const bitmap=await pending;
  assert.equal(bitmap.drawn,4);assert.equal(reads,0);
  assert.equal(bitmap.width,4096);assert.equal(closedCanvas.width,1,'release scratch canvas after bitmap adoption');
}
console.log('GPU source: full-resolution bitmap, no CPU RGBA readback, live timing and scratch release passed.');

// Worker ownership and failure lifecycle: a failed job must not retain a bitmap
// or prevent the next source from creating a fresh worker.
{
  const workerSource=fs.readFileSync(new URL('../src/engine/bake/prepareSamplingBitmap.ts',import.meta.url),'utf8');
  const workerJs=ts.transpileModule(workerSource.replace(/new URL\([^\n]+?import\.meta\.url\)/g,"'sampling-worker'"),
    {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const instances=[];
  class Worker {
    constructor(){instances.push(this);}
    postMessage(message){if(this.failPost)throw Error('post failed');(this.messages??=[]).push(message);}
    terminate(){this.terminated=true;}
  }
  class ImageData { constructor(data,width,height){Object.assign(this,{data,width,height});} }
  const env={exports:{},Worker,ImageData};
  const api=new Function(...Object.keys(env),workerJs+';return exports;')(...Object.values(env));
  const source=new Blob(['source'],{type:'image/png'});
  const a=api.prepareSamplingBitmap(source,4096);await Promise.resolve();
  const worker=instances[0],message=worker.messages[0],output={};
  assert.equal(message.maxDimension,4096);assert.equal(message.blob,source,'immutable blob decoded in worker, no main-thread bitmap copy');
  worker.onmessage({data:{id:message.id,bitmap:output}});
  assert.equal(await a,output);
  const pixelRequest=api.prepareSamplingBitmap(source,4096,true);await Promise.resolve();
  const pixelMessage=worker.messages.at(-1),pixels=new Uint8ClampedArray([1,2,3,4,250,251,252,253]);
  assert.equal(pixelMessage.pixels,true);
  worker.onmessage({data:{id:pixelMessage.id,pixels:pixels.buffer,width:2,height:1}});
  const pixelOutput=await pixelRequest;
  assert.equal(pixelOutput.width,2);assert.equal(pixelOutput.height,1);
  assert.deepEqual(pixelOutput.data,pixels);
  assert.equal(pixelOutput.data.buffer,pixels.buffer,'received owned RGBA is wrapped without a second copy');
  worker.failPost=true;
  await assert.rejects(api.prepareSamplingBitmap(source,1),/post failed/);
  worker.failPost=false;
  const b=api.prepareSamplingBitmap(source,1),c=api.prepareSamplingBitmap(source,1);
  const rejectedB=assert.rejects(b,/worker crash/),rejectedC=assert.rejects(c,/worker crash/);
  await Promise.resolve();worker.onerror({message:'worker crash'});
  await Promise.all([rejectedB,rejectedC]);assert(worker.terminated);
  let orphanClosed=false;worker.onmessage({data:{id:-1,bitmap:{close(){orphanClosed=true;}}}});assert(orphanClosed);
  const retry=api.prepareSamplingBitmap(source,1);await Promise.resolve();assert.equal(instances.length,2);
  const request=instances[1].messages[0];instances[1].onmessage({data:{id:request.id,bitmap:output}});await retry;
}
console.log('Sampling Worker: full dimensions, bitmap ownership, post/crash cleanup, orphan release and recovery passed.');
{
  const source=fs.readFileSync(new URL('../src/workers/gpuReadbackConversion.worker.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  let result;
  const scope={postMessage(message){result=message;}};
  new Function('self','exports','require',code)(scope,{},name=>{
    assert.equal(name,'../engine/bake/dilation');return {padUvIslandGuttersWithTopology};
  });
  for(const resolution of [1,17,255,1024]) {
    const pixels=Uint8Array.from({length:resolution*resolution*4},()=>random()%256);
    const data=new Uint8ClampedArray(pixels.length),coverage=new Uint8Array(resolution*resolution);
    let count=0;
    for(let y=0;y<resolution;y++)data.set(pixels.subarray(y*resolution*4,(y+1)*resolution*4),(resolution-1-y)*resolution*4);
    for(let i=0;i<coverage.length;i++)if(data[i*4+3]>0){coverage[i]=1;count++;}
    scope.onmessage({data:{id:1,mode:'resident',pixels:pixels.buffer,resolution}});
    assert.equal(result.imageData,pixels.buffer,'Resident conversion returns the exclusively transferred buffer without a full RGBA allocation');
    assert.deepEqual(new Uint8ClampedArray(result.imageData),data,'resident output stays straight RGBA including hidden RGB');
    assert.deepEqual(new Uint8Array(result.coverage),coverage);assert.equal(result.coveredPixels,count);
    const expectedCleanup=[];
    for(let i=0;i<coverage.length;i++) if(data[i*4+3]<=8 && data.subarray(i*4,i*4+4).some(Boolean)) expectedCleanup.push(i);
    if(expectedCleanup.length>16384) assert.equal(result.transparentCleanupTexels,undefined,'dense weak coverage uses full cleanup');
    else {
      const texels=new Uint32Array(result.transparentCleanupTexels);
      assert.deepEqual([...texels],expectedCleanup,'bounded weak-texel index is exact');
      const original={width:resolution,height:resolution,data:data.slice()},actual={width:resolution,height:resolution,data:data.slice()};
      const goldMask=coverage.slice(),actualMask=coverage.slice();
      await oldCleanup.clearWeakTransparentTexels(original,goldMask);
      assert.equal(await next.clearWeakTransparentTexels(actual,actualMask,texels),true);
      assert.deepEqual(actual.data,original.data);assert.deepEqual(actualMask,goldMask);
    }
  }
}
console.log('Resident readback Worker: frozen full RGBA, Y orientation, alpha coverage and counts passed.');
{
  const source=fs.readFileSync(new URL('../src/workers/gpuReadbackConversion.worker.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  let result;
  const scope={postMessage(message,transfer){result=globalThis.structuredClone(message,{transfer});}};
  new Function('self','exports','require',code)(scope,{},()=>({padUvIslandGuttersWithTopology}));
  for(let trial=0;trial<180;trial++) {
    const width=1+random()%51,height=1+random()%49,iterations=1+trial%5,alphaMode=[false,true,'rgb-only'][trial%3];
    const topology=Uint8Array.from({length:width*height},()=>random()%3?1:0);
    for(let repeat=0;repeat<2;repeat++) {
      const pixels=Uint8ClampedArray.from({length:width*height*4},()=>random()%256);
      const coverage=Uint8Array.from(topology,()=>random()%3);
      const gold={width,height,data:pixels.slice()},goldCoverage=coverage.slice();
      const expected=padUvIslandGuttersWithTopology(gold,goldCoverage,topology,iterations,alphaMode);
      scope.onmessage({data:{id:trial,mode:'gutter',width,height,pixels:pixels.buffer,coverage:coverage.buffer,
        topology:repeat?undefined:topology,iterations,alphaMode}});
      assert.equal(pixels.byteLength,0);assert.equal(coverage.byteLength,0,'Worker returns ownership, retaining no RGBA');
      assert.equal(result.paddedPixels,expected);assert.deepEqual(new Uint8ClampedArray(result.imageData),gold.data);
      assert.deepEqual(new Uint8Array(result.coverage),goldCoverage);
    }
  }
  scope.onmessage({data:{id:999,mode:'gutter',width:2,height:2,pixels:new ArrayBuffer(1),coverage:new ArrayBuffer(4),iterations:1,alphaMode:true}});
  assert.match(result.error,/Invalid/);
}
console.log('Gutter Worker: 360 cold/warm topology, RGBA/coverage/count, ownership transfer and invalid-input cases passed.');
{
  const source=fs.readFileSync(new URL('../src/workers/prepareSamplingBitmap.worker.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  for(const mode of ['success','decode','draw','transfer','post']) {
    const responses=[],canvases=[];
    const bitmap={width:4096,height:2048,closed:false,close(){this.closed=true;}};
    const output={closed:false,close(){this.closed=true;}};
    class OffscreenCanvas {
      constructor(width,height){this.width=width;this.height=height;canvases.push(this);}
      getContext(){return {drawImage(_source,_x,_y,width,height){assert.equal(width,2048);assert.equal(height,1024);if(mode==='draw')throw Error(mode);}};}
      transferToImageBitmap(){if(mode==='transfer')throw Error(mode);return output;}
    }
    const scope={postMessage(message){if(mode==='post' && message.bitmap)throw Error(mode);responses.push(message);}};
    new Function('self','exports','OffscreenCanvas','createImageBitmap',code)(scope,{},OffscreenCanvas,async()=>{if(mode==='decode')throw Error(mode);return bitmap;});
    await scope.onmessage({data:{id:1,blob:new Blob(),maxDimension:2048}});
    assert.equal(responses.length,1);assert.equal(responses[0].id,1);
    if(mode==='success')assert.equal(responses[0].bitmap,output);else assert.equal(responses[0].error,mode);
    if(mode!=='decode')assert(bitmap.closed);
    assert(canvases.every(canvas=>canvas.width===1 && canvas.height===1));
    if(mode==='post')assert(output.closed,'untransferred output is released');
  }
  for(const mode of ['success','read','post']) {
    const responses=[],canvases=[];
    const bitmap={width:2,height:1,closed:false,close(){this.closed=true;}};
    const pixels=new Uint8ClampedArray([1,2,3,4,250,251,252,253]);
    class OffscreenCanvas {
      constructor(width,height){Object.assign(this,{width,height});canvases.push(this);}
      getContext(){return {
        drawImage(source){assert.equal(source,bitmap);},
        getImageData(x,y,width,height){assert.deepEqual([x,y,width,height],[0,0,2,1]);if(mode==='read')throw Error(mode);return {data:pixels};},
      };}
      transferToImageBitmap(){throw Error('CPU consumer must not create another bitmap');}
    }
    const scope={postMessage(message,transfer){
      if(mode==='post' && message.pixels)throw Error(mode);
      responses.push(globalThis.structuredClone(message,{transfer}));
    }};
    new Function('self','exports','OffscreenCanvas','createImageBitmap',code)(scope,{},OffscreenCanvas,async()=>bitmap);
    await scope.onmessage({data:{id:7,blob:new Blob(),maxDimension:4096,pixels:true}});
    assert.equal(responses.length,1);assert.equal(responses[0].id,7);
    if(mode==='success') {
      assert.deepEqual([...new Uint8ClampedArray(responses[0].pixels)],[1,2,3,4,250,251,252,253]);
      assert.equal(pixels.byteLength,0,'transfer releases worker RGBA ownership');
    } else assert.equal(responses[0].error,mode);
    assert(bitmap.closed);assert(canvases.every(canvas=>canvas.width===1 && canvas.height===1));
  }
}
