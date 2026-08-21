/* global process */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function createObjectStorageSimulator(storageRoot) {
  const objects = new Map();
  const objectPaths = (pathname) => {
    const key = createHash('sha256').update(pathname).digest('hex');
    return {
      body: path.join(storageRoot, `${key}.bin`),
      metadata: path.join(storageRoot, `${key}.json`),
    };
  };
  const persistObject = async (pathname, object) => {
    await mkdir(storageRoot, { recursive: true });
    const files = objectPaths(pathname);
    await Promise.all([
      writeFile(files.body, object.body),
      writeFile(
        files.metadata,
        JSON.stringify({
          pathname,
          checksum: object.checksum,
          contentType: object.contentType,
        }),
      ),
    ]);
  };
  const loadObject = async (pathname) => {
    const cached = objects.get(pathname);
    if (cached) return cached;
    const files = objectPaths(pathname);
    try {
      const [body, encodedMetadata] = await Promise.all([
        readFile(files.body),
        readFile(files.metadata, 'utf8'),
      ]);
      const metadata = JSON.parse(encodedMetadata);
      if (metadata.pathname !== pathname) return undefined;
      const object = {
        body,
        checksum: metadata.checksum,
        contentType: metadata.contentType,
      };
      objects.set(pathname, object);
      return object;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined;
      throw error;
    }
  };
  return createServer(async (request, response) => {
    const origin = request.headers.origin ?? '*';
    const cors = { 'access-control-allow-origin': origin };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        ...cors,
        'access-control-allow-methods': 'GET,HEAD,PUT,OPTIONS',
        'access-control-allow-headers':
          'content-type,x-amz-checksum-sha256,x-amz-meta-liclick-sha256,x-amz-checksum-mode',
      });
      response.end();
      return;
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (url.pathname === '/health') {
      response.writeHead(200, { ...cors, 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, service: 'object-storage-simulator' }));
      return;
    }

    const isPresignedRequest =
      url.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256' &&
      /^[a-f0-9]{64}$/.test(url.searchParams.get('X-Amz-Signature') ?? '');
    if (!isPresignedRequest) {
      // Browsers can probe `/favicon.ico` after following an object-storage
      // redirect. Treat every unsigned object request as forbidden instead of
      // throwing from the request handler and terminating the preview server.
      response.writeHead(403, { ...cors, 'content-type': 'text/plain; charset=utf-8' });
      response.end('signed object-storage request required');
      return;
    }

    if (request.method === 'PUT') {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const checksum = createHash('sha256').update(body).digest('base64');
      if (request.headers['x-amz-checksum-sha256'] !== checksum) {
        response.writeHead(400, cors);
        response.end('checksum mismatch');
        return;
      }
      const object = {
        body,
        checksum,
        contentType: request.headers['content-type'] ?? 'application/octet-stream',
      };
      await persistObject(url.pathname, object);
      objects.set(url.pathname, object);
      response.writeHead(200, { ...cors, 'x-amz-checksum-sha256': checksum });
      response.end();
      return;
    }

    const object = await loadObject(url.pathname);
    if (!object) {
      response.writeHead(404, cors);
      response.end();
      return;
    }
    const headers = {
      ...cors,
      'content-type': object.contentType,
      'content-length': String(object.body.length),
      'x-amz-checksum-sha256': object.checksum,
    };
    if (request.method === 'HEAD') {
      response.writeHead(200, headers);
      response.end();
      return;
    }
    if (request.method === 'GET') {
      response.writeHead(200, headers);
      response.end(object.body);
      return;
    }
    response.writeHead(405, cors);
    response.end();
  });
}

const serverEntry = process.env.LICLICK_REAL_AUTH_SERVER_ENTRY;
if (!serverEntry) throw new Error('LICLICK_REAL_AUTH_SERVER_ENTRY is required.');
const workspaceDir = process.env.LICLICK_WORKSPACE_DIR;
if (!workspaceDir) throw new Error('LICLICK_WORKSPACE_DIR is required.');

const storageRoot = path.join(path.resolve(workspaceDir), 'object-storage-simulator');
await mkdir(storageRoot, { recursive: true });
const objectStorage = createObjectStorageSimulator(storageRoot);
await listen(objectStorage);
const address = objectStorage.address();
assert.ok(address && typeof address === 'object');

process.env.LICLICK_OBJECT_STORAGE_ENDPOINT = `http://127.0.0.1:${address.port}`;
process.env.LICLICK_OBJECT_STORAGE_REGION = 'real-auth-preview-1';
process.env.LICLICK_OBJECT_STORAGE_BUCKET = 'liclick-real-auth-preview';
process.env.LICLICK_OBJECT_STORAGE_ACCESS_KEY_ID = 'real-auth-preview-access-key';
process.env.LICLICK_OBJECT_STORAGE_SECRET_ACCESS_KEY = 'real-auth-preview-secret-key';

console.log(
  `[preview-storage] Server-side object-storage simulator: ${process.env.LICLICK_OBJECT_STORAGE_ENDPOINT}`,
);

const shutdown = () => objectStorage.closeAllConnections();
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await import(pathToFileURL(path.resolve(serverEntry)).href);
