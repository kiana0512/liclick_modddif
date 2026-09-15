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
      assert(buffer.byteLength<=1024*1024,'each driver copy stays within the input-blocking budget');
      destinations.push(buffer);
      buffer.fill(++calls);
    },
  }, {}, 1537);
  assert.equal(calls, 10); assert.equal(yields, 9);
  assert(destinations.every(part => part.buffer === result.buffer));
  assert.equal(result[0], 1); assert.equal(result.at(-1), 10);
  assert.equal(result.length, 1537 * 1537 * 4);
}
await assert.rejects(read({ domElement: { isConnected: false }, async readRenderTargetPixelsAsync() {
  throw new Error('GPU readback failed');
} }, {}, 4), /GPU readback failed/);
for (const [width, height] of [[2048, 1537], [1537, 2048], [4096, 512]]) {
  let rows = 0;
  const bytes = await read({ domElement: { isConnected: false },
    async readRenderTargetPixelsAsync(_target, x, y, w, h, buffer) {
      assert.equal(x, 0); assert.equal(y, rows); assert.equal(w, width);
      assert(buffer.byteLength <= 1024 * 1024);
      for (let row = 0; row < h; row++) buffer.fill((y + row) % 251, row * w * 4, (row + 1) * w * 4);
      rows += h;
    },
  }, {}, width, height);
  assert.equal(rows, height); assert.equal(bytes.length, width * height * 4);
  for (let i = 0; i < bytes.length; i++) assert.equal(bytes[i], Math.floor(i / (width * 4)) % 251);
}
for (const visible of [true,false]) {
  for (const failure of [-1,0,1,7]) {
    let active=0,maximum=0,calls=0,completed=0,activeBytes=0;
    const job=read({domElement:{isConnected:visible},async readRenderTargetPixelsAsync(target,x,y,w,h,buffer){
      const index=calls++;active++;maximum=Math.max(maximum,active);activeBytes+=buffer.byteLength;
      assert(activeBytes<=8*1024*1024,'private PBOs stay within eight MiB');
      try {
        // Later reads may complete/fail before the first read.
        await new Promise(resolve=>setTimeout(resolve,index===0?8:1));
        if(index===failure)throw new Error(`stripe ${index}`);
        buffer.fill(index+1);
      } finally {active--;completed++;activeBytes-=buffer.byteLength;}
    }},{},2049);
    if(failure<0){const result=await job;assert.equal(result[0],1);assert.equal(result.at(-1),17);}
    else await assert.rejects(job,new RegExp(`stripe ${failure}`));
    assert.equal(active,0,'a failed read drains every outstanding stripe before target cleanup');
    assert.equal(completed,calls);
    assert.equal(maximum,visible?1:8,'only isolated renderers overlap bounded stripes');
  }
}
console.log('UV readback passed: exact destinations/tail, bounded isolated overlap, visible paint boundaries, out-of-order success/failure and cleanup.');
