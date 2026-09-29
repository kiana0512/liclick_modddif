import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { pipelineTraceDisabled } from './pipeline-trace-test-build.mjs';
const current = fs.readFileSync(new URL('../src/workers/qualityBlend.worker.ts', import.meta.url), 'utf8');
const frozen = fs.readFileSync(new URL('./fixtures/quality-blend-0ee7b0b.ts', import.meta.url), 'utf8');
const pixelSource=fs.readFileSync(new URL('../src/engine/bake/qualityBlendCpuPixel.ts', import.meta.url),'utf8');
const pixelCode=ts.transpileModule(pixelSource.replaceAll('export ',''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const sharedResolve=new Function(pixelCode+';return resolvePixelCpu;')();
const overlaySource = fs.readFileSync(new URL('../src/engine/bake/projectedOverlayComposition.ts', import.meta.url), 'utf8');
const overlayCode = ts.transpileModule(overlaySource.slice(overlaySource.indexOf('export function getProjectionOverlayAlpha')).replace('export function', 'function'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const sharedOverlayAlpha = new Function(`${overlayCode}; return getProjectionOverlayAlpha;`)();
function load(source, device) {
  const code = ts.transpileModule(pipelineTraceDisabled(source.slice(source.indexOf('const TOP_K'))), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('resolvePixelCpu','getProjectionOverlayAlpha','self','yieldWorkerTask', `${code}; return {createTopK, resolveCpu, resolveGpu, applyOverlays, shader, run};`)(sharedResolve,sharedOverlayAlpha,{ navigator: { gpu: device ? { requestAdapter: async () => ({ requestDevice: async () => device }) } : undefined } },()=>Promise.resolve());
}
const old = load(frozen), next = load(current);
assert.equal(next.shader.replace('var confidence =', 'let confidence =').replace(/ {4}if \(params\.preserveCoverageAlpha == 2u\)[^\n]+\n/, ''), old.shader,
  'Only the new display-alpha branch changes the quality shader; legacy modes stay identical');
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
for (const mode of ['literal', 'feathered']) for (const renderedColor of [false, true]) {
  const count = 4096, color = new Uint8ClampedArray(count * 4), quality = new Float32Array(count);
  const base = new Uint8ClampedArray(count * 4), mask = new Uint8Array(count), coverage = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    color.set(i < 2048 ? [83, 171, 23, 157] : [random() % 256, random() % 256, random() % 256, random() % 256], i * 4);
    base.set(i < 2048 ? [103, 93, 19, 139] : [random() % 256, random() % 256, random() % 256, random() % 256], i * 4);
    quality[i] = i < 2048 ? .11 : random() / 0xffffffff;
    mask[i] = i < 2048 ? 51 : random() % 256;
    coverage[i] = i % 2;
  }
  const overlays = [{ color: color.buffer, quality: quality.buffer, overlayMode: mode, renderedColor }];
  const oldBytes = base.slice(), newBytes = base.slice(), oldMask = mask.slice(), newMask = mask.slice();
  const oldCoverage = coverage.slice(), newCoverage = coverage.slice();
  assert.equal(await old.applyOverlays(oldBytes, oldCoverage, oldMask, overlays),
    await next.applyOverlays(newBytes, newCoverage, newMask, overlays));
  assert.deepEqual(newBytes, oldBytes);
  assert.deepEqual(newMask, oldMask);
  assert.deepEqual(newCoverage, oldCoverage);
}
// Ordinary overlays cannot introduce rendered-color attribution. Their output
// and coverage remain byte-identical while the 4K all-zero mask is elided.
{
  const count = 64, color = new Uint8ClampedArray(count * 4), quality = new Float32Array(count);
  const base = new Uint8ClampedArray(count * 4), coverage = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    color.set([i, 255 - i, i * 3, 127 + (i & 1)], i * 4);
    base.set([91, 37, 203, i & 1 ? 255 : 0], i * 4);
    quality[i] = 1;
  }
  const expectedBase = base.slice(), expectedCoverage = coverage.slice();
  const request = { resolution: 8, preserveCoverageConfidenceAlpha: false,
    forceCpuOutput: true, verify: false, interactive: false, layers: [],
    resolvedBase: { output: base.buffer, coverage: coverage.buffer, writtenTexels: 0 },
    overlays: [{ color: color.buffer, quality: quality.buffer, overlayMode: 'literal', renderedColor: false }] };
  const result = await next.run(request);
  assert.equal(result.renderedColorMask.length, 0, 'ordinary stacks do not allocate an all-zero mask');
  const expectedMask = new Uint8Array(count);
  await old.applyOverlays(expectedBase, expectedCoverage, expectedMask, request.overlays);
  assert.deepEqual(result.output, expectedBase);
  assert.deepEqual(result.coverage, expectedCoverage);
}
// Exhaust all source byte/alpha pairs on transparent and opaque destinations.
// Mixed overlay modes, rendered masks and repeated pixels must retain the
// frozen implementation's bytes and coverage, including feather thresholds.
for (const mode of ['literal', 'feathered']) for (const renderedColor of [false, true]) {
  const count = 256 * 256 * 2;
  const color = new Uint8ClampedArray(count * 4), base = color.slice();
  const quality = new Float32Array(count), mask = new Uint8Array(count);
  const coverage = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const value = i & 255, alpha = (i >>> 8) & 255;
    color.set([value, 255 - value, (value * 17) & 255, alpha], i * 4);
    base.set([31, 127, 251, i < 65536 ? 0 : 255], i * 4);
    quality[i] = [0, .0001, .02, .11, .5, 1][i % 6];
    mask[i] = value;
    coverage[i] = i % 2;
  }
  const overlays = [{ color: color.buffer, quality: quality.buffer, overlayMode: mode, renderedColor }];
  const a = base.slice(), b = base.slice(), am = mask.slice(), bm = mask.slice();
  const ac = coverage.slice(), bc = coverage.slice();
  assert.equal(await next.applyOverlays(b, bc, bm, overlays), await old.applyOverlays(a, ac, am, overlays));
  assert.deepEqual(b, a, `${mode}/${renderedColor}: identity RGB and fractional alpha`);
  assert.deepEqual(bm, am, 'rendered-color coverage remains exact');
  assert.deepEqual(bc, ac, 'coverage tags remain exact');
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
{
  const request={resolution:16,preserveCoverageConfidenceAlpha:true,forceCpuOutput:true,verify:false,interactive:false,overlays:[],
    layers:[{color:new Uint8ClampedArray(16*16*4).fill(155).buffer,quality:new Float32Array(16*16).fill(.7).buffer}]};
  const former=mockDevice(),candidate=mockDevice();
  const a=await load(frozen,former.device).run(request),b=await load(current,candidate.device).run(request);
  assert.deepEqual(b.output,a.output);assert.deepEqual(b.coverage,a.coverage);
  assert(former.buffers.length>0);assert.equal(candidate.buffers.length,0,'CPU reference must not dispatch an unused second GPU resolve');
}
