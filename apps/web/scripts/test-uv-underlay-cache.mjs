import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

const source=await readFile(new URL('../src/workers/webGpuRgbaComposite.worker.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(pipelineTraceDisabled(source).replace(/^import[^;]+;/gm,'').replace('export {};',''),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None},
}).outputText;
let bytes=new Uint8Array([1,2,3,4]),decodes=0,fetches=0,closed=0,failure=false,decodeGate;
const scope={navigator:{},postMessage(){}};
class Canvas {
  constructor(width,height){this.width=width;this.height=height;}
  getContext(){let image;return {
    clearRect(){},drawImage(bitmap){image=bitmap;},
    getImageData(x,y,width,height){const data=new Uint8ClampedArray(width*height*4);for(let i=0;i<data.length;i+=4)data.set(image.bytes,i);return {data};},
  };}
}
const load=new Function('self','fetch','createImageBitmap','OffscreenCanvas','crypto','yieldWorkerTask',
  `${compiled};return loadUnderlayInWorker;`)(scope,async()=>{
    fetches++;return {ok:!failure,status:failure?403:200,blob:async()=>new Blob([bytes],{type:'image/png'})};
  },async blob=>{
    decodes++;if(decodeGate)await decodeGate;
    return {bytes:new Uint8Array(await blob.arrayBuffer()),width:2,height:2,close(){closed++;}};
  },Canvas,webcrypto,async()=>{});
const request={id:1,type:'composite',underlayUrl:'https://example.test/verified/uv.png',width:2,height:2,opacity:1};
const first=await load(request),expected=new Uint8Array([1,2,3,4,1,2,3,4,1,2,3,4,1,2,3,4]);
assert.deepEqual(new Uint8Array(first),expected);
assert.equal(await load({...request,opacity:0.4}),first,'opacity changes must not decode unchanged UV');
assert.equal(decodes,1);assert.equal(fetches,2,'always check current response/permission before a cache hit');
const front=await load({...request,sourceOver:true});
assert.notEqual(front,first);new Uint8Array(front).fill(99);
assert.deepEqual(new Uint8Array(await load(request)),expected,'source-over cannot mutate the cached underlay');
bytes=new Uint8Array([9,8,7,6]);
const changed=await load(request);assert.notEqual(changed,first);assert.equal(decodes,2);
assert.equal(new Uint8Array(changed)[0],9,'same URL/length with changed bytes invalidates');
await load({...request,width:1});assert.equal(decodes,3);
failure=true;await assert.rejects(load({...request,width:1}),/403/);failure=false;
assert.equal(decodes,3,'permission failure must not publish cached pixels');
scope.onmessage({data:{type:'release'}});
await load({...request,width:1});assert.equal(decodes,4);
scope.onmessage({data:{type:'cancel',id:77}});
await assert.rejects(load({...request,id:77}),/cancel/i);
assert.equal(closed,decodes);
scope.onmessage({data:{type:'release'}});
let open;decodeGate=new Promise(resolve=>{open=resolve;});
const pending=load(request);
while(decodes===4)await new Promise(resolve=>setTimeout(resolve,1));
scope.onmessage({data:{type:'release'}});open();await pending;decodeGate=undefined;
await load(request);assert.equal(decodes,6,'release during decode prevents old cache repopulation');
assert.equal(closed,decodes,'every decoded bitmap is closed');
console.log('UV underlay cache: exact bytes, unchanged decode reuse, changed content/dimensions, source-over ownership, permission failure, cancellation and release races passed.');

