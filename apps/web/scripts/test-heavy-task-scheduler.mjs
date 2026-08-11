import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

globalThis.document = { body: { dataset: {} } };
globalThis.window = {
  requestAnimationFrame: (callback) => setTimeout(() => callback(performance.now()), 0),
  setTimeout,
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  const scheduler = await server.ssrLoadModule('/src/engine/performance/heavyTaskScheduler.ts');
  const order = [];
  let releaseFirst;
  const first = scheduler.scheduleHeavyTask({
    key: 'texture',
    label: 'first',
    onQueued: () => order.push('feedback:first'),
    run: ({ signal }) =>
      new Promise((resolve, reject) => {
        order.push('start:first');
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
        releaseFirst = resolve;
      }),
  }).catch((error) => error);
  const startDeadline = performance.now() + 1_000;
  while (!releaseFirst && performance.now() < startDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(releaseFirst, 'The first task should start after the feedback paint.');
  const second = scheduler.scheduleHeavyTask({
    key: 'texture',
    label: 'second',
    onQueued: () => order.push('feedback:second'),
    run: async () => {
      order.push('start:second');
      return 'latest';
    },
  });
  releaseFirst('stale');
  assert.equal((await first).name, 'AbortError');
  assert.equal(await second, 'latest');
  assert.deepEqual(order, ['feedback:first', 'start:first', 'feedback:second', 'start:second']);
  assert.equal(document.body.dataset.heavyTaskQueueDepth, '0');
  console.log('Heavy task scheduler regression test passed.');
} finally {
  await server.close();
}
