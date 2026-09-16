import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/engine/bake/gpuUvBakeRenderer.ts', import.meta.url), 'utf8');
const start = source.indexOf('      const started = performance.now();', source.indexOf('    let residentQuality: QualityBlendWorkerResult'));
const end = source.indexOf('      const resolveMs=', start);
const code = ts.transpileModule(`async function run() { let coveredPixels=0; ${source.slice(start, end)} return {coveredPixels,imageData,coverage,writtenTexels}; }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
for (const fail of ['', 'color', 'count', 'convert']) {
  const events = [];
  let finishCount;
  const scope = {
    resident: {
      async readCorrected() { events.push('color'); if (fail === 'color') throw Error('color failed'); return { output: new Uint8Array(16), correctedPixels: 0 }; },
      async countLayerCoverage() { events.push('count'); await new Promise(resolve => { finishCount=resolve; }); events.push('count-done'); if (fail === 'count') throw Error('count failed'); return 9; },
    },
    input: { residentQuality: { preserveAlpha: false } }, retainRasters: false, resolution: 2,
    convertLayerGpuReadbackInWorker: async () => { events.push('convert'); if (fail === 'convert') throw Error('convert failed'); return { imageData: {}, coverage: new Uint8Array(4), coveredPixels: 4 }; },
    document: { body: { dataset: {} } },
  };
  const run = new Function(...Object.keys(scope), code + ';return run;')(...Object.values(scope));
  let settled = false;
  const job = run().then(value => ({ value }), error => ({ error })).finally(() => { settled=true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(events.includes('count'), 'coverage reduction starts independently of color correction');
  assert.equal(settled, false, 'pending GPU reduction is drained before success or failure');
  if (!fail) assert(events.indexOf('count') < events.indexOf('convert'), 'count overlaps readback/conversion instead of starting afterwards');
  finishCount();
  const result = await job;
  if (fail) assert.match(result.error.message, new RegExp(fail));
  else assert.equal(result.value.coveredPixels, 9);
}
console.log('Resident resolve scheduling: overlapped coverage reduction, exact counts and draining on either failure passed.');

const correction = await readFile(new URL('../src/engine/bake/residentQualityComposite.ts', import.meta.url), 'utf8');
const method = correction.slice(correction.indexOf('  async readCorrected('), correction.indexOf('  reset()'))
  .replace('async readCorrected(', 'async function readCorrected(');
let clock = 0, yields = 0;
const bytes = new Uint8Array(2048 * 2048 * 4);
const scan = new Function('readRenderTargetPixelsInStripes', 'yieldToBrowserTask', 'performance',
  ts.transpileModule(method, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + ';return readCorrected;')(
  async () => bytes, async () => { yields++; }, { now: () => clock++ });
const scanned = await scan.call({ resolve() {}, resolution: 2048 }, false);
assert.deepEqual(scanned.output, new Uint8ClampedArray(bytes.buffer));
assert.equal(scanned.correctedPixels, 0);
assert(yields > 0 && yields < 15, 'scan yields by elapsed budget, not after every 1 MiB');
