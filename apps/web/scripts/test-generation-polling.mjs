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

try {
  globalThis.window = {
    location: {
      hostname: '127.0.0.1',
      port: '4517',
      protocol: 'http:',
      origin: 'http://127.0.0.1:4517',
    },
    setTimeout,
    clearTimeout,
  };
  globalThis.fetch = (_url, init = {}) =>
    new Promise((_resolve, reject) => {
      const rejectAsAborted = () =>
        reject(new globalThis.DOMException('The operation was aborted.', 'AbortError'));
      if (init.signal?.aborted) rejectAsAborted();
      else init.signal?.addEventListener('abort', rejectAsAborted, { once: true });
    });

  const identity = await server.ssrLoadModule('/src/services/localIdentityProofApiClient.ts');
  const generationTiming = await server.ssrLoadModule('/src/utils/generationTiming.ts');

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
  await server.close();
}
