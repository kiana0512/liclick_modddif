import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/engine/bake/mergeFinalPreparation.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source.replace(/^import[^\n]+\n/gm,''),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
let calls=0,encodeCalls=0,pause,previewPause,liveRevision=1,yields=0,idleChecks=0,clock=0;
const scope={exports:{},AbortController:globalThis.AbortController,DOMException,
  yieldToBrowserTask:async()=>{yields++;},
  waitForViewportInteractionIdle:async()=>{idleChecks++;},
  getLiveProjectedTextureSourceState:url=>url==='2'?{revision:liveRevision}:undefined,
  clearPreparedMergePreview:()=>{},prepareMergePreview:async()=>{if(previewPause)await previewPause;},
  window:{location:{search:''}},document:{body:{dataset:{}}},performance:{now:()=>clock+=5},
  compositeRgbaUrlUnderWithWebGpu:async(rgba,url,width,height,opacity,signal)=>{
    calls++;assert.equal(width,1);assert.equal(height,1);
    if(pause) await pause;
    if(signal.aborted) throw new DOMException('cancelled','AbortError');
    const data=rgba.slice();data[0]=data[0]*2+Number(url)*opacity;return {data};
  },
  encodeRgbaPngBlob:async(width,height,rgba)=>{encodeCalls++;return new Blob([rgba]);},
};
const api=new Function(...Object.keys(scope),code+';return exports;')(...Object.values(scope));
const image={width:1,height:1,data:new Uint8ClampedArray([3,0,0,255])};
const layers=[{imageUrl:'2',opacity:1},{imageUrl:'5',opacity:1}];
await api.prepareMergeFinal('a',image,layers);
const blob=api.getPreparedMergePng('a',layers);
assert.equal(new Uint8Array(await blob.arrayBuffer())[0],21,'underlays preserve exact input order');
assert.equal(image.data[0],3,'projection cache remains immutable');
await api.prepareMergeFinal('a',image,layers);assert.equal(calls,2);assert.equal(encodeCalls,1);
assert.equal(api.getPreparedMergePng('b',layers),undefined);
assert.equal(api.getPreparedMergePng('a',[...layers].reverse()),undefined);
assert.equal(api.getPreparedMergePng('a',[{...layers[0],opacity:0.5},layers[1]]),undefined);
let resume;pause=new Promise(resolve=>{resume=resolve;});
const pending=api.prepareMergeFinal('b',image,layers);api.cancelMergeFinalPreparation();resume();
await assert.rejects(pending,{name:'AbortError'});assert.equal(api.getPreparedMergePng('b',layers),undefined);
api.cancelMergeFinalPreparation(true);assert.equal(api.getPreparedMergePng('a',layers),undefined);
pause=undefined;
let finishPreview;
previewPause=new Promise(resolve=>{finishPreview=resolve;});
const beforeEncoding=encodeCalls;
const preparing=api.prepareMergeFinal('join',image,layers);
const duplicate=api.prepareMergeFinal('join',image,layers);
const joining=api.awaitPreparedMergePng('join',layers);
let joined=false;void joining.then(()=>{joined=true;});
await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(encodeCalls,beforeEncoding+1,'foreground and background must encode once');
assert.equal(joined,false,'join waits for GPU preparation');
assert.equal(api.getPreparedMergePng('join',layers),undefined,'not ready before GPU handoff');
assert.equal(await api.awaitPreparedMergePng('join',[...layers].reverse()),undefined,'different underlay order cannot join');
finishPreview();await Promise.all([preparing,duplicate]);
assert.equal(await joining,api.getPreparedMergePng('join',layers));
previewPause=undefined;
await api.prepareMergeFinal('exact',image,[]);
const exact=api.getPreparedMergePng('exact',[]);
assert.equal(await api.reuseUnchangedMergePng('exact',image.data,image.data.slice()),exact);
for(let channel=0;channel<4;channel++) {
  const changed=image.data.slice();changed[channel]^=1;
  assert.equal(await api.reuseUnchangedMergePng('exact',image.data,changed),undefined);
}
assert.equal(await api.reuseUnchangedMergePng('different',image.data,image.data),undefined);
assert.equal(await api.reuseUnchangedMergePng('exact',image.data,new Uint8ClampedArray(0)),undefined);
const unaligned=new Uint8ClampedArray(new ArrayBuffer(5),1,4);unaligned.set(image.data);
assert.equal(await api.reuseUnchangedMergePng('exact',image.data,unaligned),exact);
const gutter=new Uint8ClampedArray([7,8,9,0]),empty=new Uint8ClampedArray([0,0,0,0]);
assert.equal(await api.reuseUnchangedMergePng('exact',gutter,empty),undefined,'hidden gutter RGB cannot be dropped');
await api.prepareMergeFinal('live',image,layers);
assert(api.getPreparedMergePng('live',layers));liveRevision++;
assert.equal(api.getPreparedMergePng('live',layers),undefined,'in-place live edit invalidates final cache');
previewPause=new Promise(resolve=>{finishPreview=resolve;});
const stale=api.prepareMergeFinal('live',image,layers);
const rejected=assert.rejects(stale,{name:'AbortError'});
await new Promise(resolve=>setTimeout(resolve,0));liveRevision++;finishPreview();await rejected;
assert.equal(api.getPreparedMergePng('live',layers),undefined,'late completion cannot publish edited live source');
previewPause=undefined;
const large=new Uint8ClampedArray(8*1048576);
for(let i=0;i<large.length;i++)large[i]=i%251;
const beforeYields=yields,beforeIdle=idleChecks;
await api.prepareMergeFinal('sliced-copy',{width:2048,height:1024,data:large},[]);
assert.equal(yields-beforeYields,7,'bounded copies yield at exhausted 4ms budget');
assert.equal(idleChecks-beforeIdle,7,'viewport gets priority between copy slices');
assert.deepEqual(new Uint8ClampedArray(await api.getPreparedMergePng('sliced-copy',[]).arrayBuffer()),large);
assert.equal(large.length,8*1048576,'shared source buffer remains owned by preparation cache');
console.log('Final Merge preparation: ordered underlays, immutable inputs, deduplication, exact cache keys, bounded copy scheduling and stale-result cancellation passed.');
