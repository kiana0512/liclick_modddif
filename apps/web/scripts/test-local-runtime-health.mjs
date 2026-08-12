import assert from 'node:assert/strict';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const missing = { status: 'missing', reason: 'temporarily unavailable' };
const ready = {
  status: 'ready',
  health: { ok: true, runtimeVersion: '0.1.11', capabilities: ['texture-painting'] },
};

try {
  const policy = await server.ssrLoadModule('/src/hooks/localTextureRuntimePolicy.ts');
  const { TextureRuntimeGate } = await server.ssrLoadModule(
    '/src/components/runtime/TextureRuntimeGate.tsx',
  );

  let cold = policy.createLocalTextureRuntimeMonitorState();
  cold = policy.applyLocalTextureRuntimeProbe(cold, missing);
  assert.equal(cold.runtime.status, 'checking');
  assert.equal(cold.consecutiveFailures, 1);
  cold = policy.applyLocalTextureRuntimeProbe(cold, missing);
  assert.equal(cold.runtime.status, 'checking');
  cold = policy.applyLocalTextureRuntimeProbe(cold, missing);
  assert.equal(cold.runtime.status, 'missing');
  assert.equal(
    cold.consecutiveFailures,
    policy.localTextureRuntimeFailureThreshold,
    'A cold start must require consecutive failures before showing the installer.',
  );

  let admitted = policy.createLocalTextureRuntimeMonitorState();
  admitted = policy.applyLocalTextureRuntimeProbe(admitted, ready);
  admitted = policy.applyLocalTextureRuntimeProbe(admitted, missing);
  assert.equal(admitted.hasReadySession, true);
  assert.equal(admitted.reconnecting, true);
  assert.equal(admitted.runtime.status, 'missing');
  assert(
    policy.getLocalTextureRuntimeRetryDelay(admitted) > 0,
    'An admitted editor session must automatically retry after a transient failure.',
  );
  admitted = policy.applyLocalTextureRuntimeProbe(admitted, ready);
  assert.equal(admitted.reconnecting, false);
  assert.equal(admitted.consecutiveFailures, 0);

  const pending = deferred();
  let probeCalls = 0;
  const runProbe = policy.createSingleFlightProbe(() => {
    probeCalls += 1;
    return pending.promise;
  });
  const firstProbe = runProbe();
  const secondProbe = runProbe();
  assert.equal(firstProbe, secondProbe, 'Concurrent refreshes must share one health request.');
  assert.equal(probeCalls, 1);
  pending.resolve(ready);
  await firstProbe;
  await Promise.resolve();
  void runProbe();
  assert.equal(probeCalls, 2, 'A completed health request must allow the next scheduled probe.');

  const child = createElement('div', { 'data-testid': 'editor-child' }, 'editor remains mounted');
  const admittedMarkup = renderToStaticMarkup(
    createElement(
      TextureRuntimeGate,
      {
        state: missing,
        hasReadySession: true,
        onRetry() {},
        onBack() {},
      },
      child,
    ),
  );
  assert.match(admittedMarkup, /data-testid="editor-child"/);
  assert.match(admittedMarkup, /本地组件暂时无响应/);
  assert.doesNotMatch(admittedMarkup, /下载本地组件/);
  assert.match(admittedMarkup, /role="status"/);

  const coldMarkup = renderToStaticMarkup(
    createElement(
      TextureRuntimeGate,
      {
        state: missing,
        hasReadySession: false,
        onRetry() {},
        onBack() {},
      },
      child,
    ),
  );
  assert.doesNotMatch(coldMarkup, /data-testid="editor-child"/);
  assert.match(coldMarkup, /下载本地组件/);

  stdout.write('Local runtime health and editor gate regression tests passed.\n');
} finally {
  await server.close();
}
