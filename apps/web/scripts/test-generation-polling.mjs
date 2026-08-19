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
  server: { middlewareMode: true },
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

  const identity = await server.ssrLoadModule('/src/services/localIdentityProofApiClient.ts');
  const generationTiming = await server.ssrLoadModule('/src/utils/generationTiming.ts');
  const generationIdentity = await server.ssrLoadModule('/src/utils/generationIdentity.ts');
  const generationStore = await server.ssrLoadModule('/src/stores/generationStore.ts');

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
    identity.getLocalIdentityProof({ timeoutMs: 25 }),
    /登录服务响应超时/,
  );
  assert(
    Date.now() - timeoutStartedAt < 1_000,
    'A stalled identity request must be released by its watchdog.',
  );

  const callerController = new globalThis.AbortController();
  const cancelledRequest = identity.getLocalIdentityProof({
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
