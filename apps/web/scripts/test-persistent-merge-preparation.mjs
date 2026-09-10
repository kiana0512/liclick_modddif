import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/engine/bake/persistentMergePreparation.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source.replace(/^import[^\n]+\n/gm,''),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
const stored=new Map();
const cache={match:async req=>stored.get(req.url)?.clone(),put:async(req,res)=>stored.set(req.url,res),
  keys:async()=>[...stored.keys()].map(url=>new Request(url)),delete:async req=>stored.delete(req.url)};
class Pixels {constructor(data,width,height){this.data=data;this.width=width;this.height=height;}}
let user='user-a';
const scope={exports:{},crypto:globalThis.crypto,window:{caches:{}},caches:{open:async()=>cache},
  location:{origin:'https://test.invalid'},Request,Response,TextEncoder,TextDecoder:globalThis.TextDecoder,ImageData:Pixels,
  document:{createElement:()=>({})},useAuthStore:{getState:()=>({user:{id:user}})},
  getDebugUvBakeStatus:()=>({}),getMergeUvPostprocessOptions:()=>({gutter:8}),
  fetch:async()=>new Response(new Uint8Array([9,8,7,6])),
};
const api=new Function(...Object.keys(scope),code+';return exports;')(...Object.values(scope));
const makeGroup=()=>{
  const attributes={position:{array:new Float32Array([0,1,2]),itemSize:3,normalized:false,count:1},
    uv:{array:new Float32Array([0,1]),itemSize:2,normalized:false,count:1}};
  const mesh={uuid:Math.random().toString(),isMesh:true,visible:true,matrixWorld:{elements:[1]},
    geometry:{getAttribute:name=>attributes[name],index:null,drawRange:{start:0,count:1},groups:[]}};
  return {attributes,mesh,group:{updateMatrixWorld(){},traverse:fn=>fn(mesh)}};
};
const a=makeGroup(),b=makeGroup();
const input={projectId:'project',objectId:'object',resolution:512,group:a.group,
  layers:[{id:'layer',order:0,imageUrl:'blob:old'}]};
const key=await api.persistentMergeKey(input);
assert.ok(key);
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
console.log('Persistent Merge cache: cross-reload geometry/source identity, user isolation, UV invalidation, exact RGBA restore, resolution and corruption checks passed.');
