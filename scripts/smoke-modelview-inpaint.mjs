import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const serverEntry = path.join(repoRoot, 'apps', 'server', 'dist', 'index.js');
const allowedOrigin = 'http://127.0.0.1:5173';
const resultPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+WnPpAAAAAElFTkSuQmCC',
  'base64',
);

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForHealth(baseUrl, child) {
  const timeoutAt = Date.now() + 15_000;
  while (Date.now() < timeoutAt) {
    if (child.exitCode !== null) {
      throw new Error(`Workspace server exited before health check (${child.exitCode}).`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: allowedOrigin },
      });
      if (response.ok) return;
    } catch {
      // Server startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the workspace server.');
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const [workspacePort, modelviewPort] = await Promise.all([reservePort(), reservePort()]);
const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'liclick-modelview-smoke-'));
const workspaceBaseUrl = `http://127.0.0.1:${workspacePort}`;
const observedRequests = [];
const modelviewMock = http.createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/v1/services/modelview-inpaint');
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const contentType = request.headers['content-type'] ?? '';
    const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
    assert(boundary, 'The proxy must send multipart/form-data with a boundary.');
    assert.match(contentType, /^multipart\/form-data;/);
    assert.match(request.headers['idempotency-key'] ?? '', /:inpaint:g1:attempt-1$/);
    const bodyText = body.toString('latin1');
    assert.match(bodyText, /name="image"; filename="input-with-mask\.png"/);
    assert.match(bodyText, /Content-Type: image\/png/);
    assert(body.includes(Buffer.from('修复纸张边缘', 'utf8')));
    assert(bodyText.endsWith(`--${boundary}--\r\n`));
    observedRequests.push({
      idempotencyKey: request.headers['idempotency-key'],
      sha256: createHash('sha256').update(body).digest('hex'),
    });
    response.writeHead(200, {
      'content-type': 'image/png',
      'x-job-id': 'mock-modelview-job-1',
      'x-client-id': 'mock-li3d-client',
    });
    response.end(resultPng);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});
await new Promise((resolve, reject) => {
  modelviewMock.once('error', reject);
  modelviewMock.listen(modelviewPort, '127.0.0.1', resolve);
});

let serverOutput = '';
const child = spawn(process.execPath, [serverEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    AUTH_MODE: 'dev-mock',
    LICLICK_ENABLE_ATLAS_LOCAL_LOGIN: 'false',
    LICLICK_FRONTEND_URL: allowedOrigin,
    LICLICK_PUBLIC_WORKSPACE_URL: workspaceBaseUrl,
    LICLICK_WORKSPACE_DIR: workspaceDir,
    LICLICK_MODELVIEW_INPAINT_URL: `http://127.0.0.1:${modelviewPort}/api/v1/services/modelview-inpaint`,
    LICLICK_MODELVIEW_INPAINT_TIMEOUT_MS: '10000',
    SERVER_HOST: '127.0.0.1',
    SERVER_PORT: String(workspacePort),
    SESSION_SECRET: 'modelview-smoke-test-secret-not-for-production',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
child.stdout.on('data', (chunk) => {
  serverOutput += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  serverOutput += chunk.toString();
});

try {
  await waitForHealth(workspaceBaseUrl, child);
  const login = await fetch(`${workspaceBaseUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: allowedOrigin },
    body: JSON.stringify({ displayName: 'ModelView Smoke', email: 'modelview@liclick.test' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  assert(cookie);

  const createProject = await fetch(`${workspaceBaseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: cookie, Origin: allowedOrigin },
    body: JSON.stringify({ name: 'ModelView inpaint smoke project' }),
  });
  assert.equal(createProject.status, 201);
  const created = await createProject.json();
  assert(created.project?.id);

  const inpaintPayload = {
    clientGenerationId: 'smoke-generation-1',
    projectId: created.project.id,
    prompt: '修复纸张边缘',
    image: {
      path: 'input-with-mask.png',
      dataUrl: `data:image/png;base64,${resultPng.toString('base64')}`,
    },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const inpaint = await fetch(`${workspaceBaseUrl}/api/modelview/inpaint`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Cookie: cookie,
        Origin: allowedOrigin,
      },
      body: JSON.stringify(inpaintPayload),
    });
    assert.equal(inpaint.status, 200);
    const result = await inpaint.json();
    assert.equal(result.modelviewJobId, 'mock-modelview-job-1');
    assert.equal(result.modelviewClientId, 'mock-li3d-client');
    assert.equal(result.output?.source, 'modelview-inpaint');
    assert.equal(result.output?.storage, 'project');
    const saved = await fetch(result.resultUrl, {
      headers: { Cookie: cookie, Origin: allowedOrigin },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(Buffer.from(await saved.arrayBuffer()), resultPng);
  }

  const recoveryResponse = await fetch(`${workspaceBaseUrl}/api/modelview/inpaint`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Cookie: cookie,
      Origin: allowedOrigin,
    },
    body: JSON.stringify({
      ...inpaintPayload,
      clientGenerationId: 'smoke-generation-recovery',
      projectId: 'missing-project',
    }),
  });
  assert.equal(recoveryResponse.status, 200);
  const recoveryResult = await recoveryResponse.json();
  assert.equal(recoveryResult.output?.storage, 'user-recovery');
  const recovered = await fetch(recoveryResult.resultUrl, {
    headers: { Cookie: cookie, Origin: allowedOrigin },
  });
  assert.equal(recovered.status, 200);
  assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), resultPng);

  assert.equal(observedRequests.length, 3);
  assert.equal(observedRequests[0].idempotencyKey, observedRequests[1].idempotencyKey);
  assert.equal(observedRequests[0].sha256, observedRequests[1].sha256);
  console.log(
    'ModelView inpaint smoke passed: multipart image/prompt, deterministic idempotency, X-Job-ID, and PNG persistence.',
  );
} catch (error) {
  if (serverOutput.trim()) console.error(serverOutput.trim());
  throw error;
} finally {
  await stopChild(child);
  await new Promise((resolve) => modelviewMock.close(resolve));
  await fs.rm(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
