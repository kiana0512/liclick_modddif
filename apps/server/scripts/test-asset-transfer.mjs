/* global console, process, URL, Buffer, fetch, setTimeout, performance */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const workspace = path.join(os.tmpdir(), `li3d-asset-transfer-${process.pid}-${randomUUID()}`);
const objects = new Map();
let mode = 'native';
let reads = 0;
let heads = 0;
// WHATWG Fetch blocks these ports before any network request is made. Windows
// can still hand one of them out for listen(0), which made this regression
// fail nondeterministically even though the signed-transfer code was correct.
const fetchForbiddenPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

const handler = async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.match(url.searchParams.get('X-Amz-Signature') ?? '', /^[a-f0-9]{64}$/);
  if (request.method === 'PUT') {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const checksum = createHash('sha256').update(body).digest('base64');
    assert.equal(request.headers['x-amz-checksum-sha256'], checksum);
    objects.set(url.pathname, {
      body,
      contentType: request.headers['content-type'],
      checksum,
    });
    response.writeHead(200, {
      'access-control-allow-origin': '*',
      'x-amz-checksum-sha256': checksum,
    });
    response.end();
    return;
  }
  if (request.method === 'DELETE') {
    objects.delete(url.pathname);
    response.writeHead(204, { 'access-control-allow-origin': '*' });
    response.end();
    return;
  }
  const object = objects.get(url.pathname);
  if (!object) {
    response.writeHead(404);
    response.end();
    return;
  }
  const headers = {
    'content-type': object.contentType,
    'content-length': String(object.body.length),
    ...(mode === 'native' ? { 'x-amz-checksum-sha256': object.checksum } : {}),
    etag: '"opaque-object-version"',
    'access-control-allow-origin': '*',
  };
  if (request.method === 'HEAD') {
    heads++;
    assert.equal(request.headers.host, `127.0.0.1:${internalStorage.address().port}`);
    assert.equal(request.headers['x-amz-checksum-mode'], 'ENABLED');
    response.writeHead(200, headers);
    response.end();
    return;
  }
  if (request.method === 'GET') {
    reads++;
    if (mode !== 'native' && mode !== 'proxy-wrong-mime') assert.equal(request.headers['if-match'], '"opaque-object-version"');
    if (mode === 'unavailable') { response.writeHead(503); response.end(); return; }
    if (mode === 'changed') { response.writeHead(412); response.end(); return; }
    if (mode === 'timeout') { return; }
    if (mode === 'wrong-mime' || mode === 'proxy-wrong-mime') headers['content-type'] = 'text/plain';
    response.writeHead(200, headers);
    if (mode === 'truncated') { response.flushHeaders(); response.write(object.body.subarray(0, 1)); setTimeout(() => response.destroy(), 10); return; }
    // Deliver independently scheduled chunks through actual HTTP, not a mocked fetch.
    const bytes = mode === 'corrupt' ? Buffer.alloc(object.body.length, 42) : object.body;
    response.write(bytes.subarray(0, 3));
    setTimeout(() => response.end(bytes.subarray(3)), 10);
    return;
  }
  response.writeHead(405);
  response.end();
};
const objectStorage = createServer(handler);
const internalStorage = createServer(handler);
let appServer;
await new Promise((resolve) => internalStorage.listen(0, '127.0.0.1', resolve));

let address;
for (let attempt = 0; attempt < 10; attempt += 1) {
  await new Promise((resolve) => objectStorage.listen(0, '127.0.0.1', resolve));
  address = objectStorage.address();
  assert.ok(address && typeof address === 'object');
  if (!fetchForbiddenPorts.has(address.port)) break;
  await new Promise((resolve, reject) => objectStorage.close((error) => (error ? reject(error) : resolve())));
  address = undefined;
}
assert.ok(address && typeof address === 'object', 'Unable to reserve a Fetch-compatible test port.');

