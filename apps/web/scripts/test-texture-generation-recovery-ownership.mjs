import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const read = (path) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');
const compile = (source) => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;
export const ownershipPolicy = {};
new Function('exports', compile(await read('engine/generation/textureGenerationRecoveryOwnership.ts')))(ownershipPolicy);
const {
  createTextureGenerationRecoveryOwnership,
  isRejectedTextureReturn,
  isTextureReturnQaFailure,
  textureReturnQaFailureMetadata,
} = ownershipPolicy;
const owner = createTextureGenerationRecoveryOwnership();
const oldTicket = owner.backgroundTicket('p', 'texture-map');
assert(oldTicket());
const release = owner.begin('p');
assert(!oldTicket());
assert(!owner.backgroundTicket('p', 'texture-map')());
assert(owner.backgroundTicket('other', 'texture-map')());
assert(owner.backgroundTicket('p', 'local-repaint')());
assert(owner.backgroundTicket('p', 'reference')());
const releaseSecond = owner.begin('p');
release(); release();
assert(!owner.backgroundTicket('p', 'texture-map')(), 'stale/duplicate release cannot unlock another owner');
releaseSecond();
assert(!oldTicket(), 'an in-flight response crossing the entire session stays stale');
assert(owner.backgroundTicket('p', 'texture-map')(), 'reload/idle recovery remains available');
const qaError = () => Object.assign(new Error('返图透明轮廓不对齐。'), { code: 'GPT_RETURN_SILHOUETTE_MISMATCH' });
const ratioQaError = () => Object.assign(new Error('返图比例不对齐。'), { code: 'GPT_RETURN_FRAME_RATIO_MISMATCH' });
assert(isTextureReturnQaFailure(qaError()));
assert(isTextureReturnQaFailure(ratioQaError()));
assert(isRejectedTextureReturn(textureReturnQaFailureMetadata(qaError())));
assert(isRejectedTextureReturn(textureReturnQaFailureMetadata(ratioQaError())));
assert(!isTextureReturnQaFailure(new Error('network')));
assert(isRejectedTextureReturn({ silhouetteRetryGenerationId: 'retry' }));
assert(!isRejectedTextureReturn({ silhouetteRetryOf: 'original' }));
assert(!isRejectedTextureReturn(textureReturnQaFailureMetadata(new Error('network'))));
const retryPolicy = {};
new Function('exports', compile(await read('engine/generation/gptReturnSilhouetteRetry.ts')))(retryPolicy);
const retry = retryPolicy.createTextureMapSilhouetteRetry({ id: 'job', prompt: 'paint', metadata: {
  ...textureReturnQaFailureMetadata(qaError()), silhouetteRetryGenerationId: 'old', captureId: 'frozen',
} }).generation;
assert(!isRejectedTextureReturn(retry.metadata), 'fresh retry must not inherit the rejected-result marker');

// Execute the production background adapters, not a second implementation.
const panel = await read('components/panels/GeneratePanel.tsx');
const ast = ts.createSourceFile('panel.tsx', panel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
let pollEffect;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' &&
      node.arguments[0]?.getText(ast).includes('const generationToPoll =')) pollEffect = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast); assert(pollEffect);
const build = (source, scope) => new Function(...Object.keys(scope), compile(`return (${source});`))(...Object.values(scope));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const gen = (id = 'job') => ({ id, prompt: 'paint', referenceIds: [], status: 'running', metadata: {
  workflow: 'texture-map', projectId: 'p', provider: 'liclick-atlas', serverSubmitted: true,
} });
const failed = (g, error, metadata = {}) => ({ ...g, status: 'failed', metadata: { ...g.metadata, ...metadata, error } });

for (const outcome of ['qa', 'success']) {
  const ownership = createTextureGenerationRecoveryOwnership(), pending = deferred(), writes = [];
  let calls = 0;
  const scope = {
    ...ownershipPolicy, activeReferenceGeneration: undefined, previewGeneration: gen(), currentProjectId: 'p',
    textureRecoveryOwnershipRef: { current: ownership }, cancelledGenerationIdsRef: { current: new Set() },
    generationAbortControllersRef: { current: new Map() }, generationPollFailureCountsRef: { current: new Map() },
    generationMetadataString: (g, key) => g.metadata[key], isLocalRepaintGeneration: () => false,
    isGenerationSubmittedToServer: () => true, generationPollToastKey: id => id,
    createLiclickApiClient: () => ({ getGenerationJob: () => { calls++; return pending.promise; } }),
    window: { addEventListener() {}, removeEventListener() {}, setTimeout() {}, clearTimeout() {}, dispatchEvent() {} },
    document: { addEventListener() {}, removeEventListener() {} },
    setGenerateNotice: value => writes.push(value), syncGeneration: value => writes.push(value),
    markGenerationFailed: (...values) => writes.push(values), dismissToastByDedupeKey() {},
    prepareCloudRepaintCompletion: async value => value,
    useProjectStore: { getState: () => ({ projects: [] }) },
    isRetryableGenerationPollError: () => false, getUserFacingGenerationError: String,
    console: { info() {}, warn() {}, error() {} },
  };
  const effect = build(pollEffect, scope);
  const cleanup = effect();
  assert.equal(calls, 1);
  const end = ownership.begin('p');
  assert.equal(effect(), undefined, 'foreground prevents a second background QA request');
  if (outcome === 'success') end(); // Late success after foreground has already finished is also stale.
  if (outcome === 'qa') pending.reject(qaError());
  else pending.resolve({ status: 'succeeded', resultUrl: 'raw-result' });
  await flush();
  assert.deepEqual(writes, [], 'late result/error cannot alter status, notice, or projection');
  cleanup(); end();
  let watchdogCallback;
  const endWatchdog = ownership.begin('p');
  const waiting = { ...gen(), metadata: { ...gen().metadata, serverSubmitted: false } };
  const watchdogScope = { ...scope, previewGeneration: waiting,
    isGenerationSubmittedToServer: g => g.metadata.serverSubmitted,
    getGenerationStartedAt: () => Date.now(), pendingSubmissionTimeoutMs: 90000,
    window: { ...scope.window, setTimeout: callback => { watchdogCallback = callback; } },
    useGenerationStore: { getState: () => ({ generations: [waiting] }) },
    isRunningGeneration: g => g.status === 'running', failUnsubmittedGeneration: g => writes.push(g),
  };
  const cleanupWatchdog = build(pollEffect, watchdogScope)();
  assert(watchdogCallback, 'foreground must retain the bounded pre-submission watchdog');
  waiting.metadata.serverSubmitted = true;
  watchdogCallback();
  assert.deepEqual(writes, [], 'watchdog ignores a task accepted before its timeout');
  waiting.metadata.serverSubmitted = false;
  watchdogCallback();
  assert.equal(writes.length, 1);
  cleanupWatchdog(); endWatchdog();
}

