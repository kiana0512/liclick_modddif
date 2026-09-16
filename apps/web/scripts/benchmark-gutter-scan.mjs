import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
import * as THREE from 'three';
import assert from 'node:assert/strict';
const root=new URL('../../../',import.meta.url),file='apps/web/src/engine/bake/dilation.ts';
const load=source=>{
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const exports={};new Function('require','exports',code)(name=>{assert.equal(name,'three');return THREE;},exports);
 return exports.padUvIslandGuttersWithTopology;
};
const old=load(execFileSync('git',['show',`4c6da2f7:${file}`],{cwd:root,encoding:'utf8'}));
const next=load(fs.readFileSync(new URL(file,root),'utf8'));
const size=4096,topology=new Uint8Array(size*size),coverage=new Uint8Array(size*size),pixels=new Uint8ClampedArray(size*size*4);
for(let y=1500;y<2500;y++)for(let x=1500;x<2500;x++){
 const i=y*size+x;topology[i]=coverage[i]=1;pixels.set([x&255,y&255,177,255],i*4);
}
let gold;
for(const [name,fn] of [['old',old],['new',next]]){
 const timings=[];
 for(let i=0;i<4;i++){
  const image={width:size,height:size,data:pixels.slice()},mask=coverage.slice();
  const started=performance.now();const count=fn(image,mask,topology,8,true,true);timings.push(performance.now()-started);
  if(!gold)gold={pixels:image.data,mask,count};
  else {assert.deepEqual(image.data,gold.pixels);assert.deepEqual(mask,gold.mask);assert.equal(count,gold.count);}
 }
 console.log(JSON.stringify({name,timings,count:gold.count}));
}
