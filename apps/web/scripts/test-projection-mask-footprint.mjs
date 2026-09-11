import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const read=file=>fs.readFileSync(new URL(file,import.meta.url),'utf8');
function extract(source,name){const ast=ts.createSourceFile('test.ts',source,ts.ScriptTarget.Latest,true);return ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast);}
class Pixels{constructor(data,width,height){this.data=data;this.width=width;this.height=height;}}
function compile(source,deps={}){const exports={};new Function('exports','ImageData',...Object.keys(deps),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(exports,Pixels,...Object.values(deps));return exports;}
const sampler=compile(extract(read('../src/engine/bake/imageSampler.ts'),'sampleImageBilinear')).sampleImageBilinear;
const load=source=>compile(source,{sampleImageBilinear:sampler}).applyProjectedAlphaMask;
const old=load(read('fixtures/projected-alpha-mask-v1.ts'));
const current=load(extract(read('../src/engine/projection/createMaskedProjectedImage.ts'),'applyProjectedAlphaMask'));
let seed=817;const random=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
for(let test=0;test<400;test++){
  const width=1+random()%130,height=1+random()%99,mw=1+random()%80,mh=1+random()%73;
  const image=new Pixels(Uint8ClampedArray.from({length:width*height*4},()=>random()%256),width,height);
  const mask=new Pixels(new Uint8ClampedArray(mw*mh*4),mw,mh);
  for(let i=0;i<mask.data.length;i+=4)if(test%5===0||random()%97===0)mask.data.set([random()%256,random()%256,random()%256,random()%256],i);
  for(const ignoreSourceAlpha of [false,true])assert.deepEqual(current(image,mask,{ignoreSourceAlpha}),old(image,mask,{ignoreSourceAlpha}),`case ${test}`);
}
const image=new Pixels(new Uint8ClampedArray(2048*2048*4).fill(219),2048,2048),mask=new Pixels(new Uint8ClampedArray(1024*1024*4),1024,1024);
for(let y=500;y<550;y++)for(let x=700;x<740;x++)mask.data.set([255,255,255,255],(y*1024+x)*4);
const before=performance.now(),reference=old(image,mask,{ignoreSourceAlpha:true}),oldMs=performance.now()-before;
const start=performance.now(),actual=current(image,mask,{ignoreSourceAlpha:true}),newMs=performance.now()-start;
assert.deepEqual(actual,reference);console.log(JSON.stringify({cases:800,oldMs,newMs}));
