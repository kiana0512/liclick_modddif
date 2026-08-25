/* global console, process */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const workspace = path.join(os.tmpdir(), `li3d-asset-transfer-${process.pid}-${randomUUID()}`);
const objects = new Map();

const objectStorage = createServer(async (request, response) => {
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
  const object = objects.get(url.pathname);
  if (!object) {
    response.writeHead(404);
    response.end();
    return;
  }
  const headers = {
    'content-type': object.contentType,
    'content-length': String(object.body.length),
    'x-amz-checksum-sha256': object.checksum,
    'access-control-allow-origin': '*',
  };
  if (request.method === 'HEAD') {
    assert.equal(request.headers['x-amz-checksum-mode'], 'ENABLED');
    response.writeHead(200, headers);
    response.end();
    return;
  }
  if (request.method === 'GET') {
    response.writeHead(200, headers);
    response.end(object.body);
    return;
  }
  response.writeHead(405);
  response.end();
});

await new Promise((resolve) => objectStorage.listen(0, '127.0.0.1', resolve));
const address = objectStorage.address();
assert.ok(address && typeof address === 'object');

try {
  process.env.LICLICK_WORKSPACE_DIR = workspace;
  process.env.LICLICK_PUBLIC_WORKSPACE_URL = 'https://cloud.example.test';
  process.env.LICLICK_RUNTIME_MODE = 'cloud';
  process.env.LICLICK_OBJECT_STORAGE_ENDPOINT = `http://127.0.0.1:${address.port}`;
  process.env.LICLICK_OBJECT_STORAGE_REGION = 'test-region-1';
  process.env.LICLICK_OBJECT_STORAGE_BUCKET = 'liclick-test';
  process.env.LICLICK_OBJECT_STORAGE_ACCESS_KEY_ID = 'test-access-key';
  process.env.LICLICK_OBJECT_STORAGE_SECRET_ACCESS_KEY = 'test-secret-key';

  const { createProject } = await import('../dist/services/projectFileService.js');
  const {
    completeAssetUploadIntent,
    createAssetDownloadUrl,
    createAssetUploadIntent,
  } = await import('../dist/services/assetTransferService.js');

  const userId = 'asset-transfer-test-user';
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
  assert.equal(
    await createAssetDownloadUrl('different-user', created.project.id, intent.assetId),
    undefined,
  );

  console.log('direct asset transfer tests passed');
} finally {
  objectStorage.closeAllConnections();
  await new Promise((resolve) => objectStorage.close(resolve));
  await fs.rm(workspace, { recursive: true, force: true });
}
