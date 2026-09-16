import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
const read=name=>fs.readFileSync(new URL('../src/engine/bake/'+name,import.meta.url),'utf8');
const window={location:{search:''},localStorage:{getItem:()=> 'cpu',removeItem(){}}};
const compile=(source,dependencies={})=>{
  const exports={};
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  new Function('exports','require','window',code)(exports,name=>dependencies[name]??{},window);
  return exports;
};
const debug=compile(read('uvBakeDebugControls.ts'));
const source=read('residentQualityComposite.ts');
let verificationYields=0;
let onYield;
const dependencies={'./uvBakeDebugControls':debug,'@/utils/browserScheduling':{async yieldToBrowserTask(){verificationYields++;onYield?.();}}};
const api=compile(source.slice(0,source.indexOf('// ALG-UV-003')),dependencies);
{
  const full=compile(source,{...dependencies,three:THREE});
  const gold=full.createResidentQualityScoreTable();
  const preparation=full.prepareResidentQualityScores();
  assert.equal(full.prepareResidentQualityScores(),preparation,'parallel modes share one immutable preparation');
  await preparation;
  const first=new full.ResidentQualityComposite({},1),second=new full.ResidentQualityComposite({},1);
  assert.deepEqual(new Uint8Array(first.scoreTexture.image.data.buffer),new Uint8Array(gold.buffer),
    'cooperative preparation preserves every Float32 lookup bit');
  assert.equal(first.scoreTexture.image.data,second.scoreTexture.image.data,'reuse CPU lookup without sharing GPU texture owners');
  assert.notEqual(first.scoreTexture,second.scoreTexture);first.dispose();second.dispose();
}
const renderer=()=>{let lost;return {domElement:{addEventListener:(_,cb)=>lost=cb},lose:()=>lost()};};
for(const search of ['', '?perfResidentQuality=0', '?perfQualityCpuGold=1']) {
  window.location.search=search;
  assert.equal(debug.getDebugUvBakeMethod(),'gpu','stale debug storage cannot route normal users to CPU');
  const r=renderer();
  assert.equal(api.residentQualityPolicy(r,false).retainRasters,true,'first result retains full QA');
  const result=()=>({imageData:{data:new Uint8ClampedArray([20,21,22,255])}});
  const gpu=result(),cpu=result();
  assert.equal(await api.verifyResidentQuality(r,false,gpu,cpu),gpu);
  assert.equal(api.residentQualityPolicy(r,false).retainRasters,false,'only verified mode omits readbacks');
  r.lose();assert.equal(api.residentQualityPolicy(r,false).retainRasters,true,'context loss requires QA again');
  cpu.imageData.data[3]=0;
  await assert.rejects(api.verifyResidentQuality(r,false,gpu,cpu),/validation failed/);
  assert.throws(()=>api.residentQualityPolicy(r,false),/validation failed/,'never silently fall back');
}
{
  const r=renderer();api.residentQualityPolicy(r,false);
  const result=()=>({imageData:{data:new Uint8ClampedArray(4096*4096*4).fill(255)}});
  const gpu=result(),cpu=result();
  assert.equal(await api.verifyResidentQuality(r,false,gpu,cpu),gpu);
  assert(verificationYields>0,'full 4K QA must give input a task boundary');
  cpu.imageData.data[cpu.imageData.data.length-4]=253;
  await assert.rejects(api.verifyResidentQuality(r,false,gpu,cpu),/validation failed/,'the last pixel is still verified');
  const next=renderer();api.residentQualityPolicy(next,false);onYield=()=>{onYield=undefined;next.lose();};
  await assert.rejects(api.verifyResidentQuality(next,false,gpu,gpu),error=>error.name==='AbortError');
  assert.equal(api.residentQualityPolicy(next,false).retainRasters,true,'old-context QA cannot approve the replacement');
}
window.location.search='?perfLab=1&perfQualityCpuGold=1';
assert.equal(debug.getDebugUvBakeMethod(),'cpu');
assert.equal(api.residentQualityPolicy(renderer(),false),undefined);
const bake=read('bakeProjectedLayerToTexture.ts');
const parsed=ts.createSourceFile('bake.ts',bake,ts.ScriptTarget.Latest,true);
const entry=parsed.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='bakeProjectedLayerToTexture');
const entryCode=ts.transpileModule(entry.getText(parsed),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const exports={};let dispatched;
new Function('exports','useLayerStore','bakeVisibleProjectedLayersToTexture','flushLiveUvCommits',entryCode)(exports,
  {getState:()=>({layers:[{id:'a',type:'projected',camera:{},opacity:1}]})},input=>{dispatched=input;return {};},async()=>{});
await exports.bakeProjectedLayerToTexture({layerId:'a',objectId:'o',resolution:4096,opacity:0.4});
assert.equal(dispatched.method,'gpu');assert.equal(dispatched.disableGpuFallback,true);
assert.equal(dispatched.transientLayers[0].opacity,0.4);
console.log('Resident UV policy: normal/single-layer GPU routing, stale flags ignored, exact QA, rejection and context loss passed.');
const mergeSource=fs.readFileSync(new URL('../src/engine/layers/mergeUvComposition.ts',import.meta.url),'utf8');
const mergeAst=ts.createSourceFile('merge.ts',mergeSource,ts.ScriptTarget.Latest,true);
const profile=mergeAst.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='getMergeUvPostprocessOptions');
const merge=compile(profile.getText(mergeAst));
for(const resolution of [512,1024,2048,4096,8192]) {
  const options=merge.getMergeUvPostprocessOptions(resolution);
  assert.equal(options.uvCoverageGapPixels,0);assert.equal(options.uvInteriorHolePixels,0);
  assert(options.uvIslandGutterPixels>0,'filter padding is a separate retained operation');
}
console.log('Merge v8: automatic topology growth and hole repair disabled at every resolution.');
const shell=fs.readFileSync(new URL('../src/layouts/EditorShell.tsx',import.meta.url),'utf8');
assert.match(shell,/\(\['1K', '2K', '4K'\] as const\)\.map/,'editor offers only supported output sizes');
assert.doesNotMatch(shell,/\['1K', '2K', '4K', '8K'\]/,'8K is no longer selectable');
const settings=fs.readFileSync(new URL('../src/stores/settingsStore.ts',import.meta.url),'utf8');
assert.match(settings,/type Resolution = '1K' \| '2K' \| '4K' \| '8K'/,'old project schema is still readable; no silent downsampling migration');