try {
  process.env.LICLICK_WORKSPACE_DIR = workspace;
  process.env.LICLICK_PUBLIC_WORKSPACE_URL = 'https://cloud.example.test';
  process.env.LICLICK_RUNTIME_MODE = 'cloud';
  process.env.LICLICK_OBJECT_STORAGE_ENDPOINT = `http://127.0.0.1:${address.port}`;
  process.env.LICLICK_OBJECT_STORAGE_INTERNAL_ENDPOINT = `http://127.0.0.1:${internalStorage.address().port}`;
  process.env.LICLICK_OBJECT_STORAGE_REGION = 'test-region-1';
  process.env.LICLICK_OBJECT_STORAGE_BUCKET = 'liclick-test';
  process.env.LICLICK_OBJECT_STORAGE_ACCESS_KEY_ID = 'test-access-key';
  process.env.LICLICK_OBJECT_STORAGE_SECRET_ACCESS_KEY = 'test-secret-key';

  const { createProject } = await import('../dist/services/projectFileService.js');
  const {
    completeAssetUploadIntent,
    createAssetDownloadUrl,
    createInternalAssetDownload,
    createAssetUploadIntent,
    deleteObjectStorageObject,
  } = await import('../dist/services/assetTransferService.js');

  const userId = 'asset-transfer-test-user';
  const { upsertUser, createSession } = await import('../dist/auth/sessionService.js');
  const { handleAssetsRoute } = await import('../dist/routes/assets.js');
  await upsertUser({ id: userId, displayName: 'Asset reader', authSource: 'feishu-oauth' });
  appServer = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    if (requestUrl.pathname === '/login') {
      await createSession(userId, 'feishu-oauth', request, response);
      response.writeHead(200);
      response.end();
      return;
    }
    try {
      if (!await handleAssetsRoute(request, response, requestUrl)) {
        response.writeHead(404);
        response.end();
      }
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
  const appBase = `http://127.0.0.1:${appServer.address().port}`;
  const created = await createProject(userId, { name: 'Direct upload' });
  const body = Buffer.from('browser-uploaded-texture-bytes');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const intent = await createAssetUploadIntent(userId, created.project.id, {
    protocolVersion: 1,
    category: 'layers',
    filename: 'paint.png',
    mimeType: 'image/png',
    sizeBytes: body.length,
    sha256,
  });
  assert.ok(intent);
  assert.equal(intent.upload.method, 'PUT');
  assert.equal(new URL(intent.upload.url).origin, `http://127.0.0.1:${address.port}`);

  const uploadResponse = await fetch(intent.upload.url, {
    method: intent.upload.method,
    headers: intent.upload.headers,
    body,
  });
  assert.equal(uploadResponse.status, 200);

  const completion = await completeAssetUploadIntent(
    userId,
    created.project.id,
    intent.intentId,
    { protocolVersion: 1, assetId: intent.assetId, sha256 },
  );
  assert.equal(completion.replayed, false);
  assert.equal(completion.asset.relativePath, `objects/${intent.assetId}`);
  assert.match(completion.asset.url, /\/api\/projects\/.+\/assets\/.+\/content$/);

  const replay = await completeAssetUploadIntent(
    userId,
    created.project.id,
    intent.intentId,
    { protocolVersion: 1, assetId: intent.assetId, sha256 },
  );
  assert.equal(replay.replayed, true);

  const downloadUrl = await createAssetDownloadUrl(userId, created.project.id, intent.assetId);
  assert.ok(downloadUrl);
  const downloaded = Buffer.from(await (await fetch(downloadUrl)).arrayBuffer());
  assert.deepEqual(downloaded, body);
  const internalDownload = await createInternalAssetDownload(userId, created.project.id, intent.assetId);
  assert.equal(new URL(internalDownload.url).origin, `http://127.0.0.1:${internalStorage.address().port}`);
  assert.equal(internalDownload.mimeType, 'image/png');
  assert.equal(internalDownload.sizeBytes, body.length);
  assert.deepEqual(Buffer.from(await (await fetch(internalDownload.url)).arrayBuffer()), body);
  assert.equal(await createInternalAssetDownload('different-user', created.project.id, intent.assetId), undefined);
  const login = await fetch(`${appBase}/login`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const proxyPath = `/api/projects/${created.project.id}/assets/${intent.assetId}/content?proxy=1`;
  assert.equal((await fetch(`${appBase}${proxyPath}`)).status, 401);
  const proxied = await fetch(`${appBase}${proxyPath}`, { headers: { cookie } });
  assert.equal(proxied.status, 200);
  assert.equal(proxied.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await proxied.arrayBuffer()), body);
  mode = 'proxy-wrong-mime';
  assert.equal((await fetch(`${appBase}${proxyPath}`, { headers: { cookie } })).status, 502);
  mode = 'native';
  assert.equal(
    await createAssetDownloadUrl('different-user', created.project.id, intent.assetId),
    undefined,
  );
  await deleteObjectStorageObject(
    decodeURIComponent(new URL(downloadUrl).pathname.split('/liclick-test/')[1]),
  );
  assert.equal((await fetch(downloadUrl)).status, 404);
  await deleteObjectStorageObject(
    decodeURIComponent(new URL(downloadUrl).pathname.split('/liclick-test/')[1]),
  );

  assert.equal(heads, 1);
  assert.equal(reads, 4); // Public, internal, proxied and rejected metadata; native verification uses no GET.
  const makeIntent = async () => {
    const next = await createAssetUploadIntent(userId, created.project.id, {
      protocolVersion: 1, category: 'layers', filename: 'ceph.png', mimeType: 'image/png',
      sizeBytes: body.length, sha256,
    });
    assert.equal((await fetch(next.upload.url, { method: 'PUT', headers: next.upload.headers, body })).status, 200);
    return next;
  };
  const complete = (next, who = userId, hash = sha256) => completeAssetUploadIntent(
    who, created.project.id, next.intentId, { protocolVersion: 1, assetId: next.assetId, sha256: hash },
  );
  mode = 'ceph';
  const ceph = await makeIntent();
  const readBefore = reads;
  await Promise.all(Array.from({ length: 8 }, () => complete(ceph)));
  assert.equal(reads, readBefore + 1, 'Concurrent completion must share readback');
  assert.equal((await complete(ceph)).replayed, true);
  assert.equal(reads, readBefore + 1, 'Verified replay must not re-read');
  await assert.rejects(complete(ceph, 'other-user'), { code: 'ASSET_INTENT_NOT_FOUND' });
  await assert.rejects(complete(ceph, userId, '0'.repeat(64)), { code: 'ASSET_CHECKSUM_MISMATCH' });
  for (const [failure, code] of [
    ['corrupt', 'ASSET_CHECKSUM_MISMATCH'], ['wrong-mime', 'ASSET_METADATA_MISMATCH'],
    ['unavailable', 'ASSET_OBJECT_NOT_READY'], ['changed', 'ASSET_OBJECT_NOT_READY'],
    ['truncated', 'ASSET_VERIFICATION_UNAVAILABLE'],
  ]) {
    const next = await makeIntent(); mode = failure;
    await assert.rejects(complete(next), { code });
    assert.equal(await createAssetDownloadUrl(userId, created.project.id, next.assetId), undefined);
    mode = 'ceph';
    await complete(next); // A failed verification remains retryable, not verified/cached.
  }
  mode = 'native';
  const badNative = await makeIntent();
  objects.get(new URL(badNative.upload.url).pathname).checksum = 'wrong';
  const beforeMismatch = reads;
  await assert.rejects(complete(badNative), { code: 'ASSET_CHECKSUM_MISMATCH' });
  assert.equal(reads, beforeMismatch, 'Explicit checksum mismatch must not fall back');

  const { createObjectIntegrityVerifier } = await import('../dist/services/objectIntegrityService.js');
  const verify = createObjectIntegrityVerifier({ concurrency: 1, maxQueued: 1, timeoutMs: 150 });
  const probe = { sizeBytes: body.length, mimeType: 'image/png', sha256,
    url: () => badNative.upload.url.replace(String(address.port), String(internalStorage.address().port)) };
  mode = 'timeout';
  const timeout1 = assert.rejects(verify(probe), { code: 'ASSET_VERIFICATION_TIMEOUT' });
  const timeout2 = assert.rejects(verify(probe), { code: 'ASSET_VERIFICATION_TIMEOUT' });
  await assert.rejects(verify(probe), { code: 'ASSET_VERIFICATION_BUSY' });
  await Promise.all([timeout1, timeout2]);
  mode = 'ceph';
  await verify(probe); // Timed-out streams and queued callers release their permits.
  await assert.rejects(verify({ ...probe, sizeBytes: 161 * 1024 * 1024 }), { code: 'ASSET_METADATA_MISMATCH' });
  const largeBody = Buffer.alloc(16 * 1024 * 1024, 137);
  const largeHash = createHash('sha256').update(largeBody).digest('hex');
  const large = await createAssetUploadIntent(userId, created.project.id, {
    protocolVersion: 1, category: 'models', filename: 'model.glb', mimeType: 'model/gltf-binary',
    sizeBytes: largeBody.length, sha256: largeHash,
  });
  await fetch(large.upload.url, { method: 'PUT', headers: large.upload.headers, body: largeBody });
  const started = performance.now();
  await complete(large, userId, largeHash);
  console.log('16 MiB HTTP readback verified in', Math.round(performance.now() - started), 'ms (local fixture, not Ceph latency)');
  console.log('direct asset transfer and Ceph readback tests passed');
} finally {
  if (appServer) {
    appServer.closeAllConnections();
    await new Promise((resolve) => appServer.close(resolve));
  }
  internalStorage.closeAllConnections();
  await new Promise((resolve) => internalStorage.close(resolve));
  objectStorage.closeAllConnections();
  await new Promise((resolve) => objectStorage.close(resolve));
  await fs.rm(workspace, { recursive: true, force: true });
}
