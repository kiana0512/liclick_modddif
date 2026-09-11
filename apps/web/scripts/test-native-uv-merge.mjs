import assert from 'node:assert/strict';
import {createServer} from 'vite';
import path from 'node:path';
const server=await createServer({root:path.resolve(import.meta.dirname,'..'),logLevel:'silent',
  server:{middlewareMode:true,watch:{ignored:()=>true}}});
try {
  const api=await server.ssrLoadModule('/src/engine/layers/mergeUvComposition.ts');
  const {resolveBakeUvMergePlan}=await server.ssrLoadModule('/src/features/workflow/selectBakeBaseColor.ts');
  const make=(id,extra={})=>({id,type:'uv',imageUrl:id,visible:true,objectId:'a',opacity:1,order:0,...extra});
  const bottom=make('local-repaint-uv-native-v1-bottom',{order:7,role:'local-repaint-overlay'});
  const top=make('local-repaint-uv-native-v1-top',{order:2,role:'local-repaint-overlay',opacity:0.5});
  const base=make('base',{role:'merged-uv',order:0,uvMergeVersion:10});
  const repair=make('repair',{role:'content-aware-underlay',order:1});
  assert(api.isFlattenableUvMergeSource(top));
  assert(!api.isFlattenableUvMergeSource({...top,imageUrl:''}));
  assert(!api.isFlattenableUvMergeSource(make('blank')));
  assert.deepEqual([top,repair,bottom,base].sort(api.compareUvMergeSources).map(x=>x.id),
    [base.id,repair.id,bottom.id,top.id]);
  const rgba=(...values)=>new Uint8ClampedArray(values);
  let result=rgba(255,0,0,255, 0,0,0,0);
  api.compositeRgbaUnderInPlace(result,rgba(0,0,255,255, 0,0,255,255));
  result=api.compositeRgbaUnderInPlace(rgba(0,255,0,255, 0,0,0,0),result,1,0.5);
  assert.deepEqual([...result],[128,128,0,255, 0,0,255,255],
    'Native repaint covers projection once; transparent pixels retain underlay');
  const selected=[base,bottom,top,make('local-repaint-uv-native-v1-hidden',{visible:false}),
    make('local-repaint-uv-native-v1-other',{objectId:'b'})];
  const plan=resolveBakeUvMergePlan(selected,'a');
  assert.equal(plan.action,'merge','Do not reuse base when native UV delta exists');
  assert.deepEqual(plan.sourceLayerIds,[bottom.id,top.id]);
  assert.equal(plan.baseUvLayerId,base.id);
  assert.equal(resolveBakeUvMergePlan([base,{...top,visible:false}],'a').action,'reuse');
  console.log('Native UV merge selection, ordering, opacity, transparent coverage and Bake/export plan passed.');
} finally {await server.close();}
