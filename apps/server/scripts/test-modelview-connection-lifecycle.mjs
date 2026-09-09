/* global AbortController, Buffer, console, URL */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

// Exercise the actual compiled private function, without real credentials or
// generation requests. The integration smoke separately uses real HTTP sockets.
const source = await readFile(new URL('../dist/services/modelviewInpaintService.js', import.meta.url), 'utf8');
const start = source.indexOf('function requestModelview(');
const end = source.indexOf('function responseErrorMessage(', start);
assert(start >= 0 && end > start);
const createRequest = new Function(
  'http', 'https', 'serviceUrl', 'serviceTrust', 'maxLocalAssetBytes', 'setTimeout', 'clearTimeout',
  `${source.slice(start, end)}; return requestModelview;`,
);

function fixture(protocol, reusedSocket = false, signal) {
  const timers = new Map();
  const socket = new EventEmitter();
  const request = new EventEmitter();
  request.reusedSocket = reusedSocket;
  request.destroy = (error) => request.emit('error', error);
  request.end = () => request.emit('socket', socket);
  let respond;
  const transport = {
    request(_url, options, callback) {
      if (protocol === 'https:') assert.equal(options.rejectUnauthorized, true);
      respond = callback;
      return request;
    },
  };
  const run = createRequest(
    transport, transport, () => new URL(`${protocol}//modelview.test/`), () => ['test-ca'], 1024,
    (callback, ms) => { const id = {}; timers.set(id, { callback, ms }); return id; },
    (id) => timers.delete(id),
  );
  const promise = run(Buffer.from('test'), 'boundary', 'id', { timeoutMs: 20_000, label: 'ModelView' }, signal);
  // Attach a handler before synchronously simulating errors.
  promise.catch(() => {});
  return {
    promise, socket, request,
    deadlines: () => [...timers.values()].map((timer) => timer.ms).sort((a, b) => a - b),
    fire(ms) {
      const timer = [...timers.values()].find((item) => item.ms === ms);
      assert(timer, `Missing ${ms}ms deadline`);
      timer.callback();
    },
    success() {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      respond(response);
      response.emit('data', Buffer.from('png'));
      response.emit('end');
    },
  };
}

let checks = 0;
for (const protocol of ['http:', 'https:']) {
  const connected = protocol === 'https:' ? 'secureConnect' : 'connect';
  {
    const f = fixture(protocol, true);
    assert.deepEqual(f.deadlines(), [20_000]);
    assert.equal(f.socket.listenerCount(connected), 0);
    f.success();
    assert.equal((await f.promise).body.toString(), 'png');
    assert.deepEqual(f.deadlines(), []);
    checks++;
  }
  {
    const f = fixture(protocol);
    assert.deepEqual(f.deadlines(), [10_000, 20_000]);
    if (protocol === 'https:') {
      f.socket.emit('connect');
      assert.deepEqual(f.deadlines(), [10_000, 20_000], 'TCP alone must not finish TLS handshake.');
    }
    f.fire(10_000);
    await assert.rejects(f.promise, /连接ModelView服务超过 10 秒/);
    assert.equal(f.socket.listenerCount(connected), 0);
    assert.deepEqual(f.deadlines(), []);
    checks++;
  }
  {
    const f = fixture(protocol);
    f.socket.emit(connected);
    assert.deepEqual(f.deadlines(), [20_000]);
    f.success();
    await f.promise;
    assert.deepEqual(f.deadlines(), []);
    checks++;
  }
  for (const reused of [false, true]) {
    const f = fixture(protocol, reused);
    f.fire(20_000);
    await assert.rejects(f.promise, /等待超过 20 秒/);
    assert.deepEqual(f.deadlines(), []);
    assert.equal(f.socket.listenerCount(connected), 0);
    checks++;
    const controller = new AbortController();
    const cancelled = fixture(protocol, reused, controller.signal);
    controller.abort();
    await assert.rejects(cancelled.promise, /请求已取消/);
    assert.deepEqual(cancelled.deadlines(), []);
    assert.equal(cancelled.socket.listenerCount(connected), 0);
    checks++;
  }
  {
    const controller = new AbortController();
    controller.abort();
    const f = fixture(protocol, false, controller.signal);
    await assert.rejects(f.promise, /请求已取消/);
    f.request.emit('socket', f.socket);
    assert.deepEqual(f.deadlines(), [], 'Late socket assignment must not arm a timer after cancellation.');
    assert.equal(f.socket.listenerCount(connected), 0);
    checks++;
  }
}
console.log(`ModelView connection lifecycle passed: ${checks} HTTP/HTTPS deadline, reuse and cancellation checks.`);
