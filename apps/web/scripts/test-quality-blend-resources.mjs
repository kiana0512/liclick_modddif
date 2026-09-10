import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { createHash } from 'node:crypto';
const current = fs.readFileSync(new URL('../src/workers/qualityBlend.worker.ts', import.meta.url), 'utf8');
const frozen = fs.readFileSync(new URL('./fixtures/quality-blend-0ee7b0b.ts', import.meta.url), 'utf8');
const pixelSource=fs.readFileSync(new URL('../src/engine/bake/qualityBlendCpuPixel.ts', import.meta.url),'utf8');
const pixelCode=ts.transpileModule(pixelSource.replace('export function','function'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const sharedResolve=new Function(pixelCode+';return resolvePixelCpu;')();
function load(source, device) {
  const code = ts.transpileModule(source.slice(source.indexOf('const TOP_K')), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('resolvePixelCpu','self', `${code}; return {createTopK, resolveCpu, resolveGpu, shader};`)(sharedResolve,{ navigator: { gpu: device ? { requestAdapter: async () => ({ requestDevice: async () => device }) } : undefined } });
}
const old = load(frozen), next = load(current);
assert.equal(next.shader, old.shader, 'production shader is unchanged');
let seed = 715;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
for (let test = 0; test < 120; test++) {
  const top = old.createTopK(test === 119 ? 262145 : 1 + random() % 1000);
  for (let i = 0; i < top.coverage.length; i++) {
    top.coverage[i] = random() % 3 === 0 ? 0 : 1;
    for (let slot = 0; slot < 3; slot++) {
      top.colors[slot][i] = random() & 0xffffff;
      top.coverages[slot][i] = [0, .02, .020001, .5, 1][random() % 5];
      top.qualities[slot][i] = [0, .01, .3, 1][random() % 4];
    }
  }
  for (const alpha of [false, true]) assert.deepEqual(await next.resolveCpu(top, alpha), await old.resolveCpu(top, alpha));
}
function mockDevice(failAt = 0) {
  const buffers = [], trace = [];
  let group, copy;
  const device = {
    lost: new Promise(() => {}),
    createShaderModule: () => ({}), createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer({size}) {
      if (failAt && buffers.length + 1 === failAt) throw new Error('allocation failure');
      const buffer = { data: new ArrayBuffer(size), destroyed: false, mapped: false,
        destroy() { this.destroyed = true; },
        getMappedRange() { assert(this.mapped); return this.data; },
        async mapAsync() { this.mapped = true; }, unmap() { this.mapped = false; } };
      buffers.push(buffer); return buffer;
    },
    createBindGroup({entries}) { return entries; },
    createCommandEncoder() { return {
      beginComputePass: () => ({ setPipeline() {}, setBindGroup(_, value) { group = value; }, dispatchWorkgroups() {}, end() {} }),
      copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) { copy = {source, sourceOffset, destination, destinationOffset, size}; }, finish: () => ({}) };
    },
    queue: {
      writeBuffer(target, targetOffset, source, sourceOffset = 0, size = source.byteLength) { new Uint8Array(target.data).set(new Uint8Array(source, sourceOffset, size), targetOffset); },
      submit() {
        const input = group[0].resource, output = group[1].resource;
        const bytes = new Uint8Array(input.buffer.data, 0, input.size ?? input.buffer.data.byteLength);
        trace.push(createHash('sha256').update(bytes).digest('hex'));
        const result = new Uint8Array(output.buffer.data);
        for (let i = 0; i < copy.size; i++) result[i] = bytes[(i * 13) % bytes.length];
        new Uint8Array(copy.destination.data).set(result.subarray(0, copy.size));
      }, async onSubmittedWorkDone() {},
    },
  };
  return {device, buffers, trace};
}
for (const count of [1, 257, 262144, 262145, 524301]) {
  const top = next.createTopK(count);
  for (let slot = 0; slot < 3; slot++) for (let i = 0; i < count; i++) {
    top.colors[slot][i] = random() & 0xffffff; top.coverages[slot][i] = (random() % 256) / 255; top.qualities[slot][i] = (random() % 1000) / 1000;
  }
  const a = mockDevice(), b = mockDevice();
  assert.deepEqual(await load(current, b.device).resolveGpu(top, true), await load(frozen, a.device).resolveGpu(top, true));
  assert.deepEqual(b.trace, a.trace, 'each full/partial tile uploads identical packed bytes');
  assert.equal(b.buffers.length, 4);
  assert(b.buffers.every(x => x.destroyed && !x.mapped));
}
const failed = mockDevice(3);
await assert.rejects(load(current, failed.device).resolveGpu(next.createTopK(10), false), /allocation failure/);
assert(failed.buffers.every(x => x.destroyed), 'partial allocation is released');
console.log('Quality blend: 240 CPU parity cases, full/partial GPU tile byte parity and resource lifetime passed.');
