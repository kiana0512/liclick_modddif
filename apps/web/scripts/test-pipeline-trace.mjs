import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { instrumentFunctions, functionTimingPlugin, timedFunctions } from './function-timing.mjs';
import { pipelineTraceDisabled } from './pipeline-trace-test-build.mjs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const source = name => fs.readFileSync(path.join(root, 'src/engine/performance/tracing', name + '.ts'), 'utf8');
function compile(text, dependencies = {}) {
  const output = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function('require', 'exports', '__deps', output)(name => dependencies[name] ?? (name === '@/engine/performance/tracing/types' ? traceTypes : require(name)), exports, dependencies);
  return exports;
}
const traceTypes = compile(source('types'));
const { createTraceSession } = compile(source('traceRecorder'));
let time = 10;
const trace = createTraceSession(() => time);
const parent = trace.begin('model.load');
const a = trace.begin('model.parse', parent.context, 'sync');
time = 20; a.end(); a.end('error');
time = 50; parent.end();
assert.equal(trace.snapshot().spans[1].endMs, 20);
assert.equal(trace.snapshot().spans[1].parentSpanId, parent.context.spanId);
assert.equal(trace.snapshot().spans[0].endMs - trace.snapshot().spans[0].startMs, 40);
time += 30_000;
assert.equal(trace.snapshot().spans[0].endMs, 50, 'observer pauses cannot extend completed calls');
const open = trace.begin('save.command');
const stopped = trace.stop(); open.end();
assert.equal(stopped.spans.at(-1).status, 'interrupted');
assert.equal(stopped.spans.at(-1).endMs, null);
assert.equal(trace.begin('save.command'), undefined);
const copy = trace.snapshot(); copy.spans[0].name = 'save.command';
assert.equal(trace.snapshot().spans[0].name, 'model.load');

