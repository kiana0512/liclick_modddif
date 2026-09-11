import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/engine/bake/mergeProjectionPreparation.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source.replace(/^import[^\n]+\n/gm,'').replace("const {bakeVisibleProjectedLayersToTexture}=await import('./bakeProjectedLayerToTexture');",''),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
class Pixels {
  constructor(data,width=1,height=1){this.data=data;this.width=width;this.height=height;}
}
let calls=0,tick,listener,clock=0,managed=false;
const queued=[];
const finalInputs=[];
let layers=[{id:'a',type:'projected',visible:true,imageUrl:'a',camera:{},order:0},
  {id:'b',type:'projected',visible:true,imageUrl:'b',camera:{},order:1}];
const group={userData:{},revision:1};
const model={objectId:'object',group};
const scope={cancelMergeFinalPreparation:()=>{},prepareMergeFinal:async(_signature,_image,underlays)=>{finalInputs.push(underlays);},isFlattenableUvMergeSource:layer=>layer.type==='uv',isContentAwareUvUnderlay:()=>true,compareUvLayersForComposition:()=>0,persistentMergeKey:async()=>undefined,readPersistentMerge:async()=>undefined,writePersistentMerge:async()=>{},exports:{},DOMException,AbortController:globalThis.AbortController,performance:{now:()=>clock},
  document:{visibilityState:'visible',body:{dataset:{}}},
  window:{setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{tick=undefined;}},
  useLayerStore:{getState:()=>({layers:[...layers,{id:'repair',type:'uv',visible:true,imageUrl:'repair.png',opacity:1}]}),subscribe:fn=>{listener=fn;return ()=>{listener=undefined;};}},
  useSceneStore:{getState:()=>({importedModel:model})},
  useProjectStore:{getState:()=>({getCurrentProject:()=>({id:'project'})})},
  isViewportInteractionBusy:()=>false,
  createReusableProjectionBakeSignature:input=>JSON.stringify({...input,canPrepare:undefined}),
  cloneProjectionBakeImageData:image=>new Pixels(image.data.slice()),
  getMergeUvPostprocessOptions:()=>({uvIslandGutterPixels:2,uvInteriorHolePixels:1,uvCoverageGapPixels:1,uvSeamRepairPixels:2}),
  prepareMergeProjectionLayers:async layers=>layers,isResidentUvManaged:()=>managed,
  bakeVisibleProjectedLayersToTexture:async input=>{
    calls++;assert.equal(input.commitToProject,false);assert.equal(input.markSourceLayersBaked,false);
    input.onProgress({});
    await new Promise(resolve=>queued.push(resolve));input.onProgress({});
    return {imageData:new Pixels(new Uint8ClampedArray([21,42,63,255])),report:{}};
  },
};
const api=new Function(...Object.keys(scope),code+';return exports;')(...Object.values(scope));
const input={projectId:'project',objectId:'object',resolution:4096,group,layers};
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const a=api.prepareMergeProjection(input),b=api.prepareMergeProjection(input);
await settle();assert.equal(calls,1,'in-flight background/foreground requests deduplicate');
queued.shift()();const [ra,rb]=await Promise.all([a,b]);
ra.imageData.data[0]=99;assert.equal(rb.imageData.data[0],21,'consumers own independent bytes');
assert.equal((await api.prepareMergeProjection(input)).imageData.data[0],21,'cache remains immutable');
assert.equal(calls,1);
const stop=api.startMergeProjectionPreparation({projectId:'project',resolution:4096,canPrepare:()=>true});
const previous=layers;layers=layers.map(layer=>({...layer,imageUrl:layer.imageUrl+'-edited'}));
listener({layers},{layers:previous});tick();clock=2000;tick();await settle();
assert.equal(calls,2,'edited input prepares in background');
const next=layers;layers=layers.map(layer=>({...layer,opacity:0.5}));listener({layers},{layers:next});
queued.shift()();await settle();assert.notEqual(scope.document.body.dataset.uvMergePreparation,'ready','stale job cannot publish');
tick();clock=4000;tick();await settle();assert.equal(calls,3);
queued.shift()();await settle();assert.equal(scope.document.body.dataset.uvMergePreparation,'ready');
assert(finalInputs.length>0);
assert(finalInputs.every(underlays=>underlays.length===0),
  'visible projection toolbar excludes even visible repair UV layers from its final PNG');
const select=api.setMergePreparationSelection('object',[...layers.map(layer=>layer.id),'repair']);
tick();await settle();
assert.deepEqual(finalInputs.at(-1).map(layer=>layer.id),['repair'],'selected repair is precomposed under the projection');
assert.equal(calls,3,'selection of an underlay reuses the same projection result');
select();tick();await settle();assert.equal(finalInputs.at(-1).length,0,'cleared selection restores toolbar intent');
const other=api.setMergePreparationSelection('another-object',['repair','a']);
tick();await settle();assert.equal(finalInputs.at(-1).length,0,'another object cannot change the current merge');
other();
const single=api.setMergePreparationSelection('object',[layers[0].id],true);
tick();clock+=250;tick();await settle();assert.equal(calls,4,'single-layer context menu also prewarms');
queued.shift()();await settle();single();
managed=true;
const priorCalls=calls;
layers=layers.map(layer=>({...layer,opacity:0.3}));listener({layers},{layers:[]});
tick();clock+=2000;tick();await settle();
assert.equal(calls,priorCalls,'Resident UV display must not enqueue a competing speculative merge');
stop();assert.equal(tick,undefined);assert.equal(listener,undefined);
assert.equal(scope.document.body.dataset.uvMergePreparation,undefined);
console.log('Merge preparation: deduplication, immutable full-resolution results, edit invalidation, stale-result rejection and teardown passed.');

const signatureSource=fs.readFileSync(new URL('../src/engine/bake/projectionBakeSignature.ts',import.meta.url),'utf8');
const signatureCode=ts.transpileModule(signatureSource.replace(/^import[^\n]+\n/gm,''),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
const signatureApi=new Function('exports','getProjectedLayerStackSignature','getDebugUvBakeStatus',signatureCode+';return exports;')({},()=>'',()=>({}));
const attributes={position:{count:3,version:0},normal:{count:3,version:0},uv:{count:3,version:0}};
const mesh={uuid:'mesh',visible:true,isMesh:true,matrixWorld:{elements:[1]},
  geometry:{uuid:'geometry',index:{version:0},drawRange:{start:0,count:3},getAttribute:name=>attributes[name]}};
const root={uuid:'root',visible:true,matrixWorld:{elements:[1]},updateMatrixWorld(){},traverse(fn){fn(this);fn(mesh);}};
const signatureInput={...input,group:root,purpose:'merge-uv',optionSignature:'exact'};
let before=signatureApi.createReusableProjectionBakeSignature(signatureInput);
assert.equal(signatureApi.createReusableProjectionBakeSignature(signatureInput),before);
for(const mutate of [()=>{attributes.uv.version++;},()=>{attributes.position={count:3,version:0};},
  ()=>{mesh.geometry.index={version:0};},()=>{root.visible=false;},()=>{mesh.matrixWorld.elements=[2];}]) {
  mutate();const after=signatureApi.createReusableProjectionBakeSignature(signatureInput);
  assert.notEqual(after,before,'geometry and ancestor visibility invalidate cache');before=after;
}
console.log('Merge signature: stable inputs, UV edits, attribute/index replacement, ancestor visibility and transforms passed.');
