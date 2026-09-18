import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/engine/bake/persistentMergePreparation.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source.replace(/^import[^\n]+\n/gm,''),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
const stored=new Map();
let copiedSlices=0;
const cache={match:async req=>stored.get(req.url)?.clone(),put:async(req,res)=>stored.set(req.url,res),
  keys:async()=>[...stored.keys()].map(url=>new Request(url)),delete:async req=>stored.delete(req.url)};
class Pixels {constructor(data,width,height){this.data=data;this.width=width;this.height=height;}}
let user='user-a';
let activeFetches=0,peakFetches=0;
let activeDigests=0,peakDigests=0;
const fetched=[];
const crypto={subtle:{digest:async(...args)=>{
  activeDigests++;peakDigests=Math.max(peakDigests,activeDigests);
  await new Promise(resolve=>setTimeout(resolve,2));
  try{return await globalThis.crypto.subtle.digest(...args);}finally{activeDigests--;}
}}};
const scope={exports:{},crypto,window:{caches:{}},caches:{open:async()=>cache},
  yieldToBrowserTask:async()=>{copiedSlices++;await new Promise(resolve=>setTimeout(resolve,0));},
  location:{origin:'https://test.invalid'},Request,Response,TextEncoder,TextDecoder:globalThis.TextDecoder,ImageData:Pixels,
  document:{createElement:()=>({})},useAuthStore:{getState:()=>({user:{id:user}})},
  getDebugUvBakeStatus:()=>({}),getMergeUvPostprocessOptions:()=>({gutter:8}),
  fetch:async(url)=>{
    fetched.push(url);activeFetches++;peakFetches=Math.max(peakFetches,activeFetches);
    await new Promise(resolve=>setTimeout(resolve,1));
    activeFetches--;return new Response(new Uint8Array([9,8,7,6]));
  },
};
const api=new Function(...Object.keys(scope),code+';return exports;')(...Object.values(scope));
const makeGroup=()=>{
  const attributes={position:{array:new Float32Array([0,1,2]),itemSize:3,normalized:false,count:1},
    uv:{array:new Float32Array([0,1]),itemSize:2,normalized:false,count:1}};
  const mesh={uuid:Math.random().toString(),isMesh:true,userData:{},visible:true,matrixWorld:{elements:[1]},
    geometry:{getAttribute:name=>attributes[name],index:null,drawRange:{start:0,count:1},groups:[]}};
  return {attributes,mesh,group:{updateMatrixWorld(){},traverse:fn=>fn(mesh)}};
};
const a=makeGroup(),b=makeGroup();
const input={projectId:'project',objectId:'object',resolution:512,group:a.group,
  layers:[{id:'layer',order:0,imageUrl:'blob:old'}]};
const key=await api.persistentMergeKey(input);
assert.ok(key);
fetched.length=0;peakFetches=0;
peakDigests=0;
const manyLayers=Array.from({length:9},(_,i)=>({id:`layer-${i}`,order:i,imageUrl:`blob:source-${i%7}`}));
assert.ok(await api.persistentMergeKey({...input,layers:manyLayers}));
assert.equal(fetched.length,7,'shared source assets are verified only once per key');
assert.equal(peakFetches,3,'source verification overlaps network waits within a fixed memory bound');
assert(peakDigests>=4,'bounded geometry and source SHA queues overlap instead of serializing');
assert(peakDigests<=5,'two geometry and three source SHA jobs are the global concurrency bound');
assert.equal(await api.persistentMergeKey({...input,group:b.group,layers:[{...input.layers[0],imageUrl:'blob:new'}]}),key,
  'reload UUIDs and blob URLs do not invalidate identical geometry/source bytes');
b.attributes.uv.array[0]=0.5;
assert.notEqual(await api.persistentMergeKey({...input,group:b.group}),key,'changed UV bytes invalidate');
user='user-b';assert.notEqual(await api.persistentMergeKey(input),key,'user cache namespace is isolated');user='user-a';
const result={report:{width:512,height:512},bakedTexture:{id:'derived'},
  imageData:new Pixels(new Uint8ClampedArray(512*512*4).fill(123),512,512)};
await api.writePersistentMerge(key,result);
const restored=await api.readPersistentMerge(key,512);
assert.deepEqual(restored.imageData.data,result.imageData.data);
assert.equal(await api.readPersistentMerge(key,1024),undefined,'resolution is checked');
const url=[...stored.keys()][0];const response=stored.get(url);const bytes=new Uint8Array(await response.arrayBuffer());
bytes[bytes.length-1]^=1;stored.set(url,new Response(bytes,{headers:response.headers}));
assert.equal(await api.readPersistentMerge(key,512),undefined,'corrupt bytes cannot bypass SHA-256 verification');
// Exercise the real streamed body with full 4K bytes, including transparent RGB.
const full=new Uint8ClampedArray(4096*4096*4);
for(let i=0;i<full.length;i++) full[i]=(i*37+(i>>>16))&255;
const fullResult={report:{width:4096,height:4096},bakedTexture:{id:'4k'},imageData:new Pixels(full,4096,4096)};
const fullKey='full';
await api.writePersistentMerge(fullKey,fullResult);
const fullResponse=stored.get('https://test.invalid/__li3d_internal/merge-preparation/full');
const reader=fullResponse.clone().body.getReader();let chunkCount=0,total=0;
while(true){const {value,done}=await reader.read();if(done)break;assert(value.length<=1048576);chunkCount++;total+=value.length;}
assert.equal(chunkCount,65,'full pixels plus metadata are streamed in bounded chunks');
assert(total>full.length);
const originalFirst=full[0];full[0]^=255;
const fullRestored=await api.readPersistentMerge(fullKey,4096);
assert.equal(fullRestored.imageData.data[0],originalFirst,'writer retains a private immutable snapshot');
full[0]=originalFirst;assert.deepEqual(fullRestored.imageData.data,full);
assert(copiedSlices>=64,'large copies cross scheduling boundaries');
console.log('Persistent Merge cache: cross-reload geometry/source identity, user isolation, UV invalidation, exact RGBA restore, resolution and corruption checks passed.');
