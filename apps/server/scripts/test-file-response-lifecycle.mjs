import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const streams = [];
const source = await fs.promises.readFile(new URL('../src/services/fileResponseService.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
new Function('exports', 'require', compiled)(exports, (id) => id === 'node:fs' ? {
  createReadStream(file) {
    const stream = fs.createReadStream(file);
    streams.push(stream);
    return stream;
  },
} : require(id));
const send = process.argv.includes('--baseline')
  ? (file, response) => { const stream = fs.createReadStream(file); streams.push(stream); stream.pipe(response); }
  : exports.streamFileResponse;
const httpSource = await fs.promises.readFile(new URL('../src/routes/httpUtils.ts', import.meta.url), 'utf8');
const httpExports = {};
new Function('exports', 'require', ts.transpileModule(httpSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(httpExports, (id) => id === '../config.js'
  ? { serverConfig: { allowedOrigins: [], frontendOrigin: 'http://127.0.0.1' } }
  : require(id));
const { readJsonBody, sendRequestFailure } = httpExports;
const entrySource = await fs.promises.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
assert.match(entrySource, /catch \(error\) \{\s*console\.error\('\[Liclick Workspace Server\]', error\);\s*sendRequestFailure\(response, error\);/);
const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'li3d-file-response-'));
const project = path.join(root, 'project');
await fs.promises.mkdir(project);
const large = path.join(project, 'model.glb');
const descriptor = await fs.promises.open(large, 'w');
await descriptor.truncate(16 * 1024 * 1024);
await descriptor.close();
const expected = Buffer.from('Complete image bytes, unchanged.');
await fs.promises.writeFile(path.join(project, 'image.png'), expected);
const server = http.createServer((request, response) => {
  if (request.url === '/default-body-limit') {
    void readJsonBody(request).then(() => response.end('accepted'))
      .catch(error => sendRequestFailure(response, error));
    return;
  }
  if (request.url === '/body-limit') {
    void readJsonBody(request, 8).then(body => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    }).catch(error => sendRequestFailure(response, error));
    return;
  }
  if (request.url === '/closed-before-pipe') {
    response.destroy();
    const count = streams.length;
    send(large, response);
    assert.equal(streams.length, count, 'Do not open files for an already disconnected client');
    sendRequestFailure(response, new Error('aborted'));
    return;
  }
  if (request.url === '/ended-before-pipe') {
    response.end('done');
    const count = streams.length;
    send(large, response);
    assert.equal(streams.length, count, 'Do not reopen an already completed response');
    sendRequestFailure(response, new Error('late completion'));
    return;
  }
  if (request.url === '/partial-error') {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.flushHeaders();
    response.write('partial');
    sendRequestFailure(response, new Error('read failed after headers'));
    return;
  }
  if (request.url === '/early-error') {
    sendRequestFailure(response, new Error('before headers'));
    return;
  }
  send(path.join(project, request.url === '/complete' ? 'image.png' : request.url === '/missing' ? 'missing.png' : 'model.glb'), response);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
try {
  await new Promise((resolve, reject) => {
    const request = http.get(`${base}/abort`, response => {
      response.once('data', () => { response.destroy(); request.destroy(); resolve(); });
      response.on('error', () => {});
    });
    request.on('error', reject);
  });
  const deadline = Date.now() + 1500;
  while (!streams[0].closed && Date.now() < deadline) await delay(10);
  assert(streams[0].closed, 'Cancelling HTTP must close the underlying model file descriptor');
  const response = await globalThis.fetch(`${base}/complete`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  await assert.rejects(globalThis.fetch(`${base}/missing`), 'A read failure must terminate the response without an uncaught stream error');
  await assert.rejects(globalThis.fetch(`${base}/closed-before-pipe`));
  assert.equal(await (await globalThis.fetch(`${base}/ended-before-pipe`)).text(), 'done');
  await assert.rejects(async () => {
    const partial = await globalThis.fetch(`${base}/partial-error`);
    await partial.text();
  }, 'Partial streams must terminate instead of receiving a second set of JSON headers');
  const earlyError = await globalThis.fetch(`${base}/early-error`);
  assert.equal(earlyError.status, 500);
  assert.deepEqual(await earlyError.json(), { error: 'Internal server error.' },
    'Unexpected internal details must not be returned to browsers');
  const allowedBody = await globalThis.fetch(`${base}/body-limit`, { method: 'POST', body: '{}' });
  assert.equal(allowedBody.status, 200);
  assert.deepEqual(await allowedBody.json(), {});
  const oversizedBody = await globalThis.fetch(`${base}/body-limit`, { method: 'POST', body: '{"long":true}' });
  assert.equal(oversizedBody.status, 413);
  assert.deepEqual(await oversizedBody.json(), { error: 'Request body is too large.' });
  const chunkedBody = await new Promise((resolve, reject) => {
    const request = http.request(`${base}/body-limit`, { method: 'POST', headers: { 'transfer-encoding': 'chunked' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.end('{"long":true}');
  });
  assert.equal(chunkedBody.status, 413);
  assert.deepEqual(JSON.parse(chunkedBody.body), { error: 'Request body is too large.' });
  const defaultLimit = await new Promise((resolve, reject) => {
    const request = http.request(`${base}/default-body-limit`, {
      method: 'POST', headers: { 'content-length': String(8 * 1024 * 1024 + 1) },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(defaultLimit.status, 413, 'Declared oversized JSON must be rejected before reading the body');
  assert.deepEqual(JSON.parse(defaultLimit.body), { error: 'Request body is too large.' });
  assert.deepEqual(Buffer.from(await (await globalThis.fetch(`${base}/complete`)).arrayBuffer()), expected,
    'The same HTTP server must remain available after aborted and partially sent responses');
  const trash = path.join(root, 'trash');
  assert.equal(path.dirname(project), root);
  assert.equal(path.dirname(trash), root);
  await fs.promises.rename(project, trash);
  assert.deepEqual(await fs.promises.readFile(path.join(trash, 'image.png')), expected, 'Moving to trash preserves all data');
  globalThis.console.log('HTTP lifecycle passed: aborted/partial file streams, JSON 413 limits, sanitized 500 and project-to-trash rename.');
} finally {
  streams.forEach(stream => stream.destroy());
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith('li3d-file-response-'));
  await fs.promises.rm(root, { recursive: true, force: true });
}
