import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/engine/bake/incrementalUvComposite.ts',import.meta.url),'utf8');
class Pixels { constructor(data,width,height){this.data=data;this.width=width;this.height=height;} }
const exports={};new Function('exports','ImageData',ts.transpileModule(source,{compilerOptions:{
  module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,Pixels);
const {eraserBakeRegion:region,copyRawUvComposite:copy,patchRawUvComposite:patch}=exports;
assert.equal(region(undefined,2048),undefined);
assert.equal(region({x:NaN,y:1,width:2,height:2},2048),undefined);
assert.equal(region({x:0,y:0,width:2048,height:2048},2048),undefined);
assert.deepEqual(region({x:1000,y:700,width:50,height:70},2048),{x:896,y:640,size:512});
assert.deepEqual(region({x:2000,y:2000,width:48,height:48},2048),{x:1536,y:1536,size:512});
for(let x=0;x<2048;x+=37)for(let y=0;y<2048;y+=71){
  const b={x,y,width:Math.min(120,2048-x),height:Math.min(130,2048-y)},r=region(b,2048);
  assert(r && r.x<=Math.max(0,x-2) && r.y<=Math.max(0,y-2));
  assert(r.x+r.size>=Math.min(2048,x+b.width+2));
  assert(r.y+r.size>=Math.min(2048,y+b.height+2));
}
const make=(size,value,rendered)=>({imageData:new Pixels(new Uint8ClampedArray(size*size*4).fill(value),size,size),
  coverage:new Uint8Array(size*size).fill(value?1:0),renderedColorMask:new Uint8Array(rendered?size*size:0).fill(value),
  writtenTexels:value?size*size:0});
for(const rendered of [false,true]) {
  const base=make(1024,67,rendered),saved=copy(base),tile=make(512,0,false);
  const result=patch(base,tile,{x:128,y:256,size:512});
  assert.equal(result.writtenTexels,1024**2-512**2);
  for(let y=0;y<1024;y++)for(let x=0;x<1024;x++){
    const erased=x>=128&&x<640&&y>=256&&y<768,i=y*1024+x;
    assert.equal(result.imageData.data[i*4],erased?0:67);
    assert.equal(result.coverage[i],erased?0:1);
    if(rendered)assert.equal(result.renderedColorMask[i],erased?0:67);
  }
  assert.deepEqual(base,saved);
  result.imageData.data.fill(255);assert.deepEqual(base,saved);
  assert.throws(()=>patch(base,tile,{x:900,y:0,size:512}),/Invalid/);
  assert.throws(()=>patch(base,tile,{x:.5,y:0,size:512}),/Invalid/);
}
const expanded=patch(make(1024,0,false),make(512,111,true),{x:512,y:512,size:512});
assert.equal(expanded.renderedColorMask.length,1024**2);
assert.equal(expanded.renderedColorMask[1024*700+700],111);
assert.equal(expanded.writtenTexels,512**2);
console.log('Incremental UV region, padding, raw ownership, coverage and rendered-color preservation passed.');
