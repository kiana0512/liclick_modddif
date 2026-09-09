import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/engine/bake/gpuReadbackStripes.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source.replace(/import[^;]+;/g, '').replace('export async', 'async'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
let yields = 0;
const read = new Function('waitForBrowserPaint', 'window', `${compiled}; return readRenderTargetPixelsInStripes;`)(
  async () => { yields++; }, { setTimeout: (callback) => { yields++; callback(); } },
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
console.log('UV readback passed: shared final buffer, partial tail, paint yields and error propagation.');
