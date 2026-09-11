import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setImmediate } from 'node:timers';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/engine/bake/singleItemLookahead.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source.replace('export function', 'function'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const create = new Function(`${js}; return createSingleItemLookahead;`)();
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };

{
  let liveValue=3;
  const q=create(1,()=>Promise.resolve(liveValue),()=>{},false,true);
  const snapshot=q.take();liveValue=9;
  assert.equal(await snapshot,3,'live snapshot occurs synchronously during consumption');
  await q.close();
}

for (const enabled of [false,true]) for (const prepareSecond of [false,true]) {
  const loaded=[], disposed=[];
  const q=create(23, async i => { loaded.push(i); return {i}; }, x=>disposed.push(x.i), enabled, prepareSecond);
  const ahead=enabled ? prepareSecond ? 2 : 1 : 0;
  await tick();
  assert.equal(loaded.length, ahead);
  for(let i=0;i<23;i++) {
    const item=await q.take();
    assert.equal(item.i,i);
    await tick();
    assert.equal(loaded.length,Math.min(23,i+1+ahead), 'preparation remains within the selected slot bound');
  }
  await q.close();
  assert.deepEqual(disposed,[], 'handed-off resources belong to consumer');
  await assert.rejects(q.take());
}
for(const claimed of [false,true]) {
  const d=deferred(), disposed=[];
  const q=create(2,()=>d.promise,x=>disposed.push(x));
  const take=claimed?q.take():undefined;
  const rejection=take?assert.rejects(take,{name:'AbortError'}):undefined;
  const close=q.close();d.resolve(7);
  await close;await rejection;await q.close();
  assert.deepEqual(disposed,[7], 'cancelled resource disposed exactly once');
}
{
  const d=deferred(),q=create(2,()=>d.promise,()=>assert.fail('failed load owns no resource'));
  const first=q.take();
  await assert.rejects(q.take(),/already consumed/);
  const rejection=assert.rejects(first,/decode/);d.reject(Error('decode'));
  await rejection;await q.close();
}
{
  const disposed=[],q=create(3,async i=>{if(i===1)throw Error('next source');return i;},x=>disposed.push(x));
  assert.equal(await q.take(),0);await tick();await q.close();
  assert.deepEqual(disposed,[]);
}
// An active layer's failure must drain and release its already preparing successor.
{
  const d=deferred(),disposed=[],q=create(3,i=>i===0?Promise.resolve(0):d.promise,x=>disposed.push(x));
  assert.equal(await q.take(),0);
  const close=q.close();d.resolve(1);await close;
  assert.deepEqual(disposed,[1]);
}
const gpu=fs.readFileSync(new URL('../src/engine/bake/gpuUvBakeRenderer.ts',import.meta.url),'utf8');
// Reverse completion and cancellation must not publish out of order, leak a
// successfully prepared sibling, or dispose a handed-off source twice.
for (const claimed of [false,true]) for (const failed of [-1,0,1]) {
  const jobs=[deferred(),deferred()],disposed=[];
  const q=create(2,i=>jobs[i].promise,x=>disposed.push(x),true,true);
  const take=claimed?q.take():undefined;
  const rejected=take?assert.rejects(take):undefined;
  const closing=q.close();
  for(const i of [1,0]) {
    if(i===failed)jobs[i].reject(Error('decode failed'));
    else jobs[i].resolve(i);
  }
  await closing;await rejected;await q.close();
  assert.deepEqual(disposed.sort(),[0,1].filter(i=>i!==failed));
}
{
  const jobs=[deferred(),deferred(),deferred()],disposed=[];
  const q=create(3,i=>jobs[i].promise,x=>disposed.push(x),true,true);
  const first=q.take();jobs[1].resolve(1);jobs[0].resolve(0);
  assert.equal(await first,0);assert.equal(await q.take(),1);
  const closing=q.close();jobs[2].resolve(2);await closing;
  assert.deepEqual(disposed,[2]);
}
const tree=ts.createSourceFile('gpu.ts',gpu,ts.ScriptTarget.Latest,true);
const lookahead=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='createLayerTextureLookahead');
const lookaheadJs=ts.transpileModule(lookahead.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const policy=new Function('createSingleItemLookahead','isLiveProjectedCanvasUrl',`${lookaheadJs};return createLayerTextureLookahead;`)(
  (...args)=>({enabled:args[3],second:args[3]&&args[4]}),url=>url.startsWith('live:'),
);
for(const [resolution,resident,extra,live,second] of [
  [4096,true,false,false,true],[8192,true,false,false,false],
  [4096,false,false,false,true],[4096,true,true,false,false],[4096,true,false,true,false],
]) {
  const result=policy({resolution,residentQuality:resident?{}:undefined,layers:[{
    imageUrl:live?'live:image':'image',depthUrl:'depth',normalUrl:extra?'normal':undefined,
  }]});
  assert.equal(result.second,second,'extra decode slot respects format size, source count, pipeline and live boundaries');
}
const loader=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='loadLayerTexturesWithOptions');
const loaderJs=ts.transpileModule(loader.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
for(const fail of [false,true]) {
  const disposed=[],sources=new Map();
  const texture=id=>({id,dispose(){disposed.push(id);}});
  const neutral=texture('neutral');
  const load=new Function('env',`const {createNeutralTexture,loadLayerTextureFromCpuImageData,THREE,disposeLayerTextures,getTextureImageSize}=env;${loaderJs};return loadLayerTexturesWithOptions;`)({
    createNeutralTexture:()=>neutral,THREE:{NearestFilter:1,LinearFilter:2},
    loadLayerTextureFromCpuImageData:({url})=>{const d=deferred();sources.set(url,d);return d.promise;},
    disposeLayerTextures:items=>{for(const item of new Set(items))item.dispose();},getTextureImageSize:()=> '4x4',
  });
  const pending=load({imageUrl:'image',maskUrl:'mask',depthUrl:'depth',normalUrl:'normal'},4096,{inputTextureFlipY:true});
  const result=fail?assert.rejects(pending,/source failed/):pending;
  if(fail)sources.get('image').reject(Error('source failed'));else sources.get('image').resolve(texture('image'));
  await tick();assert.deepEqual(disposed,[], 'wait for sibling ownership before cleanup');
  for(const key of ['mask','depth','normal'])sources.get(key).resolve(texture(key));
  const output=await result;
  if(fail)assert.deepEqual(disposed.sort(),['depth','mask','neutral','normal']);
  else {
    assert.deepEqual(disposed,['neutral'],'unused neutral does not leak or upload');
    assert.deepEqual(output.disposableTextures.map(x=>x.id),['image','mask','depth','normal']);
  }
}
assert.match(gpu,/isLiveProjectedCanvasUrl\(url\)/,'live sources excluded from lookahead');
assert.match(gpu,/retainPreviewTexture\(input.url\)/,'borrowed bitmap protected from eviction');
assert.equal((gpu.match(/await sources.close\(\)/g)||[]).length,2,'both GPU entries drain preparation');
console.log('UV lookahead: 23-layer order, bounded resources, live gate, failure, cancellation and ownership passed.');
