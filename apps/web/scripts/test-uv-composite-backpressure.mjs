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
  static instances = [];
  static failConstruction = false;
  static failDispatch = false;

  messages = [];
  terminateCount = 0;
  onmessage;
  onerror;

  constructor() {
    if (FakeWorker.failConstruction) throw new Error('injected worker construction failure');
    FakeWorker.instance = this;
    FakeWorker.instances.push(this);
  }

  postMessage(message) {
    if (FakeWorker.failDispatch) throw new DOMException('injected clone failure', 'DataCloneError');
    this.messages.push(message);
  }

  respond(id) {
    this.onmessage?.({
      data: { id, bitmap: new FakeBitmap(), width: 4, height: 4 },
    });
  }

  terminate() {
    this.terminateCount += 1;
  }
}

globalThis.Worker = FakeWorker;
globalThis.document = { body: { dataset: {} } };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, watch: { ignored: () => true } },
});

try {
  const scheduler = await server.ssrLoadModule('/src/engine/layers/uvLayerCompositeWorker.ts');
  const firstSource = new FakeBitmap();
  const replacedSource = new FakeBitmap();
  const latestSource = new FakeBitmap();
  const first = scheduler.compositeUvLayersInWorker([{ bitmap: firstSource, opacity: 1 }]);
  const replaced = scheduler
    .compositeUvLayersInWorker([{ bitmap: replacedSource, opacity: 1 }])
    .catch((error) => error);
  const latest = scheduler.compositeUvLayersInWorker([{ bitmap: latestSource, opacity: 1 }]);

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

  const active = scheduler.compositeUvLayersInWorker(
    [{ bitmap: new FakeBitmap(), opacity: 1 }],
    'active-owner',
  );
  const cancelledSource = new FakeBitmap();
  const cancelled = scheduler
    .compositeUvLayersInWorker([{ bitmap: cancelledSource, opacity: 1 }], 'cancelled-owner')
    .catch((error) => error);
  scheduler.cancelUvLayerCompositions('cancelled-owner');
  assert.equal((await cancelled).name, 'AbortError');
  assert.equal(cancelledSource.closeCount, 1, 'Cancelled queued bitmaps must be released.');
  assert.equal(FakeWorker.instance.terminateCount, 0, 'Cancelling queued work must keep the worker.');
  FakeWorker.instance.respond(4);
  await active;
  assert.equal(globalThis.document.body.dataset.uvCompositeQueueDepth, '0');
  assert.equal(globalThis.document.body.dataset.uvCompositeCancelledCount, '1');

  // A synchronous dispatch failure must release the active slot and owned inputs.
  FakeWorker.failDispatch = true;
  const failedSource = new FakeBitmap();
  await assert.rejects(scheduler.compositeUvLayersInWorker([{ bitmap: failedSource, opacity: 1 }]),
    { name: 'DataCloneError' });
  assert.equal(failedSource.closeCount, 1);
  assert.equal(globalThis.document.body.dataset.uvCompositeQueueDepth, '0');
  FakeWorker.failDispatch = false;
  const recovered = scheduler.compositeUvLayersInWorker([]);
  FakeWorker.instance.respond(FakeWorker.instance.messages.at(-1).id);
  await recovered;

  // Failure while advancing an existing queue must not strand another owner.
  const running = scheduler.compositeUvLayersInWorker([]);
  const rejectedSource = new FakeBitmap();
  const rejected = scheduler.compositeUvLayersInWorker([{ bitmap: rejectedSource, opacity: 1 }], 'bad')
    .catch(error => error);
  const surviving = scheduler.compositeUvLayersInWorker([], 'surviving');
  const activeWorker = FakeWorker.instance;
  FakeWorker.failDispatch = true;
  activeWorker.respond(activeWorker.messages.at(-1).id);
  FakeWorker.failDispatch = false;
  await running;
  assert.equal((await rejected).name, 'DataCloneError');
  assert.equal(rejectedSource.closeCount, 1);
  await Promise.resolve();
  FakeWorker.instance.respond(FakeWorker.instance.messages.at(-1).id);
  await surviving;

  // A crashed worker is recreated; construction failure also releases the slot.
  const crash = scheduler.compositeUvLayersInWorker([]).catch(error => error);
  FakeWorker.instance.onerror({ message: 'injected crash' });
  assert.match((await crash).message, /injected crash/);
  FakeWorker.failConstruction = true;
  const constructorSource = new FakeBitmap();
  await assert.rejects(scheduler.compositeUvLayersInWorker([{ bitmap: constructorSource, opacity: 1 }]),
    /construction failure/);
  assert.equal(constructorSource.closeCount, 1);
  assert.equal(globalThis.document.body.dataset.uvCompositeQueueDepth, '0');
  FakeWorker.failConstruction = false;
  const afterConstruction = scheduler.compositeUvLayersInWorker([]);
  FakeWorker.instance.respond(FakeWorker.instance.messages.at(-1).id);
  await afterConstruction;
  assert.equal(globalThis.document.body.dataset.uvCompositeQueueDepth, '0');
  globalThis.console.log('UV composition backpressure regression test passed.');
} finally {
  await server.close();
}
