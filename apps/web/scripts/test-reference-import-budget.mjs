import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
import { pipelineTraceDisabled } from './pipeline-trace-test-build.mjs';
const source=fs.readFileSync(new URL('../src/services/referenceImagePreprocessor.ts',import.meta.url),'utf8');
const out={};let calls=0,closed=0,fail=false;
class Reader { readAsDataURL(b){b.arrayBuffer().then(a=>{this.result=`data:${b.type};base64,${Buffer.from(a).toString('base64')}`;this.onload();});} }
vm.runInNewContext(ts.transpileModule(pipelineTraceDisabled(source),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
 exports:out,require:()=>({isWorkspaceAssetUrl:()=>false}),FileReader:Reader,Blob,URL,window:{location:{href:'http://localhost/'}},fetch:async()=>({ok:true,blob:async()=>new Blob([new Uint8Array(4_000_001)],{type:'image/png'})}),
 createImageBitmap:async()=>({width:4096,height:2048,close(){closed++;}}),document:{createElement:()=>({getContext:()=>({clearRect(){},drawImage(){}}),toBlob(fn,type){calls++;fn(fail?null:new Blob([new Uint8Array(calls===1?4_000_001:3_900_000)],{type}));}})}
});
const small=new Blob(['original'],{type:'image/png'});
assert.equal(await out.prepareImportedReferenceImage(small),'data:image/png;base64,b3JpZ2luYWw=');assert.equal(calls,0);
const exact=await out.prepareImportedReferenceImage(new Blob([new Uint8Array(4_000_000)],{type:'image/png'}));assert.equal(Buffer.from(exact.split(',')[1],'base64').length,4_000_000);assert.equal(calls,0);
const large=await out.prepareImportedReferenceImage('http://localhost/ref.png');assert.equal(Buffer.from(large.split(',')[1],'base64').length,3_900_000);assert.equal(calls,2);assert.equal(closed,1);
fail=true;await assert.rejects(out.prepareImportedReferenceImage(new Blob([new Uint8Array(4_000_001)])),/无法压缩/);assert.equal(closed,2);
console.log('Reference import budget passed: unchanged small/boundary images, URL compression, encoded byte limit and cleanup on failure.');
