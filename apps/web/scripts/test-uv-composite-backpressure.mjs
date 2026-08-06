import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

class FakeBitmap {
  closeCount = 0;

  close() {
    this.closeCount += 1;
  }
}

class FakeWorker {
  static instance;

  messages = [];
  onmessage;
  onerror;

  constructor() {
    FakeWorker.instance = this;
  }

  postMessage(message) {
    this.messages.push(message);
  }

  respond(id) {
    this.onmessage?.({
      data: { id, bitmap: new FakeBitmap(), width: 4, height: 4 },
    });
  }

  terminate() {}
}

globalThis.Worker = FakeWorker;
globalThis.document = { body: { dataset: {} } };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  const scheduler = await server.ssrLoadModule(
    '/src/engine/layers/uvLayerCompositeWorker.ts',
  );
  const firstSource = new FakeBitmap();
  const replacedSource = new FakeBitmap();
  const latestSource = new FakeBitmap();
  const first = scheduler.compositeUvLayersInWorker([
    { bitmap: firstSource, opacity: 1 },
  ]);
  const replaced = scheduler
    .compositeUvLayersInWorker([{ bitmap: replacedSource, opacity: 1 }])
    .catch((error) => error);
  const latest = scheduler.compositeUvLayersInWorker([
    { bitmap: latestSource, opacity: 1 },
  ]);

  assert.equal(FakeWorker.instance.messages.length, 1, 'Only one full-resolution job may run.');
  assert.equal(replacedSource.closeCount, 1, 'A superseded queued bitmap must be released.');
  assert.equal((await replaced).name, 'AbortError');

  FakeWorker.instance.respond(1);
  await first;
  assert.equal(
    FakeWorker.instance.messages.length,
    2,
    'Only the newest queued composition should run next.',
  );
  assert.equal(FakeWorker.instance.messages[1].id, 3);
  FakeWorker.instance.respond(3);
  await latest;
  assert.equal(globalThis.document.body.dataset.uvCompositeQueueDepth, '0');
  assert.equal(globalThis.document.body.dataset.uvCompositeReplacedCount, '1');
  process.stdout.write('UV composition backpressure regression test passed.\n');
} finally {
  await server.close();
}
