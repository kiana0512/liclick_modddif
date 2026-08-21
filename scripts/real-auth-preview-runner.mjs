/* global process */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

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

// Offline binary FBX fixture compressed from the Three.js MIT-licensed vCube example.
// Pinned source: https://github.com/mrdoob/three.js/blob/95507a65523de8819d88630ae99aa4af79764aab/examples/models/fbx/vCube.fbx
// It is intentionally parsed again by the browser after delivery, so a metadata-only
// response cannot satisfy the acceptance flow.
const simulatedLowFbx = gunzipSync(
  Buffer.from(
    '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',
    'base64',
  ),
);
const simulatedLowBlend = Buffer.from('BLENDER-v400-LICLICK-PREVIEW-LOW-MODEL\n');

function createAssetServiceSimulator({ cert, key, statePath, initialState }) {
  const jobs = new Map(initialState.jobs ?? []);
  const jobsByIdempotencyKey = new Map(initialState.idempotencyKeys ?? []);
  const artifactBytes = new Map([
    ['final-fbx', simulatedLowFbx],
    ['final-blend', simulatedLowBlend],
  ]);
  const artifact = (origin, jobId, id, filename, contentType) => {
    const body = artifactBytes.get(id);
    assert.ok(body);
    return {
      artifact_id: id,
      filename,
      kind: id === 'final-fbx' ? 'retopology_final_fbx' : 'retopology_final_blend',
      role: 'final_delivery',
      content_type: contentType,
      size_bytes: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
      download_url: `${origin}/api/v1/assets/jobs/${encodeURIComponent(jobId)}/artifacts/${id}`,
    };
  };
  const sendJson = (response, statusCode, payload) => {
    const body = Buffer.from(JSON.stringify(payload));
    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.byteLength),
    });
    response.end(body);
  };
  const persistState = () =>
    writeFile(
      statePath,
      `${JSON.stringify({ jobs: [...jobs], idempotencyKeys: [...jobsByIdempotencyKey] }, null, 2)}\n`,
    );
  return createHttpsServer({ cert, key }, async (request, response) => {
    const url = new URL(request.url ?? '/', `https://${request.headers.host}`);
    if (request.headers.authorization !== 'Bearer liclick-preview-asset-token') {
      sendJson(response, 401, {
        error: { code: 'UNAUTHORIZED', summary: 'Bearer token required.' },
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/assets/capacity') {
      sendJson(response, 200, {
        schema_version: '4.0',
        advisory: true,
        online_workers: 1,
        total_slots: 1,
        used_slots: 0,
        available_slots: 1,
        as_of: new Date().toISOString(),
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/assets/retopology/process') {
      let uploadedBytes = 0;
      for await (const chunk of request) uploadedBytes += Buffer.byteLength(chunk);
      if (uploadedBytes <= 0) {
        sendJson(response, 400, {
          error: { code: 'EMPTY_UPLOAD', summary: 'Project upload is empty.' },
        });
        return;
      }
      const idempotencyKey = request.headers['idempotency-key']?.toString();
      if (!idempotencyKey) {
        sendJson(response, 400, {
          error: { code: 'IDEMPOTENCY_REQUIRED', summary: 'Idempotency key required.' },
        });
        return;
      }
      let jobId = jobsByIdempotencyKey.get(idempotencyKey);
      if (!jobId) {
        jobId = `retopology-preview-${randomUUID()}`;
        jobsByIdempotencyKey.set(idempotencyKey, jobId);
        jobs.set(jobId, { cancelled: false, readyAt: Date.now() + 5_000 });
        await persistState();
      }
      sendJson(response, 202, {
        job_id: jobId,
        job_type: 'RETOPOLOGY_PROCESS_V2',
        status: 'QUEUED',
        status_url: `/api/v1/assets/jobs/${jobId}`,
        events_url: `/api/v1/assets/jobs/${jobId}/events`,
        cancel_url: `/api/v1/assets/jobs/${jobId}/cancel`,
      });
      return;
    }
    const jobMatch = /^\/api\/v1\/assets\/jobs\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1]);
      const job = jobs.get(jobId);
      if (!job) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', summary: 'Job not found.' } });
        return;
      }
      const status = job.cancelled
        ? 'CANCELLED'
        : Date.now() >= job.readyAt
          ? 'SUCCEEDED'
          : 'RUNNING';
      const origin = `https://${request.headers.host}`;
      const artifacts = [
        artifact(
          origin,
          jobId,
          'final-fbx',
          'liclick_preview_game_low.fbx',
          'application/octet-stream',
        ),
        artifact(
          origin,
          jobId,
          'final-blend',
          'liclick_preview_game_low.blend',
          'application/octet-stream',
        ),
      ];
      sendJson(response, 200, {
        job_id: jobId,
        job_type: 'RETOPOLOGY_PROCESS_V2',
        status,
        progress: status === 'SUCCEEDED' ? 100 : status === 'RUNNING' ? 58 : 0,
        stage: status === 'SUCCEEDED' ? 'DELIVERY_READY' : 'AUTO_RETOPOLOGY',
        stage_message:
          status === 'SUCCEEDED'
            ? '正式低模已通过模拟质量门禁。'
            : '云端 Worker 正在分析高模并构建低模。',
        delivery_ready: status === 'SUCCEEDED',
        artifacts_role: 'final_delivery',
        artifacts: status === 'SUCCEEDED' ? artifacts : [],
        result:
          status === 'SUCCEEDED'
            ? {
                delivery_ready: true,
                artifacts_role: 'final_delivery',
                artifacts,
                qa: { manifold: true, triangle_count: 12, source: 'https-preview-simulator' },
              }
            : undefined,
      });
      return;
    }
    const cancelMatch = /^\/api\/v1\/assets\/jobs\/([^/]+)\/cancel$/.exec(url.pathname);
    if (request.method === 'POST' && cancelMatch) {
      const jobId = decodeURIComponent(cancelMatch[1]);
      const job = jobs.get(jobId);
      if (!job) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', summary: 'Job not found.' } });
        return;
      }
      job.cancelled = true;
      await persistState();
      sendJson(response, 200, { job_id: jobId, status: 'CANCELLED', progress: 0 });
      return;
    }
    const artifactMatch = /^\/api\/v1\/assets\/jobs\/([^/]+)\/artifacts\/([^/]+)$/.exec(
      url.pathname,
    );
    if (request.method === 'GET' && artifactMatch) {
      const jobId = decodeURIComponent(artifactMatch[1]);
      const artifactId = decodeURIComponent(artifactMatch[2]);
      const job = jobs.get(jobId);
      const body = artifactBytes.get(artifactId);
      if (!job || !body) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', summary: 'Artifact not found.' } });
        return;
      }
      const sha256 = createHash('sha256').update(body).digest('hex');
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(body.byteLength),
        'x-artifact-sha256': sha256,
      });
      response.end(body);
      return;
    }
    sendJson(response, 404, { error: { code: 'NOT_FOUND', summary: 'Route not found.' } });
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

