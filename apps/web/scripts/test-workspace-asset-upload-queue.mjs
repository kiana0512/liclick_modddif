import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { isProjectRevision } from '@liclick/contracts';
import { withWorkspaceAssetUpload } from '../src/services/workspaceAssetUploadQueue.ts';

let active = 0, peak = 0;
const starts = [];
const results = await Promise.allSettled(Array.from({ length: 60 }, (_, i) =>
  withWorkspaceAssetUpload(async () => {
    active++; peak = Math.max(peak, active); starts.push(i);
    try {
      await new Promise(resolve => setTimeout(resolve, i % 4));
      if (i % 11 === 0) throw new Error(`failure-${i}`);
      return i;
    } finally { active--; }
  })));
assert.equal(peak, 3);
assert.equal(active, 0);
assert.deepEqual(starts, Array.from({length:60},(_,i)=>i));
results.forEach((r,i)=>assert.equal(r.status,i%11===0?'rejected':'fulfilled'));
await assert.rejects(withWorkspaceAssetUpload(() => { throw new Error('synchronous'); }), /synchronous/);
assert.equal(await withWorkspaceAssetUpload(async () => 'recovered'), 'recovered');

// Execute the real API module with fake transports, rather than a separate
// queue-only implementation. Production ownership/URL/byte paths stay intact.
const source = fs.readFileSync(new URL('../src/services/workspaceApiClient.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source.replaceAll('import.meta.env.VITE_LICLICK_WORKSPACE_API', 'undefined'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
const originals = Object.fromEntries(['window','fetch','crypto','XMLHttpRequest'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
const bytes = new Uint8Array([0,255,127,4,0,18]);
const blob = new Blob([bytes], {type:'image/png'});
try {
  globalThis.window = {location:{href:'http://10.3.2.59:44770/',origin:'http://10.3.2.59:44770'},setTimeout,clearTimeout};
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:undefined});
  for (const cloud of [false,true]) {
    const exports = {};
    const modules = {
      '@liclick/contracts':{isProjectRevision}, '@/platform/projectApiBase':{getProjectApiBase:()=>''},
      '@/platform/runtimeCapabilities':{isCloudBuild:cloud}, '@/utils/id':{},
      './workspaceApiBase':{getWorkspaceApiBase:()=>''}, './runtimeLayerAssetPersistence':{},
      './workspaceAssetUploadQueue':{withWorkspaceAssetUpload},
    };
    new Function('require','exports',code)(name=>{assert.ok(name in modules,name);return modules[name];},exports);
    active=0; peak=0;
    let requests=0;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('data:')) return new Response(blob);
      active++; peak=Math.max(peak,active); requests++;
      try {
        assert.match(String(url), /^\/api\/projects\/project-[ab]\/assets/);
        assert.equal(options.credentials,'include');
        if (options.body instanceof Blob) assert.deepEqual(new Uint8Array(await options.body.arrayBuffer()),bytes);
        else assert.ok(JSON.parse(options.body).filename.endsWith('.png'));
        await new Promise(resolve=>setTimeout(resolve,2));
        return new Response(JSON.stringify({asset:{url:'/verified.png'}}),{status:201});
      } finally {active--;}
    };
    const calls=Array.from({length:30},(_,i)=>{
      const input={projectId:i%2?'project-a':'project-b',category:'captures',filename:`plane-${i}.png`};
      if(i%3===0)return exports.saveBlobAsset({...input,blob});
      if(i%3===1)return exports.saveDataUrlAsset({...input,dataUrl:'data:image/png;base64,AP9/BAAS'});
      return exports.saveRemoteUrlAsset({...input,url:'https://example.invalid/image.png'});
    });
    const saved=await Promise.all(calls);
    assert.equal(peak,3);assert.equal(active,0);assert.equal(requests,30);
    assert.ok(saved.every(r=>r.asset.url==='/verified.png'));
    globalThis.fetch=async()=>{throw new Error('offline');};
    await assert.rejects(exports.saveBlobAsset({projectId:'project-a',category:'captures',filename:'failed.png',blob}));
    globalThis.fetch=async()=>new Response(JSON.stringify({asset:{url:'/after-failure.png'}}));
    assert.equal((await exports.saveBlobAsset({projectId:'project-a',category:'captures',filename:'next.png',blob})).asset.url,'/after-failure.png');
    for (const payload of [null, [], 'text', 1, {}, {error:0}, {error:''}, {error:'Connection terminated unexpectedly'}]) {
      globalThis.fetch=async()=>new Response(JSON.stringify(payload),{status:500});
      for(const submit of [()=>exports.saveBlobAsset({projectId:'project-a',category:'captures',filename:'error.png',blob}),
        ()=>exports.saveRemoteUrlAsset({projectId:'project-a',category:'captures',filename:'error.png',url:'https://example.invalid/image.png'})]) {
        await assert.rejects(submit(),error=>error.status===500 && error.message===(typeof payload?.error==='string'?payload.error:'Workspace request failed: 500'));
      }
    }
  }
} finally {
  for(const [key,descriptor] of Object.entries(originals)) {
    if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
  }
}
console.log('Shared asset queue: FIFO, max 3, failures/recovery, both API modes, cross-project mixed transports and exact Blob bytes passed.');