// One rejected historical result must neither be revived nor starve its sibling.
const recovered = new Map(), jobs = ['bad', 'good'].map(id => ({ id, projectId: 'p', workflow: 'texture-map',
  prompt: 'paint', referenceIds: [], status: 'succeeded', framing: {}, resultUrl: `raw:${id}` }));
let qaCalls = 0;
const recoveryOwner = createTextureGenerationRecoveryOwnership();
const scope = {
  ...ownershipPolicy, recoveryProjectId: 'p', cancelled: false,
  textureRecoveryOwnershipRef: { current: recoveryOwner },
  useGenerationStore: { getState: () => ({ generations: [...recovered.values()] }) },
  useProjectStore: { getState: () => ({ projects: [{ id: 'p', generations: [...recovered.values()], captures: [] }] }) },
  matchesJob: (g, job) => g.id === job.id, generationAbortControllersRef: { current: new Map() },
  isLocalRepaintGeneration: () => false, isWorkspaceAssetUrl: () => false,
  restoreFramedJobResult: async job => { qaCalls++; if (job.id === 'bad') throw qaError(); return { resultUrl: `validated:${job.id}` }; },
  createFailedGeneration: failed, getUserFacingGenerationError: error => error.message,
  prepareCloudRepaintCompletion: async g => g, generationIdentityIds: g => [g.id],
  cancelledGenerationIdsRef: { current: new Set() }, sameGenerationRecovery: () => false,
  syncGeneration: g => recovered.set(g.id, g),
};
const reconcile = build(functions.get('reconcileJob'), scope);
const end = recoveryOwner.begin('p');
for (const job of jobs) await reconcile(job);
assert.equal(qaCalls, 0, 'active foreground owns result validation');
end();
for (const job of jobs) await reconcile(job);
assert.equal(recovered.get('bad').metadata.returnQaRejected, true);
assert.equal(recovered.get('good').resultUrl, 'validated:good');
const callsBefore = qaCalls;
await reconcile(jobs[0]);
assert.equal(qaCalls, callsBefore, 'terminal QA result is not validated on every reconciliation');
for (const outcome of ['qa', 'success']) {
  const pending = deferred(), writes = [];
  const staleReconcile = build(functions.get('reconcileJob'), { ...scope,
    restoreFramedJobResult: () => pending.promise,
    syncGeneration: g => writes.push(g),
  });
  const recovery = staleReconcile({ ...jobs[1], id: 'late' });
  const endLate = recoveryOwner.begin('p');
  endLate();
  if (outcome === 'qa') pending.reject(qaError());
  else pending.resolve({ resultUrl: 'late-result' });
  await recovery;
  assert.deepEqual(writes, [], 'historical recovery also rejects late QA failures and successes');
}
let visited = [], saveEvents = 0;
const reconcileJobs = build(functions.get('reconcileJobs'), {
  cancelled: false, inFlight: false, recoveryProjectId: 'p',
  client: { listGenerationJobs: async () => [...jobs].reverse() },
  reconcileJob: async job => {
    visited.push(job.id);
    if (job.id === 'bad') throw new Error('transient network');
    return { changed: true, needsPersist: false };
  },
  persistenceAttemptedAt: new Map(), isRetryableGenerationPollError: () => true,
  window: { dispatchEvent: () => { saveEvents++; } }, IMMEDIATE_PROJECT_SAVE_EVENT: 'save',
  scheduleReconcile: () => visited.push('retry'), LiclickApiError: class extends Error {},
});
await reconcileJobs();
assert.deepEqual(visited, ['bad', 'good', 'retry'], 'one transient history failure does not starve its sibling');
assert.equal(saveEvents, 1);
assert.match(functions.get('reconcileJobs'), /try\s*\{\s*reconciliation = await reconcileJob\(job\);\s*\}\s*catch/);
assert.match(panel, /\[authStatus, currentProjectId, submissionActive, syncGeneration\]/);
console.log('Texture QA foreground ownership, stale-response guards, terminal rejection and isolated recovery passed.');
