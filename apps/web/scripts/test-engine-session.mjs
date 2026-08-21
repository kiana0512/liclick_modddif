/* global console, crypto, DOMException, document, window */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

globalThis.document = { documentElement: { dataset: {} } };
globalThis.window = { setTimeout, clearTimeout };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

const plan = {
  policyVersion: 1,
  textureBackend: 'webgpu-worker',
  cpuBackend: 'wasm-worker',
  persistenceBackend: 'opfs',
  qualityTier: 'high',
  maxHeavyTaskConcurrency: 2,
  serverFallbackAllowed: false,
  limitations: [],
};

try {
  const { EngineSession } = await server.ssrLoadModule('/src/engine/session/engineSession.ts');
  const session = new EngineSession('project-engine-test', plan);
  let activeCpuTasks = 0;
  let maximumCpuTasks = 0;
  const releases = [];
  const runCpuTask = (id) =>
    session.schedule({
      key: `cpu-${id}`,
      label: `CPU ${id}`,
      lane: 'cpu',
      replace: false,
      run: () =>
        new Promise((resolve) => {
          activeCpuTasks += 1;
          maximumCpuTasks = Math.max(maximumCpuTasks, activeCpuTasks);
          releases.push(() => {
            activeCpuTasks -= 1;
            resolve(id);
          });
        }),
    });
  const cpuTasks = [runCpuTask(1), runCpuTask(2), runCpuTask(3)];
  assert.equal(session.snapshot().activeTasks, 2);
  assert.equal(session.snapshot().queuedTasks, 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  releases.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(maximumCpuTasks, 2);
  while (releases.length) releases.shift()();
  assert.deepEqual(await Promise.all(cpuTasks), [1, 2, 3]);

  let firstCancelled = false;
  const first = session
    .schedule({
      key: 'replaceable-gpu',
      label: 'stale GPU task',
      lane: 'gpu',
      run: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            firstCancelled = true;
            reject(new DOMException('cancelled', 'AbortError'));
          });
        }),
    })
    .catch((error) => error);
  await Promise.resolve();
  const second = session.schedule({
    key: 'replaceable-gpu',
    label: 'latest GPU task',
    lane: 'gpu',
    run: async () => 'latest',
  });
  assert.equal((await first).name, 'AbortError');
  assert.equal(await second, 'latest');
  assert.equal(firstCancelled, true);

  const disposed = [];
  let activeTaskCleaned = false;
  const activeAtDispose = session
    .schedule({
      key: 'dispose-order',
      label: 'dispose order task',
      lane: 'gpu',
      run: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            activeTaskCleaned = true;
            reject(new DOMException('cancelled', 'AbortError'));
          });
        }),
    })
    .catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 0));
  session.registerResource({
    id: 'gpu-texture',
    kind: 'gpu',
    label: 'GPU texture',
    estimatedBytes: 1024,
    dispose: () => {
      assert.equal(activeTaskCleaned, true, 'Active tasks must drain before resources are disposed.');
      disposed.push('gpu-texture');
    },
  });
  session.registerResource({
    id: 'uv-worker',
    kind: 'worker',
    label: 'UV worker',
    estimatedBytes: 2048,
    dispose: () => disposed.push('uv-worker'),
  });
  assert.equal(session.snapshot().estimatedResourceBytes, 3072);
  await session.dispose();
  assert.equal((await activeAtDispose).name, 'AbortError');
  assert.deepEqual(disposed, ['uv-worker', 'gpu-texture']);
  assert.equal(session.snapshot().state, 'disposed');
  assert.equal(session.snapshot().resources, 0);
  console.log('Engine Session concurrency, replacement and resource lifecycle tests passed.');
} finally {
  await server.close();
}
