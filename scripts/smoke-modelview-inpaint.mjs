/* global Buffer, console, fetch, process, setTimeout */
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
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGM4kWL0HwAFtAJeHzr7ywAAAABJRU5ErkJggg==',
  'base64',
);
const whiteMaskPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
const blackMaskPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
  'base64',
);
const mismatchedMaskPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAC0lEQVR4nGP4DwUAI+UH+Yo0eLMAAAAASUVORK5CYII=',
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
const { createModelviewIdempotencyKey } = await import('../apps/server/dist/services/modelviewIdempotency.js');
const suffixes = ['single-view:li3d4500-4step-r1', 'single-view-inpaint:li3d4500-steps2-r1', 'inpaint:refcontrol-normal-4step-r1'];
for (const suffix of suffixes) {
  for (const length of [1, 128 - suffix.length - 1, 128 - suffix.length, 104, 160, 500]) {
    const id = 'x'.repeat(length);
    const key = createModelviewIdempotencyKey(id, suffix);
    assert(key.length <= 128);
    assert.equal(key, createModelviewIdempotencyKey(id, suffix));
    if ((id + ':' + suffix).length <= 128) assert.equal(key, id + ':' + suffix);
    assert.notEqual(createModelviewIdempotencyKey(id + 'a', suffix), createModelviewIdempotencyKey(id + 'b', suffix));
  }
}
assert.notEqual(createModelviewIdempotencyKey('x'.repeat(200) + 'a', suffixes[1]), createModelviewIdempotencyKey('x'.repeat(200) + 'b', suffixes[1]));
const observedRequests = [];
let firstSocket;
const modelviewMock = http.createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    const isSingleView = request.url === '/api/v1/services/modelview-single-view';
    const isSingleViewInpaint =
      request.url === '/api/v1/services/modelview-single-view-inpaint';
    assert(
      isSingleView || isSingleViewInpaint || request.url === '/api/v1/services/modelview-inpaint',
      `Unexpected ModelView path: ${request.url}`,
    );
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const contentType = request.headers['content-type'] ?? '';
    const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
    assert(boundary, 'The proxy must send multipart/form-data with a boundary.');
    assert.match(contentType, /^multipart\/form-data;/);
    assert.match(
      request.headers['idempotency-key'] ?? '',
      isSingleView
        ? /:single-view:li3d4500-4step-r1$/
        : isSingleViewInpaint
          ? /:single-view-inpaint:li3d4500-steps2-r1$/
          : /:inpaint:refcontrol-normal-4step-r1$/,
    );
    if (String(request.headers['idempotency-key']).length > 128) {
      response.writeHead(422, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ detail: [{ loc: ['header', 'idempotency-key'], msg: 'String should have at most 128 characters' }] }));
      return;
    }
    const bodyText = body.toString('latin1');
    assert.match(
      bodyText,
      isSingleView
        ? /name="image"; filename="white-model\.png"/
        : /name="image"; filename="current-effect\.png"/,
    );
    assert.match(bodyText, /name="material_image"; filename="multiview-material-reference\.png"/);
    if (isSingleView) assert.doesNotMatch(bodyText, /name="mask"/);
    else assert.match(bodyText, /name="mask"; filename="mask\.png"/);
    if (isSingleView || isSingleViewInpaint) assert.doesNotMatch(bodyText, /name="normal_image"/);
    else {
      const normalHeader = 'Content-Disposition: form-data; name="normal_image"; filename="normal.png"\r\nContent-Type: image/png\r\n\r\n';
      const start = body.indexOf(Buffer.from(normalHeader));
      assert(start >= 0, 'normal_image must be forwarded as its own file');
      assert.deepEqual(body.subarray(start + normalHeader.length, start + normalHeader.length + blackMaskPng.length), blackMaskPng, 'Normal bytes must remain unchanged');
    }
    assert.doesNotMatch(bodyText, /name="viewport_reference"/);
    assert.doesNotMatch(bodyText, /name="seed"/);
    assert.doesNotMatch(bodyText, /name="noise_seed"/);
    assert.match(bodyText, /Content-Type: image\/png/);
    const usesPrompt = String(request.headers['idempotency-key']).startsWith('smoke-polished:');
    if (!usesPrompt) {
      assert.deepEqual([...bodyText.matchAll(/Content-Disposition: form-data; name="([^"]+)"/g)].map(match => match[1]),
        isSingleView ? ['image', 'material_image'] : isSingleViewInpaint ? ['image', 'material_image', 'mask'] : ['image', 'material_image', 'mask', 'normal_image'], 'Default workflows receive only their image fields, no prompt or parameters');
      assert.equal(body.includes(Buffer.from('修复纸张边缘')), false, 'Stale prompt must not override workflow default');
    } else assert(
      body.includes(
        Buffer.from(
          isSingleView
            ? '保持当前视角结构并迁移参考材质'
            : isSingleViewInpaint
              ? '只补全白模区域'
              : '修复纸张边缘',
          'utf8',
        ),
      ),
    );
    assert(bodyText.endsWith(`--${boundary}--\r\n`));
    observedRequests.push({
      idempotencyKey: request.headers['idempotency-key'],
      sha256: createHash('sha256').update(body).digest('hex'),
    });
    if (observedRequests.length === 1) firstSocket = request.socket;
    if (observedRequests.length === 2) {
      assert.equal(request.socket, firstSocket, 'Regression must exercise real keep-alive reuse.');
      // Longer than the connection deadline, shorter than the task deadline.
      await new Promise((resolve) => setTimeout(resolve, 11_000));
    }
    response.writeHead(200, {
      'content-type': 'image/png',
      'x-job-id': isSingleView
        ? 'mock-modelview-single-view-job-1'
        : isSingleViewInpaint
          ? 'mock-modelview-single-view-inpaint-job-1'
          : 'mock-modelview-job-1',
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
    LICLICK_MODELVIEW_INPAINT_TIMEOUT_MS: '20000',
    LICLICK_MODELVIEW_SINGLE_VIEW_URL: `http://127.0.0.1:${modelviewPort}/api/v1/services/modelview-single-view`,
    LICLICK_MODELVIEW_SINGLE_VIEW_TIMEOUT_MS: '10000',
    LICLICK_MODELVIEW_SINGLE_VIEW_INPAINT_URL: `http://127.0.0.1:${modelviewPort}/api/v1/services/modelview-single-view-inpaint`,
    LICLICK_MODELVIEW_SINGLE_VIEW_INPAINT_TIMEOUT_MS: '10000',
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
    normalImage: { path: 'normal.png', dataUrl: `data:image/png;base64,${blackMaskPng.toString('base64')}` },
    clientGenerationId: 'smoke-generation-1',
    projectId: created.project.id,
    prompt: '修复纸张边缘',
    image: {
      path: 'current-effect.png',
      dataUrl: `data:image/png;base64,${resultPng.toString('base64')}`,
    },
    materialImage: {
      path: 'multiview-material-reference.png',
      dataUrl: `data:image/png;base64,${resultPng.toString('base64')}`,
    },
    mask: {
      path: 'mask.png',
      dataUrl: `data:image/png;base64,${whiteMaskPng.toString('base64')}`,
    },
  };
  for (const normalImage of [undefined,
    { path: 'normal.png', dataUrl: `data:image/png;base64,${mismatchedMaskPng.toString('base64')}` },
    { path: 'normal.png', dataUrl: 'data:image/png;base64,aW52YWxpZA==' },
  ]) {
    const invalid = await fetch(`${workspaceBaseUrl}/api/modelview/inpaint`, {
      method: 'POST', headers: { 'content-type': 'application/json', Cookie: cookie, Origin: allowedOrigin },
      body: JSON.stringify({ ...inpaintPayload, normalImage }),
    });
    assert.equal(invalid.status, 422, await invalid.text());
    assert.equal(observedRequests.length, 0, 'Invalid normal must fail before remote submission');
  }
  const missingMaterialReference = await fetch(`${workspaceBaseUrl}/api/modelview/inpaint`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Cookie: cookie,
      Origin: allowedOrigin,
    },
    body: JSON.stringify({
      ...inpaintPayload,
      clientGenerationId: 'smoke-generation-missing-material',
      materialImage: undefined,
    }),
  });
  assert.equal(missingMaterialReference.status, 422);
  const missingMask = await fetch(`${workspaceBaseUrl}/api/modelview/inpaint`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Cookie: cookie,
      Origin: allowedOrigin,
    },
    body: JSON.stringify({
      ...inpaintPayload,
      clientGenerationId: 'smoke-generation-missing-mask',
      mask: undefined,
    }),
  });
  assert.equal(missingMask.status, 422);
  const emptyMask = await fetch(`${workspaceBaseUrl}/api/modelview/inpaint`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Cookie: cookie,
      Origin: allowedOrigin,
    },
    body: JSON.stringify({
      ...inpaintPayload,
      clientGenerationId: 'smoke-generation-empty-mask',
      mask: {
        path: 'empty-mask.png',
        dataUrl: `data:image/png;base64,${blackMaskPng.toString('base64')}`,
      },
    }),
  });
  assert.equal(emptyMask.status, 422);
  const mismatchedMask = await fetch(`${workspaceBaseUrl}/api/modelview/inpaint`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Cookie: cookie,
      Origin: allowedOrigin,
    },
    body: JSON.stringify({
      ...inpaintPayload,
      clientGenerationId: 'smoke-generation-mismatched-mask',
      mask: {
        path: 'mismatched-mask.png',
        dataUrl: `data:image/png;base64,${mismatchedMaskPng.toString('base64')}`,
      },
    }),
  });
  assert.equal(mismatchedMask.status, 422);
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
    assert.equal(result.output?.workflow, '2026.09.18-refcontrol-normal-4step-r1');
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

  const singleViewInpaint = await fetch(
    `${workspaceBaseUrl}/api/modelview/single-view-inpaint`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Cookie: cookie,
        Origin: allowedOrigin,
      },
      body: JSON.stringify({
        ...inpaintPayload,
        normalImage: undefined,
        clientGenerationId: `texture-map-single-camera-view-${'a'.repeat(36)}-${'b'.repeat(36)}`,
        prompt: '只补全白模区域',
      }),
    },
  );
  assert.equal(singleViewInpaint.status, 200);
  const singleViewInpaintResult = await singleViewInpaint.json();
  assert.equal(
    singleViewInpaintResult.modelviewJobId,
    'mock-modelview-single-view-inpaint-job-1',
  );
  assert.equal(singleViewInpaintResult.output?.source, 'modelview-single-view-inpaint');
  assert.equal(
    singleViewInpaintResult.output?.workflow,
    '2026.09.17-li3d4500-single-view-inpaint-2step-r1',
  );
  const singleViewInpaintSaved = await fetch(singleViewInpaintResult.resultUrl, {
    headers: { Cookie: cookie, Origin: allowedOrigin },
  });
  assert.equal(singleViewInpaintSaved.status, 200);
  assert.deepEqual(Buffer.from(await singleViewInpaintSaved.arrayBuffer()), resultPng);

  const singleView = await fetch(`${workspaceBaseUrl}/api/modelview/single-view`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Cookie: cookie,
      Origin: allowedOrigin,
    },
    body: JSON.stringify({
      clientGenerationId: 'single-view-generation-1',
      projectId: created.project.id,
      prompt: '保持当前视角结构并迁移参考材质',
      image: {
        path: 'white-model.png',
        dataUrl: `data:image/png;base64,${resultPng.toString('base64')}`,
      },
      materialImage: inpaintPayload.materialImage,
    }),
  });
  assert.equal(singleView.status, 200);
  const singleViewResult = await singleView.json();
  assert.equal(singleViewResult.modelviewJobId, 'mock-modelview-single-view-job-1');
  assert.equal(singleViewResult.output?.source, 'modelview-single-view');
  assert.equal(singleViewResult.output?.workflow, '2026.09.17-li3d4500-single-view-4step-r1');
  const singleViewSaved = await fetch(singleViewResult.resultUrl, {
    headers: { Cookie: cookie, Origin: allowedOrigin },
  });
  assert.equal(singleViewSaved.status, 200);
  assert.deepEqual(Buffer.from(await singleViewSaved.arrayBuffer()), resultPng);

  for (const prompt of ['', '修复纸张边缘']) {
    const polished = await fetch(`${workspaceBaseUrl}/api/modelview/inpaint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: cookie, Origin: allowedOrigin },
      body: JSON.stringify({ ...inpaintPayload, clientGenerationId: 'smoke-polished', promptPolishEnabled: true, prompt }),
    });
    assert.equal(polished.status, prompt ? 200 : 422);
  }
  assert.equal(observedRequests.length, 6);
  assert.equal(observedRequests[0].idempotencyKey, observedRequests[1].idempotencyKey);
  assert.equal(observedRequests[0].sha256, observedRequests[1].sha256);
  console.log(
    'ModelView smoke passed: two/three/four-image workflows, raw normal bytes and validation, omit stale prompts, explicit local polishing overrides, stable retry bytes/keys, X-Job-ID and PNG persistence.',
  );
} catch (error) {
  if (serverOutput.trim()) console.error(serverOutput.trim());
  throw error;
} finally {
  await stopChild(child);
  await new Promise((resolve) => modelviewMock.close(resolve));
  await fs.rm(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
