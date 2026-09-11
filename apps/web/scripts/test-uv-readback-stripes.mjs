import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/engine/bake/gpuReadbackStripes.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source.replace(/import[^;]+;/g, '').replace('export async', 'async'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
let yields = 0;
const read = new Function('waitForBrowserPaint', 'yieldToBrowserTask', `${compiled}; return readRenderTargetPixelsInStripes;`)(
  async () => { yields++; }, async () => { yields++; },
);
for (const visible of [true, false]) {
  const destinations = [];
  let calls = 0;
  yields = 0;
  const result = await read({ domElement: { isConnected: visible },
    async readRenderTargetPixelsAsync(target, x, y, width, height, buffer) {
      assert.equal(buffer.byteOffset, y * width * 4);
      assert.equal(buffer.byteLength, width * height * 4);
      destinations.push(buffer);
      buffer.fill(++calls);
    },
  }, {}, 1537);
  assert.equal(calls, 2); assert.equal(yields, 1);
  assert(destinations.every(part => part.buffer === result.buffer));
  assert.equal(result[0], 1); assert.equal(result.at(-1), 2);
  assert.equal(result.length, 1537 * 1537 * 4);
}
await assert.rejects(read({ domElement: { isConnected: false }, async readRenderTargetPixelsAsync() {
  throw new Error('GPU readback failed');
} }, {}, 4), /GPU readback failed/);
for (const visible of [true,false]) {
  for (const failure of [-1,0,1]) {
    let active=0,maximum=0,calls=0,completed=0;
    const job=read({domElement:{isConnected:visible},async readRenderTargetPixelsAsync(target,x,y,w,h,buffer){
      const index=calls++;active++;maximum=Math.max(maximum,active);
      try {
        // Later reads may complete/fail before the first read.
        await new Promise(resolve=>setTimeout(resolve,index===0?8:1));
        if(index===failure)throw new Error(`stripe ${index}`);
        buffer.fill(index+1);
      } finally {active--;completed++;}
    }},{},2049);
    if(failure<0){const result=await job;assert.equal(result[0],1);assert.equal(result.at(-1),3);}
    else await assert.rejects(job,new RegExp(`stripe ${failure}`));
    assert.equal(active,0,'a failed read drains every outstanding stripe before target cleanup');
    assert.equal(completed,calls);
    assert.equal(maximum,visible?1:2,'only isolated renderers overlap two bounded stripes');
  }
}
console.log('UV readback passed: exact destinations/tail, bounded isolated overlap, visible paint boundaries, out-of-order success/failure and cleanup.');