let assetService;
const assetSimulatorCertPath = process.env.LICLICK_ASSET_SIMULATOR_CERT_PATH;
const assetSimulatorKeyPath = process.env.LICLICK_ASSET_SIMULATOR_KEY_PATH;
if (assetSimulatorCertPath && assetSimulatorKeyPath) {
  const [cert, key] = await Promise.all([
    readFile(path.resolve(assetSimulatorCertPath)),
    readFile(path.resolve(assetSimulatorKeyPath)),
  ]);
  const assetStatePath = path.join(workspaceDir, 'asset-service-simulator-state.json');
  let assetInitialState = {};
  try {
    assetInitialState = JSON.parse(await readFile(assetStatePath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  assetService = createAssetServiceSimulator({
    cert,
    key,
    statePath: assetStatePath,
    initialState: assetInitialState,
  });
  await listen(assetService);
  const assetAddress = assetService.address();
  assert.ok(assetAddress && typeof assetAddress === 'object');
  process.env.ASSET_SERVICE_BASE_URL = `https://127.0.0.1:${assetAddress.port}`;
  console.log(
    `[preview-asset] Strict-TLS retopology simulator: ${process.env.ASSET_SERVICE_BASE_URL}`,
  );
}

const shutdown = () => {
  objectStorage.closeAllConnections();
  assetService?.closeAllConnections();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await import(pathToFileURL(path.resolve(serverEntry)).href);
