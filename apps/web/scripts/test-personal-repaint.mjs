import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/services/personalRepaintClient.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
globalThis.window = { location: { search: '?personalRepaint=1' }, prompt: () => 'test-code', setTimeout, clearTimeout };
new Function('module', 'exports', 'require', code)(module, module.exports, name => {
  assert.equal(name, './workspaceApiClient');
  return { fileToDataUrl: async () => 'data:image/png;base64,result' };
});
const { generatePersonalRepaint, connectPersonalRepaint } = module.exports;
const requests = [];
let rejectCacheOnce = false;
async function decodeRequest(init) {
  const blob = new Blob([init.body]);
  return JSON.parse(await new Response(init.headers['Content-Encoding'] === 'gzip'
    ? blob.stream().pipeThrough(new globalThis.DecompressionStream('gzip')) : blob).text());
}
globalThis.fetch = async (url, init) => {
  requests.push({ url, init });
  assert.ok(url.startsWith('https://uu765793-78993043bdb0.bjb1.seetacloud.com:8443/'));
  assert.equal(init.credentials, 'omit');
  assert.equal(init.headers.Authorization, 'Bearer test-code');
  if (url.endsWith('/health')) return new Response(JSON.stringify({ ready: true, workflow: 'cloud-existing-v1' }));
  if (url.endsWith('/result')) return new Response(new Blob(['png'], { type: 'image/png' }));
  if (rejectCacheOnce && (await decodeRequest(init)).materialImage.cacheId) {
    rejectCacheOnce = false;
    return new Response(JSON.stringify({error:'reference_cache_miss'}), {status:428});
  }
  return new Response(JSON.stringify({ id: 'job-1', materialCacheId: 'a'.repeat(64), status: 'succeeded', workflow: 'cloud-existing-v1', timings: { executionMs: 1234 } }));
};
await connectPersonalRepaint();
const input = { clientGenerationId: 'job-1', image: { dataUrl: 'image'.repeat(1000) }, materialImage: { dataUrl: 'ref'.repeat(1000) }, mask: { dataUrl: 'mask' }, normalImage: { dataUrl: 'normal' } };
const result = await generatePersonalRepaint(input);
assert.equal(result.resultUrl, 'data:image/png;base64,result');
assert.equal(result.workflow, 'cloud-existing-v1');
assert.equal(result.timings.server.executionMs, 1234);
for (const key of ['serializeMs', 'compressionMs', 'submitRoundtripMs', 'waitForJobMs', 'downloadMs', 'dataUrlMs', 'totalMs']) {
  assert.ok(Number.isFinite(result.timings[key]) && result.timings[key] >= 0, key);
}
assert.ok(Math.abs(result.timings.totalMs - ['serializeMs', 'compressionMs', 'submitRoundtripMs', 'waitForJobMs', 'downloadMs', 'dataUrlMs'].reduce((sum, key) => sum + result.timings[key], 0)) < 10);
assert.deepEqual(await decodeRequest(requests.find(r => r.init.method === 'POST').init), input);
assert.equal(requests.find(r => r.init.method === 'POST').init.headers['Content-Encoding'], 'gzip');
assert.ok(result.timings.uploadBytes < result.timings.uncompressedBytes);
assert.equal(requests.filter(r => r.init.method === 'POST').length, 1);
await generatePersonalRepaint(input);
assert.deepEqual((await decodeRequest(requests.filter(r => r.init.method === 'POST').at(-1).init)).materialImage, {cacheId:'a'.repeat(64)});
rejectCacheOnce = true;
await generatePersonalRepaint(input);
assert.equal(requests.filter(r => r.init.method === 'POST').length, 4);
assert.deepEqual(await decodeRequest(requests.filter(r => r.init.method === 'POST').at(-1).init), input);
const changedReference = {...input, materialImage:{dataUrl:'new-reference'.repeat(100)}};
const changedResult = await generatePersonalRepaint(changedReference);
assert.equal(changedResult.timings.referenceCacheHit, false);
assert.deepEqual(await decodeRequest(requests.filter(r => r.init.method === 'POST').at(-1).init), changedReference);
const aborted = new globalThis.AbortController(); aborted.abort();
const states = [];
const jobStates = ['queued', 'queued', 'running', 'succeeded'];
globalThis.fetch = async (url) => url.endsWith('/result')
  ? new Response(new Blob(['png'], {type:'image/png'}))
  : new Response(JSON.stringify({id:'queue-test', status:jobStates.shift(), workflow:'test'}));
await generatePersonalRepaint(input, undefined, state => states.push(state));
assert.deepEqual(states, ['uploading', 'queued', 'running', 'downloading']);
await assert.rejects(generatePersonalRepaint(input, aborted.signal), { name: 'AbortError' });
let failedPosts = 0;
globalThis.fetch = async () => { failedPosts++; throw new TypeError('network down'); };
await assert.rejects(generatePersonalRepaint(input), /network down/);
assert.equal(failedPosts, 1, 'Never retry ambiguous submissions');
console.log('Personal repaint: direct HTTPS, exact inputs, no cookies, cancellation and no blind retries passed.');
/* global DecompressionStream, AbortController */
