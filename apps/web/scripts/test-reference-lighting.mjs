/* global AbortController */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../src/services/referenceLighting.ts', import.meta.url), 'utf8');
class ApiError extends Error { constructor(status) { super(String(status)); this.status = status; } }
const jobs = new Map();
let submissions = 0;
let complete = true;
let user = 'one';
const storage = new Map();
const api = {
  async getGenerationJob(id) { if (!jobs.has(id)) throw new ApiError(404); return jobs.get(id); },
  async generateTextureSingleView(input) {
    submissions++;
    assert.equal(input.referencePipeline, 'delight-only-v1');
    assert.equal(input.backgroundReference, true);
    assert.equal(input.referenceImages.length, 1);
    const job = { id: input.clientGenerationId, status: complete ? 'succeeded' : 'running',
      resultUrl: complete ? '/processed.png' : undefined, metadata: {} };
    jobs.set(job.id, job); return job;
  },
  async cancelGenerationJob(id) { const job = jobs.get(id); job.status = 'failed'; return job; },
};
function load() {
  const text = source.replace(/^import .*;\r?\n/gm, '');
  const compiled = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('exports', 'createLiclickApiClient', 'LiclickApiError', 'useAuthStore', 'urlToBlob', 'localStorage', 'setTimeout', 'window', compiled)(
    exports, () => api, ApiError, { getState: () => ({ user: { id: user } }) }, async () => new Blob(['identical bytes']),
    { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, fn => setTimeout(fn, 1), { addEventListener() {} });
  return exports;
}
const reference = { id: 'ref', url: '/original.png', referenceRole: 'single-view' };
let service = load();
const [a, b] = await Promise.all([service.prepareReferenceLighting('project', reference), service.prepareReferenceLighting('project', reference)]);
assert.equal(submissions, 1);
assert.equal(a.url, '/processed.png');
assert.deepEqual(a, b);
assert.equal(reference.url, '/original.png', 'Never replace displayed source');
await service.prepareReferenceLighting('project', { ...reference, url: '/persisted-original.png' });
assert.equal(submissions, 1, 'Saving identical bytes under a durable URL does not generate twice');
service = load();
await service.prepareReferenceLighting('project', reference);
assert.equal(submissions, 1, 'Reload recovers completed server binding');
user = 'two';
await service.prepareReferenceLighting('project', reference);
assert.equal(submissions, 2, 'Account ownership is isolated');
complete = false;
const controller = new AbortController();
const waiter = service.prepareReferenceLighting('pending', reference, controller.signal);
while (!service.hasReferenceLightingWork('pending') || submissions < 3) await new Promise(resolve => setTimeout(resolve, 1));
controller.abort();
await assert.rejects(waiter, { name: 'AbortError' });
assert.equal(service.hasReferenceLightingWork('pending'), true, 'Cancel consumer does not cancel background task');
await service.interruptReferenceLighting('pending');
complete = true;
await service.prepareReferenceLighting('pending', reference);
assert.equal(submissions, 4, 'Explicit interruption permits a new attempt');
console.log('Reference lighting passed: concurrent dedupe, immutable source, content identity, reload, account isolation, consumer cancellation and explicit interruption.');
