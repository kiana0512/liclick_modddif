import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const pipelineSource = read('../src/services/referenceDelightPipeline.ts');
const routeSource = read('../src/routes/liclick.ts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'li3d-reference-pipeline-'));
const hooks = ['createGenerationJob', 'applySubmission', 'pollAndUpdateJob', 'startGenerationJob',
  'cancelGenerationJob', 'getJobResponse', 'getJobListResponse', 'getPersistableJob',
  'loadGenerationJobs', 'generationJobs', 'saveGenerationJobs'];
function compile(source, dependencies, globals = {}) {
  const output = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  new Function('exports', 'require', 'setTimeout', 'console', ...Object.keys(globals), output)(exports,
    id => id.startsWith('node:') ? require(id) : dependencies[id] ?? {},
    callback => setTimeout(callback, 0), { error() {}, warn() {} }, ...Object.values(globals));
  return exports;
}
const first = 'https://example.test/six-view.png';
const final = 'https://example.test/albedo.png';
const model = 'gpt-image-2.5-sunburst';
const input = () => ({ prompt: read('../../web/src/services/multiviewReferencePrompt.txt').trim(),
  referencePipeline: 'six-view-delight-v1', workflow: 'liclick', projectId: 'project',
  model, quality: 'low', aspectRatio: '3:2', imageSize: '2K', count: 1,
  references: [{ id: 'original', url: 'https://example.test/original.png' }] });
const job = () => ({ id: 'reference', userId: 'owner', projectId: 'project', workflow: 'liclick',
  atlasHomeDir: path.join(root, 'atlas-homes', 'owner'), input: input(), status: 'running', taskId: 'stage-one',
  startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const submission = (taskId, resultUrl) => ({ id: taskId, taskId, resultUrl,
  resultUrls: resultUrl ? [resultUrl] : undefined, model, extraParams: {}, uploadedReferences: [], raw: {} });
function harness(directory, submit, poll = async () => { throw new Error('Unexpected poll'); }) {
  const service = { submitLiclickImageJob: submit, pollLiclickImageTask: poll };
  const pipeline = compile(pipelineSource, { './liclickGenerationService.js': service });
  const routes = compile(`${routeSource}\nexport { ${hooks.join(', ')} };`, {
    '../services/referenceDelightPipeline.js': pipeline,
    '../services/liclickGenerationService.js': service,
    '../config.js': { serverConfig: { workspaceDir: directory } },
    '../services/liclickErrorMessage.js': { getLiclickUserErrorMessage: e => e instanceof Error ? e.message : String(e) },
  });
  return { ...pipeline, ...routes };
}
function noIntermediate(api, value) {
  for (const response of [api.getJobResponse(value), api.getJobListResponse(value)]) {
    assert.equal(response.status, 'running');
    assert.equal(response.resultUrl, undefined);
    assert.equal(response.resultUrls, undefined);
    assert.ok(!JSON.stringify(response).includes(first), 'Intermediate reference stays server-side');
  }
}
try {
  // Prompt template loading remains shared, rejects empty/HTTP failures and can retry.
  let fetchCount = 0;
  const responses = [
    { ok: false, text: async () => 'error page' },
    { ok: true, text: async () => '  ' },
    { ok: true, text: async () => input().prompt },
  ];
  const prompt = compile(read('../../web/src/services/multiviewReferencePrompt.ts'), {
    './multiviewReferencePrompt.txt?no-inline&url': '/assets/prompt.txt',
  }, { fetch: async () => { fetchCount++; return responses.shift(); } });
  await assert.rejects(prompt.buildMultiviewPrompt(''), /提示词加载失败或为空/);
  await assert.rejects(prompt.buildMultiviewPrompt(''), /提示词加载失败或为空/);
  const [basePrompt, supplementedPrompt] = await Promise.all([
    prompt.buildMultiviewPrompt(''), prompt.buildMultiviewPrompt('  keep the label  '),
  ]);
  assert.equal(basePrompt, input().prompt);
  assert.equal(supplementedPrompt, `${input().prompt}\n\n用户补充要求：keep the label`);
  assert.equal(fetchCount, 3);

  // Execute the panel's actual request expression and client serializer (no network).
  const panel = ts.createSourceFile('GeneratePanel.tsx', read('../../web/src/components/panels/GeneratePanel.tsx'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function find(node, predicate) {
    if (predicate(node)) return node;
    return ts.forEachChild(node, child => find(child, predicate));
  }
  const paired = find(panel, n => ts.isFunctionDeclaration(n) && n.name?.text === 'generatePairedMultiviewReference');
  const requestCall = find(paired, n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
    && n.expression.name.text === 'generateTextureSingleView');
  const make = compile(`export function request() { return ${requestCall.arguments[0].getText(panel)}; }`, {}, {
    generationId: 'client-job', currentProject: { id: 'project' }, submittedPrompt: input().prompt,
    singleReference: { id: 'original', name: 'original.png', url: 'https://example.test/original.png' },
    resolution: 2048, imageSize: '2K', resolveRequestImageSize: value => value,
  });
  let wireRequest;
  const client = compile(read('../../web/src/services/liclickApiClient.ts'), {
    './liclickTransport': { resolveLiclickTransport: async () => ({ baseUrl: 'https://example.test', credentials: 'include' }) },
    './referenceImagePreprocessor': { prepareReferenceForAtlas: async value => value },
    '@/utils/mapWithConcurrency': { mapWithConcurrency: async (values, _, map) => Promise.all(values.map(map)) },
  }, {
    window: { setTimeout, clearTimeout },
    fetch: async (_, options) => {
      wireRequest = JSON.parse(options.body);
      return { ok: true, json: async () => ({ id: 'stable-server-job', status: 'running', taskId: 'first-remote-task' }) };
    },
  }).createLiclickApiClient();
  const frontend = await client.generateTextureSingleView(make.request());
  assert.equal(wireRequest.referencePipeline, 'six-view-delight-v1');
  assert.equal(wireRequest.model, model);
  assert.equal(wireRequest.quality, 'low');
  assert.equal(wireRequest.imageSize, '2K');
  assert.equal(wireRequest.aspectRatio, '3:2');
  assert.equal(frontend.metadata.serverJobId, 'stable-server-job');
  assert.equal(frontend.resultUrl, undefined);

  // Exercise actual route submission, forced first-stage settings, polling and publication.
  const calls = [];
  const api = harness(path.join(root, 'normal'), async (request, context) => {
    calls.push({ request, context });
    if (calls.length === 2) {
      const persisted = JSON.parse(fs.readFileSync(path.join(root, 'normal', 'generation-jobs.json')))[0];
      assert.equal(persisted.referenceDelight.stage, 'submitting');
      assert.equal(persisted.referenceDelight.prompt, api.referenceDelightPrompt);
      assert.equal(persisted.resultUrl, undefined);
      assert.equal(persisted.taskId, undefined);
      noIntermediate(api, api.generationJobs.get('normal'));
    }
    return { ...submission(`stage-${calls.length}`), extraParams: { quality: request.quality } };
  }, async taskId => ({ resultUrl: taskId === 'stage-1' ? first : final, status: 'succeeded', raw: {} }));
  const user = { id: 'owner', atlasHomeDir: job().atlasHomeDir };
  const normal = api.createGenerationJob('normal', user, { ...input(), model: 'other', quality: 'high', count: 4 });
  await normal.promise;
  assert.equal(calls.length, 2);
  assert.equal(calls[0].request.quality, 'low');
  assert.equal(calls[0].request.model, model);
  assert.equal(calls[0].request.count, 1);
  assert.equal(calls[1].request.quality, 'medium');
  assert.equal(calls[1].request.model, model);
  assert.equal(calls[1].request.aspectRatio, '3:2');
  assert.equal(calls[1].request.imageSize, '2K');
  assert.equal(calls[1].request.referencePipeline, undefined);
  assert.equal(calls[1].request.prompt, api.referenceDelightPrompt);
  assert.deepEqual(calls[1].request.references.map(r => r.url), [first]);
  assert.equal(calls[0].context.atlasHomeDir, calls[1].context.atlasHomeDir, 'Both stages use the same personal account');
  assert.equal(calls[0].context.userId, 'owner', 'Uploads carry the authenticated asset owner');
  assert.equal(calls[0].context.projectId, 'project', 'Uploads carry the owned project');
  assert.equal(api.getJobResponse(normal).resultUrl, final);
  assert.equal(normal.referenceDelight.stage, 'complete');
  assert.equal(normal.extraParams.quality, 'medium');

  // Both providers can return an image immediately instead of a task ID.
  const immediateApi = harness(path.join(root, 'immediate'), async () => submission('two', final));
  const immediate = job(); immediate.status = 'submitting';
  await immediateApi.applySubmission(immediate, submission('one', first));
  assert.equal(immediate.status, 'succeeded');
  assert.equal(immediate.resultUrl, final);

  // Concurrent browser/background polling must share the second submission; cancellation wins.
  let resolveSecond;
  let secondCalls = 0;
  const pendingApi = harness(path.join(root, 'pending'), () => {
    secondCalls++;
    return new Promise(resolve => { resolveSecond = resolve; });
  }, async () => ({ resultUrl: first, status: 'succeeded', raw: {} }));
  const pending = job();
  const polls = [pendingApi.pollAndUpdateJob(pending), pendingApi.pollAndUpdateJob(pending)];
  while (!resolveSecond) await delay(1);
  noIntermediate(pendingApi, pending);
  pendingApi.startGenerationJob(pending);
  assert.equal(pending.promise, undefined, 'Recovery must not interrupt in-flight stage transition');
  await pendingApi.cancelGenerationJob(pending);
  resolveSecond(submission('two', final));
  await Promise.all(polls);
  assert.equal(secondCalls, 1);
  assert.equal(pending.status, 'failed');
  assert.equal(pending.resultUrl, undefined);

  // Known second-stage task resumes from the actual persisted recovery file without resubmission.
  const recoverDir = path.join(root, 'recover');
  const before = harness(recoverDir, async () => submission('two'));
  const recovering = job(); before.generationJobs.set(recovering.id, recovering);
  await before.advanceReferenceDelight(recovering, { resultUrl: first }, before.saveGenerationJobs);
  const after = harness(recoverDir, async () => { throw new Error('Must not resubmit'); }, async taskId => {
    assert.equal(taskId, 'two'); return { resultUrl: final, status: 'succeeded', raw: {} };
  });
  await after.loadGenerationJobs();
  const restored = after.generationJobs.get(recovering.id);
  noIntermediate(after, restored);
  after.startGenerationJob(restored); await restored.promise;
  assert.equal(restored.resultUrl, final);

  // Restoring a first-stage task continues the pipeline, without rerunning the first generation.
  const restartFirst = job();
  const restartCalls = [];
  const restartApi = harness(path.join(root, 'restart-first'), async request => {
    restartCalls.push(request); return submission('two', final);
  }, async () => ({ resultUrl: first, status: 'succeeded', raw: {} }));
  restartApi.startGenerationJob(restartFirst); await restartFirst.promise;
  assert.deepEqual(restartCalls.map(r => r.quality), ['medium']);
  assert.equal(restartFirst.resultUrl, final);

  // Failed/ambiguous persistence or submission never automatically retries a paid request.
  let forbiddenCalls = 0;
  const safe = harness(path.join(root, 'failure'), async () => { forbiddenCalls++; return submission('two'); });
  const diskFailure = job();
  await safe.advanceReferenceDelight(diskFailure, { resultUrl: first }, async strict => {
    if (strict) throw new Error('Disk full');
  });
  assert.equal(diskFailure.status, 'failed');
  assert.equal(forbiddenCalls, 0);
  const cancelled = job();
  await safe.advanceReferenceDelight(cancelled, { resultUrl: first }, async () => { cancelled.status = 'failed'; });
  assert.equal(forbiddenCalls, 0);
  const ambiguous = job();
  await safe.advanceReferenceDelight(ambiguous, { resultUrl: first }, async () => {}, async () => {
    throw new Error('Submission response lost');
  });
  assert.equal(ambiguous.status, 'failed');
  const uncertainRestart = { ...safe.getPersistableJob(ambiguous), status: 'running' };
  safe.startGenerationJob(uncertainRestart); await uncertainRestart.promise;
  assert.equal(uncertainRestart.status, 'failed');
  assert.equal(forbiddenCalls, 0);
  assert.match(uncertainRestart.error, /不会自动重新提交/);
  const receiptFailure = job();
  let saves = 0;
  await safe.advanceReferenceDelight(receiptFailure, { resultUrl: first }, async strict => {
    if (++saves === 2 && strict) throw new Error('Cannot persist receipt');
  }, async () => submission('two', final));
  assert.equal(receiptFailure.status, 'failed');
  assert.equal(receiptFailure.resultUrl, undefined);

  // A first-stage failure never starts de-lighting; a second failure never publishes stage one.
  for (const stage of [1, 2]) {
    const failed = job();
    if (stage === 2) failed.referenceDelight = { stage: 'running', inputUrl: first, prompt: safe.referenceDelightPrompt };
    const failedApi = harness(path.join(root, `failed-${stage}`), async () => { throw new Error('Unexpected submit'); },
      async () => { throw new Error('Provider rejected task'); });
    await failedApi.pollAndUpdateJob(failed);
    assert.equal(failed.status, 'failed');
    assert.equal(failedApi.getJobResponse(failed).resultUrl, undefined);
  }
  for (const workflow of ['liclick', 'texture-map', 'local-repaint']) {
    const legacy = job(); legacy.input.referencePipeline = undefined; legacy.workflow = workflow;
    await safe.applySubmission(legacy, submission('legacy', first));
    assert.equal(legacy.resultUrl, first, 'Unflagged jobs remain single-stage');
    assert.equal(legacy.referenceDelight, undefined);
  }
  console.log('PASS: two-stage reference generation, final-only publication, concurrency, cancellation, recovery and failure boundaries.');
} finally {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.match(path.basename(root), /^li3d-reference-pipeline-/);
  fs.rmSync(root, { recursive: true, force: true });
}
