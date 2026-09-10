import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/engine/bake/mergeFinalPreparation.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source.replace(/^import[^\n]+\n/gm,''),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
let calls=0,encodeCalls=0,pause;
const scope={exports:{},AbortController:globalThis.AbortController,DOMException,
  window:{location:{search:''}},document:{body:{dataset:{}}},performance,
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
console.log('Final Merge preparation: ordered underlays, immutable inputs, deduplication, exact cache keys and stale-result cancellation passed.');
