/* global console, process */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const workspace = path.join(os.tmpdir(), `li3d-cloud-simulation-${process.pid}-${randomUUID()}`);
const publicPath = '/li3d';
const simulatedWebOrigin = 'https://web.simulated.liclick.invalid';
const objects = new Map();
let failNextPut = true;

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}.`));
    });
  });
}

async function buildCloudArtifacts() {
  if (process.argv.includes('--skip-build')) return;
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error('pnpm CLI path is unavailable. Run this simulator with pnpm.');
  await run(process.execPath, [pnpmCli, '--filter', '@liclick/server', 'build']);
  await run(process.execPath, [pnpmCli, '--filter', '@liclick/web', 'build'], {
    VITE_LICLICK_RUNTIME_MODE: 'cloud',
    VITE_PUBLIC_PATH: publicPath,
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function createObjectStorageSimulator() {
  return createServer(async (request, response) => {
    const origin = request.headers.origin ?? '*';
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET,HEAD,PUT,OPTIONS',
        'access-control-allow-headers':
          'content-type,x-amz-checksum-sha256,x-amz-meta-liclick-sha256,x-amz-checksum-mode',
      });
      response.end();
      return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.match(url.searchParams.get('X-Amz-Signature') ?? '', /^[a-f0-9]{64}$/);
    const cors = { 'access-control-allow-origin': origin };
    if (request.method === 'PUT') {
      if (failNextPut) {
        failNextPut = false;
        response.writeHead(503, cors);
        response.end('simulated transient object-storage failure');
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const checksum = createHash('sha256').update(body).digest('base64');
      if (request.headers['x-amz-checksum-sha256'] !== checksum) {
        response.writeHead(400, cors);
        response.end('checksum mismatch');
        return;
      }
      objects.set(url.pathname, {
        body,
        checksum,
        contentType: request.headers['content-type'] ?? 'application/octet-stream',
      });
      response.writeHead(200, { ...cors, 'x-amz-checksum-sha256': checksum });
      response.end();
      return;
    }
    const object = objects.get(url.pathname);
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
    } else if (request.method === 'GET') {
      response.writeHead(200, headers);
      response.end(object.body);
    } else {
      response.writeHead(405, cors);
      response.end();
    }
  });
}

function startCloudServer(port, objectStorageEndpoint) {
  const publicUrl = `http://127.0.0.1:${port}${publicPath}`;
  const child = spawn(process.execPath, [path.join(repoRoot, 'apps/server/dist/index.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SERVER_HOST: '127.0.0.1',
      SERVER_PORT: String(port),
      LICLICK_RUNTIME_MODE: 'cloud',
      LICLICK_WORKSPACE_DIR: workspace,
      LICLICK_PUBLIC_PATH: publicPath,
      LICLICK_PUBLIC_WORKSPACE_URL: publicUrl,
      LICLICK_FRONTEND_URL: publicUrl,
      LICLICK_SERVE_WEB: 'true',
      LICLICK_WEB_DIST_DIR: path.join(repoRoot, 'apps/web/dist'),
      LICLICK_ALLOWED_ORIGINS: simulatedWebOrigin,
      LICLICK_ENABLE_ATLAS_LOCAL_LOGIN: 'false',
      AUTH_MODE: 'dev-mock',
      SESSION_SECRET: 'simulated-cloud-session-secret-only-for-tests',
      SESSION_COOKIE_SECURE: 'false',
      LICLICK_OBJECT_STORAGE_ENDPOINT: objectStorageEndpoint,
      LICLICK_OBJECT_STORAGE_REGION: 'simulated-region-1',
      LICLICK_OBJECT_STORAGE_BUCKET: 'liclick-simulated',
      LICLICK_OBJECT_STORAGE_ACCESS_KEY_ID: 'simulated-access-key',
      LICLICK_OBJECT_STORAGE_SECRET_ACCESS_KEY: 'simulated-secret-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[cloud] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[cloud] ${chunk}`));
  return { child, publicUrl };
}

async function stopCloudServer(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
}

async function waitForHealth(publicUrl) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${publicUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Simulated Cloud server did not become healthy.');
}

async function jsonRequest(url, init = {}) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => undefined);
  return { response, payload };
}

await buildCloudArtifacts();
const objectStorage = createObjectStorageSimulator();
await listen(objectStorage);
const objectAddress = objectStorage.address();
assert.ok(objectAddress && typeof objectAddress === 'object');
const objectStorageEndpoint = `http://127.0.0.1:${objectAddress.port}`;
const cloudPort = await reservePort();
let cloud = startCloudServer(cloudPort, objectStorageEndpoint);

