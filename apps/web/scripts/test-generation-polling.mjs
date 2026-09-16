import assert from 'node:assert/strict';
import path from 'node:path';
import { stdout } from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } },
});

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;

try {
  const localStorageValues = new Map();
  const localStorage = {
    getItem: (key) => localStorageValues.get(key) ?? null,
    setItem: (key, value) => localStorageValues.set(key, String(value)),
    removeItem: (key) => localStorageValues.delete(key),
  };
  globalThis.window = {
    location: {
      hostname: '127.0.0.1',
      port: '4517',
      protocol: 'http:',
      origin: 'http://127.0.0.1:4517',
    },
    setTimeout,
    clearTimeout,
    localStorage,
  };
  globalThis.localStorage = localStorage;
  globalThis.fetch = (_url, init = {}) =>
    new Promise((_resolve, reject) => {
      const rejectAsAborted = () =>
        reject(new globalThis.DOMException('The operation was aborted.', 'AbortError'));
      if (init.signal?.aborted) rejectAsAborted();
      else init.signal?.addEventListener('abort', rejectAsAborted, { once: true });
    });

  const auth = await server.ssrLoadModule('/src/services/authApiClient.ts');
  const generationTiming = await server.ssrLoadModule('/src/utils/generationTiming.ts');
  const generationIdentity = await server.ssrLoadModule('/src/utils/generationIdentity.ts');
  const { sameGenerationRecovery } = await server.ssrLoadModule('/src/services/generationRecoveryComparison.ts');
  const image = 'data:image/png;base64,' + 'a'.repeat(8 * 1024 * 1024);
  const comparison = { id: 'compare', prompt: '', referenceIds: ['ref'], status: 'succeeded',
    resultUrl: image, metadata: { projectId: 'project-1', resultUrls: [image] } };
  const identical = { ...comparison, referenceIds: ['ref'], metadata: { ...comparison.metadata, resultUrls: [image] } };
  assert.equal(sameGenerationRecovery(comparison, identical), true);
  assert.equal(sameGenerationRecovery(undefined, comparison), false);
  for (const [key, value] of Object.entries({ id: 'changed', prompt: 'changed', referenceIds: [], captureId: 'changed', resultUrl: image + 'b', status: 'failed' })) {
    assert.equal(sameGenerationRecovery(comparison, { ...identical, [key]: value }), false, key);
  }
  for (const key of ['clientGenerationId', 'serverJobId', 'projectId', 'workflow', 'taskId', 'model', 'resultUrls', 'startedAt', 'completedAt', 'error', 'serverSubmitted']) {
    assert.equal(sameGenerationRecovery(comparison, { ...identical, metadata: { ...identical.metadata, [key]: key === 'resultUrls' ? [image + 'b'] : 'changed' } }), false, key);
  }
  const stringify = JSON.stringify;
  JSON.stringify = () => { throw new Error('Recovery must not serialize images'); };
  try { for (let i = 0; i < 1000; i++) assert.equal(sameGenerationRecovery(comparison, identical), true); }
  finally { JSON.stringify = stringify; }
  const { getUserFacingGenerationError } = await server.ssrLoadModule('/src/services/generationErrorMessage.ts');
  assert.equal(getUserFacingGenerationError('左后视角提交失败：暂时无法连接生成服务，请检查网络后重试。'), '左后视角提交失败：暂时无法连接生成服务，请检查网络后重试。');
  const generationStore = await server.ssrLoadModule('/src/stores/generationStore.ts');
  const { isRetryableGenerationPollError } = await server.ssrLoadModule('/src/services/generationErrorMessage.ts');
  for (const status of [0, 408, 429, 500, 502, 503]) assert.equal(isRetryableGenerationPollError({ status }), true);
  for (const status of [400, 401, 403, 404, 413, 600]) assert.equal(isRetryableGenerationPollError({ status }), false);
  assert.equal(isRetryableGenerationPollError(new Error('莉刻生图服务响应超时，请稍后重试。')), true);
  assert.equal(isRetryableGenerationPollError(new Error('远端返回图片比例与提交比例不一致，已停止回贴，未拉伸图片。')), false);
  assert.equal(isRetryableGenerationPollError(new Error('结构引导图经原尺寸无损编码后仍超过 Atlas 上传限制')), false);
  assert.equal(isRetryableGenerationPollError(new DOMException('aborted', 'AbortError')), false);

  const staleRepaint = {
    id: 'local-repaint-client-id',
    mode: 'inpaint',
    prompt: '',
    referenceIds: [],
    captureId: 'capture-1',
    status: 'running',
    metadata: {
      workflow: 'local-repaint',
      provider: 'modelview-int8',
      projectId: 'project-1',
      objectId: 'object-1',
      clientGenerationId: 'local-repaint-client-id',
    },
  };
  const completedRepaintAlias = {
    ...staleRepaint,
    id: 'modelview-remote-id',
    resultUrl: 'workspace://projects/project-1/generations/result.png',
    status: 'succeeded',
    metadata: {
      ...staleRepaint.metadata,
      clientGenerationId: undefined,
      serverJobId: 'modelview-remote-id',
    },
  };
  const collapsedRepaints = generationIdentity.collapseGenerationRecords([
    staleRepaint,
    completedRepaintAlias,
  ]);
  assert.equal(
    collapsedRepaints.length,
    1,
    'A completed local repaint must evict the stale running alias for the same capture.',
  );
  assert.equal(collapsedRepaints[0].status, 'succeeded');
  assert.equal(collapsedRepaints[0].resultUrl, completedRepaintAlias.resultUrl);
  assert.equal(collapsedRepaints[0].metadata.clientGenerationId, staleRepaint.id);

  generationStore.useGenerationStore.setState({
    generations: [staleRepaint],
    currentGeneration: staleRepaint,
    isGenerating: true,
  });
  generationStore.useGenerationStore.getState().setGenerations([staleRepaint], 'project-1');
  const restoredRepaint = generationStore.useGenerationStore.getState().generations[0];
  assert.equal(
    restoredRepaint.status,
    'failed',
    'A ModelView repaint request cannot resume after the editor reloads and must be released.',
  );
  assert.equal(restoredRepaint.metadata.interrupted, true);
  assert.equal(generationStore.useGenerationStore.getState().isGenerating, false);

  const pendingStartedAt = '2026-08-05T01:02:03.000Z';
  assert.equal(
    generationTiming.mergeGenerationMetadataPreservingStartedAt(
      { startedAt: pendingStartedAt, serverSubmitted: false },
      { serverSubmitted: true },
    ).startedAt,
    pendingStartedAt,
    'Submitting a generation must not reset its elapsed timer when the server omits startedAt.',
  );
  const serverStartedAt = '2026-08-05T01:02:04.000Z';
  assert.equal(
    generationTiming.mergeGenerationMetadataPreservingStartedAt(
      { startedAt: pendingStartedAt },
      { startedAt: serverStartedAt },
    ).startedAt,
    serverStartedAt,
    'A valid server startedAt should take precedence over the pending timestamp.',
  );
  assert.equal(
    generationTiming.getGenerationStartedAt({ metadata: { startedAt: pendingStartedAt } }),
    Date.parse(pendingStartedAt),
  );

  const timeoutStartedAt = Date.now();
  await assert.rejects(
    auth.getAuthMe({ timeoutMs: 25 }),
    /登录服务响应超时/,
  );
  assert(
    Date.now() - timeoutStartedAt < 1_000,
    'A stalled identity request must be released by its watchdog.',
  );

  const callerController = new globalThis.AbortController();
  const cancelledRequest = auth.getAuthMe({
    signal: callerController.signal,
    timeoutMs: 5_000,
  });
  callerController.abort();
  await assert.rejects(
    cancelledRequest,
    (error) => error instanceof globalThis.DOMException && error.name === 'AbortError',
    'Effect cleanup must be able to cancel the identity request immediately.',
  );

  stdout.write('Generation polling and timing regression tests passed.\n');
} finally {
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
  if (originalLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = originalLocalStorage;
  await server.close();
}