// Exercise the actual Worker queue: an obsolete network fetch must abort,
// allowing the final eye state to run without waiting for the old response.
const responses = [], fetchSignals = [];
const queueScope = { navigator: {}, postMessage: response => responses.push(response) };
const queued = new Function('self', 'fetch', 'createImageBitmap', 'OffscreenCanvas', 'crypto', 'yieldWorkerTask',
  `${compiled};return { drain: () => workQueue };`)(queueScope, async (url, options) => {
    fetchSignals.push(options.signal);
    if (url === 'blocked-underlay') return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('fetch aborted', 'AbortError')), { once: true });
    });
    return { ok: true, blob: async () => new Blob([new Uint8Array([9, 8, 7, 255])], { type: 'image/png' }) };
  }, async blob => ({ bytes: new Uint8Array(await blob.arrayBuffer()), width: 2, height: 2, close() {} }),
  Canvas, webcrypto, async () => {});
const queuedRequest = id => ({ ...request, id, front: new Uint8Array(16).buffer,
  verify: true, interactive: false, interactiveChunkBytes: 1048576, idleChunkBytes: 8388608 });
queueScope.onmessage({ data: { ...queuedRequest(201), underlayUrl: 'blocked-underlay' } });
for (let tick = 0; tick < 10; tick++) await Promise.resolve();
assert.equal(fetchSignals.length, 1);
queueScope.onmessage({ data: { type: 'cancel', id: 201 } });
queueScope.onmessage({ data: { ...queuedRequest(202), underlayUrl: 'latest-underlay' } });
await queued.drain();
assert(fetchSignals[0].aborted, 'Cancel aborts the in-flight fetch');
assert.deepEqual(responses.map(({ id, type }) => [id, type]), [[201, 'error'], [202, 'result']]);
assert.deepEqual(new Uint8Array(responses[1].output), new Uint8Array([9, 8, 7, 255, 9, 8, 7, 255, 9, 8, 7, 255, 9, 8, 7, 255]));
console.log('Worker underlay fetch cancellation: blocked stale response aborted; latest full pixels published without waiting.');

// Exercise the production dispatch with observable GPU transport. Decoded bytes
// are immutable; only the verified cache object may become an upload hit.
const uploads=[];
let target={front:{},underlay:{}};
const gpuApi=new Function('self','yieldWorkerTask',`${compiled};
 getDevice=async()=>({});
 getResources=()=>target();
 uploadInBudgetedChunks=async(_device,buffer,bytes)=>upload(buffer,bytes);
 computeInBudgetedChunks=async()=>{};
 copyToReadbackInBudgetedChunks=async(_device,_target,request)=>request.front.slice(0);
 return {run:runComposite, cpu:compositeOnCpu, budgeted:compositeOnCpuBudgeted,
 cache: pixels=>{underlayCache={key:'verified',pixels};},
 bind:(getTarget,onUpload)=>{target=getTarget;upload=onUpload;}};
 var target,upload;
` )({navigator:{},postMessage(){}},async()=>{});
gpuApi.bind(()=>target,(buffer,bytes)=>uploads.push({buffer,bytes}));
const backdrop=new Uint8Array(16).fill(99).buffer;
gpuApi.cache(backdrop);
const gpuRequest={...queuedRequest(500),underlay:backdrop};
assert.equal((await gpuApi.run(gpuRequest)).metrics.bytesTransferred,48);
assert.equal((await gpuApi.run({...gpuRequest,opacity:0.4})).metrics.bytesTransferred,32);
assert.equal(uploads.filter(value=>value.buffer===target.underlay).length,1,'unchanged verified UV skips only underlay upload');
const replacement=backdrop.slice(0);gpuApi.cache(replacement);
await gpuApi.run({...gpuRequest,underlay:replacement});
assert.equal(uploads.filter(value=>value.buffer===target.underlay).length,2,'new verified bytes invalidate GPU upload');
const originalTarget=target;target={front:{},underlay:{}};
await gpuApi.run({...gpuRequest,underlay:replacement});
assert.equal(uploads.filter(value=>value.buffer===target.underlay).length,1,'new device resources require upload');
const raw=backdrop.slice(0);
await gpuApi.run({...gpuRequest,underlay:raw});await gpuApi.run({...gpuRequest,underlay:raw});
assert.equal(uploads.filter(value=>value.buffer===target.underlay).length,3,'unverified mutable input is never reused');
assert(originalTarget.underlaySource instanceof WeakRef,'GPU metadata must not pin a retired CPU decode');
gpuApi.cache(backdrop);
gpuApi.bind(()=>target,(buffer)=>{if(buffer===target.underlay)throw Error('upload failed');});
assert.equal((await gpuApi.run({...gpuRequest,front:gpuRequest.front.slice(0)})).metrics.backend,'cpu-worker');
assert.equal(target.underlaySource,undefined,'failed or partial uploads cannot become cache hits');
gpuApi.bind(()=>target,(buffer,bytes)=>uploads.push({buffer,bytes}));
await gpuApi.run({...gpuRequest,front:gpuRequest.front.slice(0)});
assert.equal(target.underlaySource.deref(),backdrop,'successful retry restores exact verified identity');
for(const size of [4,1028,262148,524300])for(const opacity of [0,0.37,1])for(const frontOpacity of [0,0.51,1]){
 const front=Uint8Array.from({length:size},(_,i)=>(i*37+(i>>>8))&255).buffer;
 const under=Uint8Array.from({length:size},(_,i)=>(i*71)&255).buffer;
 const expected=gpuApi.cpu(front.slice(0),under,opacity,frontOpacity);
 const actual=await gpuApi.budgeted(front.slice(0),under,opacity,{...gpuRequest,frontOpacity});
 assert.deepEqual(new Uint8Array(actual),new Uint8Array(expected));
}
console.log('UV GPU underlay upload: exact verified identity, changed bytes/resources, mutable inputs, transfer metrics and budgeted CPU parity passed.');