const bounded = createTraceSession(() => 1);
for (let i = 0; i < 10_001; i++) bounded.begin('model.read');
assert.equal(bounded.snapshot().spans.length, 10_000);
assert.equal(bounded.snapshot().dropped, 1);
assert.equal(bounded.snapshot().completeness, 'truncated');
const privacy = createTraceSession(() => 1);
privacy.begin('model.read', undefined, 'sync', 'secret-business-id', { prompt: 'private', bytes: 20, attempt: 2 });
assert.doesNotMatch(JSON.stringify(privacy.snapshot()), /secret-business-id|private|prompt|bytes/);
const w = privacy.begin('task.run');
privacy.workerResult({ ...w.context, producerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', receivedMs: 100, sentMs: 140, name: 'uv.compose', kind: 'async' });
assert.equal(privacy.snapshot().spans.at(-1).endMs - privacy.snapshot().spans.at(-1).startMs, 40);
assert.equal(privacy.snapshot().spans.at(-1).parentSpanId, w.context.spanId);

const coordinator = enabled => compile(source('pipelineTrace')
  .replaceAll('import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED', JSON.stringify(String(enabled)))
  .replace("import('./traceRecorder')", 'Promise.resolve(__deps.recorder)')
  .replaceAll("import('./generationTrace')", 'Promise.resolve(__deps.observer)'), {
    recorder: { createTraceSession }, observer: { observeGenerationPipeline: () => () => {} },
  });
const off = coordinator(false);
assert.equal(await off.startPipelineTrace(), undefined);
const api = coordinator(true);
assert.equal(api.getPipelineTrace(), undefined);
const first = api.startPipelineTrace(); assert.equal(first, api.startPipelineTrace());
const session = await first;
const pending = session.begin('generation.attempt');
const one = api.stopPipelineTrace();
assert.equal(api.stopPipelineTrace(), one);
const next = await api.startPipelineTrace(); pending.end();
assert.equal(next.snapshot().spans.length, 0);
const failure = new Error('business');
assert.throws(() => api.traceSync(next, 'model.parse', () => { throw failure; }), error => error === failure);
await assert.rejects(api.traceAsync(next, 'model.load', async () => { throw failure; }), error => error === failure);
api.stopPipelineTrace();
const interruptedStart = api.startPipelineTrace(); api.stopPipelineTrace();
assert.equal(await interruptedStart, undefined);

for (const [file, names] of Object.entries(timedFunctions)) instrumentFunctions(fs.readFileSync(path.join(root, 'src', file), 'utf8'), file, names);
assert.equal(await functionTimingPlugin(false).transform('untouched', '/apps/web/src/services/liclickApiClient.ts'), undefined);
let reads = 0, active;
const fixture = instrumentFunctions('export function sync(value) { return value; }\nexport async function asyncCall(task) { return await task; }\nexport function reject(error) { throw error; }', 'fixture.ts', ['sync','asyncCall','reject']);
const instrumented = compile(fixture, { '@/engine/performance/tracing/pipelineTrace': { getPipelineTrace: () => active, finishTraceReturn: api.finishTraceReturn } });
const value = {};
for (let i = 0; i < 1000; i++) assert.equal(instrumented.sync(value), value);
assert.equal(reads, 0);
active = createTraceSession(() => ++reads);
assert.equal(instrumented.sync(value), value);
assert.equal(await instrumented.asyncCall(Promise.resolve(value)), value);
assert.throws(() => instrumented.reject(failure), error => error === failure);
assert.equal(active.snapshot().spans[0].attributes.functionName, 'fixture.ts#sync');
assert.equal(active.snapshot().spans.at(-1).status, 'error');
const direct = compile(instrumentFunctions('export async function direct(task) { return task; }', 'direct.ts', ['direct']), { '@/engine/performance/tracing/pipelineTrace': { getPipelineTrace: () => active, finishTraceReturn: api.finishTraceReturn } });
let finish;
const business = new Promise(resolve => { finish = resolve; });
const result = direct.direct(business);
assert.equal(active.snapshot().spans.at(-1).status, null, 'returning a Promise must stay open until it settles');
finish(value); assert.equal(await result, value);
assert.equal(active.snapshot().spans.at(-1).status, 'ok');

function store(initial) {
  let state = initial;
  const listeners = new Set();
  return { getState: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, set(next) { const prior = state; state = next; listeners.forEach(fn => fn(state, prior)); } };
}
const generations = store({ generations: [], isGenerating: false });
const references = store({ selectedReferenceIds: [] });
const layers = store({ layers: [] });
const { observeGenerationPipeline } = compile(source('generationTrace'), {
  '@/stores/generationStore': { useGenerationStore: generations },
  '@/stores/referenceStore': { useReferenceStore: references },
  '@/stores/layerStore': { useLayerStore: layers },
});
const observed = createTraceSession();
observed.onStop(observeGenerationPipeline(observed, 'project'));
const generation = { id: 'generation', captureId: 'capture', status: 'running', metadata: { projectId: 'project', startedAt: new Date().toISOString() } };
generations.set({ generations: [generation], isGenerating: true });
generations.set({ generations: [{ ...generation, status: 'succeeded', resultUrl: '/existing-result.png' }], isGenerating: false });
assert.equal(observed.snapshot().spans.find(s => s.name === 'generation.attempt').status, null, 'result alone is not a saved success');
observed.acknowledge('generation');
assert.equal(observed.snapshot().spans.find(s => s.name === 'generation.attempt').status, 'ok');
observed.stop();
const projectionSource = fs.readFileSync(path.join(root, 'src/engine/generation/singleViewAutoProjection.ts'), 'utf8');
const replayed = [];
for (const mode of ['compiled-off', 'off', 'on']) {
  const session = mode === 'on' ? createTraceSession() : undefined;
  const text = mode === 'compiled-off' ? pipelineTraceDisabled(projectionSource) : instrumentFunctions(projectionSource, 'engine/generation/singleViewAutoProjection.ts', ['persistProjectionCommit']).replaceAll('import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED', '"true"');
  const replay = compile(text, { '@/engine/performance/tracing/pipelineTrace': { getPipelineTrace: () => session, finishTraceReturn: api.finishTraceReturn } });
  const savedResult = { ...generation, status: 'succeeded', resultUrl: '/prior-success.png', metadata: { ...generation.metadata, projectionCommittedAt: '2026-09-23T00:00:00.000Z' } };
  const events = []; let saved;
  let acknowledge;
  const save = new Promise(resolve => { acknowledge = resolve; });
  const operation = replay.persistProjectionCommit(savedResult, 'layer', value => { saved = value; events.push('sync'); }, () => { events.push('save'); return save; }, { onSaved: () => events.push('ack') });
  assert.deepEqual(events, ['sync', 'save']);
  acknowledge(); await operation;
  assert.deepEqual(events, ['sync', 'save', 'ack']);
  replayed.push(saved);
  if (session) assert(session.isAcknowledged('projection:generation:layer'));
  await assert.rejects(replay.persistProjectionCommit(savedResult, 'layer', () => {}, () => Promise.reject(failure)), error => error === failure);
  session?.stop();
}
assert.deepEqual(replayed[0], replayed[1]); assert.deepEqual(replayed[1], replayed[2]);
const viewSource = fs.readFileSync(path.join(root, 'src/features/performanceLab/PipelineTraceView.tsx'), 'utf8');
const viewAst = ts.createSourceFile('view.tsx', viewSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const displaySource = viewAst.statements.filter(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'traceDisplayInfo'
  || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ['modules', 'stageLabels'].includes(d.name.getText(viewAst)))
).map(node => node.getText(viewAst)).join('\n');
const { traceDisplayInfo } = compile(displaySource + '\nexports.traceDisplayInfo = traceDisplayInfo;');
const displayed = traceDisplayInfo({ name: 'model.load', kind: 'async', producerId: 'browser', attributes: { functionName: 'engine/loaders/loadModelFromFile.ts#loadModelFromFile' } });
assert.equal(displayed.module, 'M02 输入与资产');
assert.equal(displayed.namespace, 'engine.loaders.loadModelFromFile');
assert.equal(displayed.functionName, 'loadModelFromFile');
assert.equal(displayed.source, 'engine/loaders/loadModelFromFile.ts');
assert.equal(displayed.type, '函数');
const phase = traceDisplayInfo({ name: 'model.read', kind: 'async', producerId: 'browser' });
assert.equal(phase.type, '阶段'); assert.equal(phase.functionName, '—'); assert.equal(phase.namespace, '—');
assert.equal(traceDisplayInfo({ name: 'uv.compose', kind: 'async', producerId: 'worker' }).module, 'M07 UV 与呈现');
console.log('Function timing: bounds, privacy, nesting, worker clocks, stop/restart, errors, compile-off and explicit function coverage passed.');
