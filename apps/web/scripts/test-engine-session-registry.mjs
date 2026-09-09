import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const timers = new Map();
let nextTimerId = 1;
globalThis.document = { documentElement: { dataset: {} } };
globalThis.window = {
  setTimeout(callback) {
    const id = nextTimerId++;
    timers.set(id, callback);
    return id;
  },
  clearTimeout(id) {
    timers.delete(id);
  },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } },
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
  const {
    acquireEngineSession,
    engineSessionRegistrySnapshot,
    peekEngineSession,
    releaseEngineSession,
  } = await server.ssrLoadModule('/src/engine/session/engineSessionRegistry.ts');
  let disposedResources = 0;
  let mostRecentSession;
  for (let index = 0; index < 24; index += 1) {
    const projectId = `registry-project-${index}`;
    const session = acquireEngineSession(projectId, plan);
    session.registerResource({
      id: `texture-${index}`,
      kind: 'gpu',
      label: `GPU texture ${index}`,
      estimatedBytes: 8 * 1024 * 1024,
      dispose: () => {
        disposedResources += 1;
      },
    });
    releaseEngineSession(projectId);
    mostRecentSession = session;
  }
  await Promise.resolve();
  const bounded = engineSessionRegistrySnapshot();
  assert.equal(bounded.total, 3);
  assert.equal(bounded.idle, 3);
  assert.equal(bounded.referenced, 0);
  assert.equal(bounded.estimatedResourceBytes, 24 * 1024 * 1024);
  assert.equal(disposedResources, 21);
  assert.equal(peekEngineSession('registry-project-0'), undefined);

  const reused = acquireEngineSession('registry-project-23', plan);
  assert.equal(reused, mostRecentSession, 'A quick route remount should reuse the latest session.');
  releaseEngineSession('registry-project-23');

  for (const callback of [...timers.values()]) callback();
  timers.clear();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(engineSessionRegistrySnapshot(), {
    total: 0,
    referenced: 0,
    idle: 0,
    estimatedResourceBytes: 0,
  });
  assert.equal(disposedResources, 24);
  console.log('Engine Session registry bounded-idle and GPU resource disposal test passed.');
} finally {
  await server.close();
}