// Queue-wide waits must not gate bounded mapping. A mapping itself waits until
// this buffer's submitted copy has completed; mapped memory is never read early.
const readbackApi = new Function('self', 'yieldWorkerTask', `${compiled}; return copyToReadbackInBudgetedChunks;`)(
  {navigator: {}, postMessage() {}}, async () => {},
);
for (const size of [4, 8 * 1024 * 1024 + 4, 16 * 1024 * 1024]) {
  const expected = Uint8Array.from({length: size}, (_, i) => (i * 37 + (i >>> 17)) & 255);
  const storage = new Uint8Array(size);
  let mapped = false, command, mappings = 0;
  const device = {
    createCommandEncoder: () => ({
      copyBufferToBuffer(_src, sourceOffset, _dst, destinationOffset, length) {
        command = {sourceOffset, destinationOffset, length};
      }, finish: () => command,
    }),
    queue: {
      submit: commands => {command = commands[0];},
      onSubmittedWorkDone: () => {throw Error('Redundant queue-wide fence');},
    },
  };
  const readback = {
    async mapAsync(_mode, offset, length) {
      assert.equal(mapped, false); assert.equal(offset, command.destinationOffset);
      assert.equal(length, command.length); assert(length <= 8 * 1024 * 1024);
      await Promise.resolve();
      storage.set(expected.subarray(command.sourceOffset, command.sourceOffset + length), offset);
      mapped = true; mappings++;
    },
    getMappedRange(offset, length) {
      assert(mapped, 'GPU-owned memory cannot be read before mapAsync completes');
      return storage.slice(offset, offset + length).buffer;
    },
    unmap() { assert(mapped); mapped = false; },
  };
  const actual = await readbackApi(device, {front: {}, readback, byteLength: size}, gpuRequest);
  assert.deepEqual(new Uint8Array(actual), expected);
  assert.equal(mapped, false); assert.equal(mappings, Math.ceil(size / (8 * 1024 * 1024)));
}
console.log('UV bounded mapping: buffer completion without redundant queue fences, full/tail bytes and unmap passed.');
import { pipelineTraceDisabled } from './pipeline-trace-test-build.mjs';