try {
  const health = await waitForHealth(cloud.publicUrl);
  assert.equal(health.ok, true);
  assert.equal(health.release.runtimeMode, 'cloud');

  const shell = await fetch(`${cloud.publicUrl}/`);
  assert.equal(shell.status, 200);
  const html = await shell.text();
  assert.match(html, /<div id="root"><\/div>/);
  assert.doesNotMatch(html, /Local-Component-Setup|localhost:4618/i);

  const login = await jsonRequest(`${cloud.publicUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: simulatedWebOrigin },
    body: JSON.stringify({ displayName: 'Cloud Simulator', email: 'simulator@example.test' }),
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.response.headers.get('access-control-allow-origin'), simulatedWebOrigin);
  const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const authenticatedHeaders = {
    cookie,
    origin: simulatedWebOrigin,
    'content-type': 'application/json',
  };

  const created = await jsonRequest(`${cloud.publicUrl}/api/projects`, {
    method: 'POST',
    headers: authenticatedHeaders,
    body: JSON.stringify({ name: 'Remote deployment simulation' }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.project.revision.number, 1);
  const projectId = created.payload.project.id;

  const bytes = Buffer.from('simulated-browser-direct-upload');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const intentResult = await jsonRequest(
    `${cloud.publicUrl}/api/projects/${projectId}/assets/intents`,
    {
      method: 'POST',
      headers: authenticatedHeaders,
      body: JSON.stringify({
        protocolVersion: 1,
        category: 'layers',
        filename: 'remote-paint.png',
        mimeType: 'image/png',
        sizeBytes: bytes.length,
        sha256,
      }),
    },
  );
  assert.equal(intentResult.response.status, 201);
  const intent = intentResult.payload.intent;
  assert.equal(new URL(intent.upload.url).origin, objectStorageEndpoint);

  const failedUpload = await fetch(intent.upload.url, {
    method: 'PUT',
    headers: { ...intent.upload.headers, origin: simulatedWebOrigin },
    body: bytes,
  });
  assert.equal(failedUpload.status, 503);
  const retriedUpload = await fetch(intent.upload.url, {
    method: 'PUT',
    headers: { ...intent.upload.headers, origin: simulatedWebOrigin },
    body: bytes,
  });
  assert.equal(retriedUpload.status, 200);

  const completed = await jsonRequest(
    `${cloud.publicUrl}/api/projects/${projectId}/assets/intents/${intent.intentId}/complete`,
    {
      method: 'POST',
      headers: authenticatedHeaders,
      body: JSON.stringify({ protocolVersion: 1, assetId: intent.assetId, sha256 }),
    },
  );
  assert.equal(completed.response.status, 200);
  assert.equal(completed.payload.replayed, false);
  const replayedCompletion = await jsonRequest(
    `${cloud.publicUrl}/api/projects/${projectId}/assets/intents/${intent.intentId}/complete`,
    {
      method: 'POST',
      headers: authenticatedHeaders,
      body: JSON.stringify({ protocolVersion: 1, assetId: intent.assetId, sha256 }),
    },
  );
  assert.equal(replayedCompletion.payload.replayed, true);

  const content = await fetch(completed.payload.asset.url, {
    headers: { cookie, origin: simulatedWebOrigin },
    redirect: 'manual',
  });
  assert.equal(content.status, 307);
  assert.equal(new URL(content.headers.get('location')).origin, objectStorageEndpoint);
  const resolvedContent = await jsonRequest(`${completed.payload.asset.url}?resolve=1`, {
    headers: { cookie, origin: simulatedWebOrigin },
  });
  assert.equal(resolvedContent.response.status, 200);
  assert.equal(new URL(resolvedContent.payload.downloadUrl).origin, objectStorageEndpoint);
  assert.match(resolvedContent.response.headers.get('cache-control') ?? '', /no-store/);

  const renameCommand = {
    schemaVersion: 1,
    id: 'command-simulator-rename-0001',
    projectId,
    expectedRevisionId: created.payload.project.revision.id,
    issuedAt: new Date().toISOString(),
    kind: 'rename-project',
    payload: { name: 'Recovered remote project' },
  };
  const renamed = await jsonRequest(`${cloud.publicUrl}/api/projects/${projectId}/commands`, {
    method: 'POST',
    headers: authenticatedHeaders,
    body: JSON.stringify(renameCommand),
  });
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.payload.project.revision.number, 2);
  const replayedRename = await jsonRequest(`${cloud.publicUrl}/api/projects/${projectId}/commands`, {
    method: 'POST',
    headers: authenticatedHeaders,
    body: JSON.stringify(renameCommand),
  });
  assert.equal(replayedRename.payload.command.replayed, true);
  assert.equal(replayedRename.payload.project.revision.number, 2);

  await stopCloudServer(cloud.child);
  cloud = startCloudServer(cloudPort, objectStorageEndpoint);
  await waitForHealth(cloud.publicUrl);
  const recovered = await jsonRequest(`${cloud.publicUrl}/api/projects/${projectId}`, {
    headers: { cookie, origin: simulatedWebOrigin },
  });
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.payload.project.name, 'Recovered remote project');
  assert.equal(recovered.payload.project.revision.number, 2);
  const recoveredContent = await fetch(completed.payload.asset.url, {
    headers: { cookie, origin: simulatedWebOrigin },
    redirect: 'manual',
  });
  assert.equal(recoveredContent.status, 307);

  console.log('Cloud deployment simulation passed: build, proxy path, auth, direct upload, retry, idempotency and restart recovery.');
  if (process.argv.includes('--serve')) {
    console.log(`SIMULATED_CLOUD_URL=${cloud.publicUrl}/`);
    console.log('The simulated deployment will stay available until this process is stopped.');
    await new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  }
} finally {
  await stopCloudServer(cloud.child).catch(() => undefined);
  objectStorage.closeAllConnections();
  await new Promise((resolve) => objectStorage.close(resolve));
  await fs.rm(workspace, { recursive: true, force: true });
}
