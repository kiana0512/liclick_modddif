import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const serverEntry = path.join(repoRoot, 'apps', 'server', 'dist', 'index.js');
const allowedOrigin = 'http://127.0.0.1:5173';
const deniedOrigin = 'https://untrusted.example';

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForHealth(baseUrl, child) {
  const timeoutAt = Date.now() + 15_000;
  while (Date.now() < timeoutAt) {
    if (child.exitCode !== null) throw new Error(`Server exited before health check (${child.exitCode}).`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { headers: { Origin: allowedOrigin } });
      if (response.ok) return;
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the local server health check.');
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

async function verifyExternalBindRequiresSecret() {
  const probe = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SERVER_HOST: '0.0.0.0',
      SERVER_PORT: '0',
      SESSION_SECRET: 'dev-only-change-me',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  probe.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exitCode = await new Promise((resolve) => probe.once('exit', resolve));
  assert.notEqual(exitCode, 0, 'A non-loopback server must reject the default development session secret.');
  assert.match(stderr, /SESSION_SECRET must be set/);
}

const port = await reservePort();
const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'liclick-server-smoke-'));
const baseUrl = `http://127.0.0.1:${port}`;
let output = '';
const child = spawn(process.execPath, [serverEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    AUTH_MODE: 'dev-mock',
    LICLICK_ENABLE_ATLAS_LOCAL_LOGIN: 'false',
    LICLICK_FRONTEND_URL: allowedOrigin,
    LICLICK_PUBLIC_WORKSPACE_URL: baseUrl,
    LICLICK_WORKSPACE_DIR: workspaceDir,
    SERVER_HOST: '127.0.0.1',
    SERVER_PORT: String(port),
    SESSION_SECRET: 'local-smoke-test-secret-not-for-production',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
child.stdout.on('data', (chunk) => { output += chunk.toString(); });
child.stderr.on('data', (chunk) => { output += chunk.toString(); });

try {
  await waitForHealth(baseUrl, child);

  const deniedApi = await fetch(`${baseUrl}/api/health`, { headers: { Origin: deniedOrigin } });
  assert.equal(deniedApi.status, 403, 'API requests from an untrusted Origin must be rejected.');

  const preflight = await fetch(`${baseUrl}/api/projects`, {
    method: 'OPTIONS',
    headers: { Origin: allowedOrigin },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');

  const login = await fetch(`${baseUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: allowedOrigin },
    body: JSON.stringify({ displayName: 'Local Smoke', email: 'local-smoke@liclick.test' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  assert(cookie, 'Dev login must set a session cookie.');
  const loggedIn = await login.json();
  assert(loggedIn.user?.id, 'Dev login must return the authenticated user id.');

  const missingComfyCancelJob = await fetch(`${baseUrl}/api/comfyui/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: cookie, Origin: allowedOrigin },
    body: JSON.stringify({}),
  });
  assert.equal(missingComfyCancelJob.status, 400);

  const unknownComfyCancelJob = await fetch(`${baseUrl}/api/comfyui/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: cookie, Origin: allowedOrigin },
    body: JSON.stringify({ jobId: 'not-an-active-job' }),
  });
  assert.equal(unknownComfyCancelJob.status, 404);

  const createProject = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: cookie, Origin: allowedOrigin },
    body: JSON.stringify({ name: 'Local server smoke project' }),
  });
  assert.equal(createProject.status, 201);
  const created = await createProject.json();
  assert(created.project?.id, 'Project creation must return a project id.');

  const upload = await fetch(
    `${baseUrl}/api/projects/${encodeURIComponent(created.project.id)}/assets?format=blob&category=references&filename=smoke.png`,
    {
      method: 'POST',
      headers: { 'content-type': 'image/png', Cookie: cookie, Origin: allowedOrigin },
      body: Buffer.from('local-smoke-image'),
    },
  );
  assert.equal(upload.status, 201);
  const uploaded = await upload.json();
  assert(uploaded.asset?.url, 'Asset upload must return a workspace URL.');

  const layerAssetResponses = await Promise.all(
    [
      ['smoke-layer.png', 'local-smoke-layer-image'],
      ['smoke-layer-mask.png', 'local-smoke-layer-mask'],
      ['smoke-layer-depth.png', 'local-smoke-layer-depth'],
    ].map(([filename, contents]) =>
      fetch(
        `${baseUrl}/api/projects/${encodeURIComponent(created.project.id)}/assets?format=blob&category=layers&filename=${encodeURIComponent(filename)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'image/png', Cookie: cookie, Origin: allowedOrigin },
          body: Buffer.from(contents),
        },
      ),
    ),
  );
  layerAssetResponses.forEach((response) => assert.equal(response.status, 201));
  const [layerImageAsset, layerMaskAsset, layerDepthAsset] = await Promise.all(
    layerAssetResponses.map((response) => response.json()),
  );

  const objectWithLayer = {
    ...created.project,
    objects: [
      {
        id: 'smoke-object',
        name: 'Smoke object',
        type: 'model',
        sourcePath: uploaded.asset.url,
        format: 'fbx',
        materialSlots: [],
        uvSets: [],
        warnings: [],
      },
    ],
    layers: [
      {
        id: 'smoke-layer',
        name: 'Smoke layer',
        type: 'projected',
        objectId: 'smoke-object',
        imageUrl: layerImageAsset.asset.url,
        maskUrl: layerMaskAsset.asset.url,
        depthUrl: layerDepthAsset.asset.url,
        visible: true,
        opacity: 1,
      },
    ],
  };
  const saveLayeredProject = await fetch(
    `${baseUrl}/api/projects/${encodeURIComponent(created.project.id)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', Cookie: cookie, Origin: allowedOrigin },
      body: JSON.stringify(objectWithLayer),
    },
  );
  assert.equal(saveLayeredProject.status, 200, 'A project with models and layers must save normally.');
  const savedLayeredProject = await saveLayeredProject.json();

  const accidentalLayerClear = await fetch(
    `${baseUrl}/api/projects/${encodeURIComponent(created.project.id)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', Cookie: cookie, Origin: allowedOrigin },
      body: JSON.stringify({ ...savedLayeredProject.project, layers: [] }),
    },
  );
  assert.equal(
    accidentalLayerClear.status,
    409,
    'A stale client snapshot must not clear every layer while project models remain.',
  );

  const preserveExistingLayerAsset = await fetch(
    `${baseUrl}/api/projects/${encodeURIComponent(created.project.id)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', Cookie: cookie, Origin: allowedOrigin },
      body: JSON.stringify({
        ...savedLayeredProject.project,
        layers: savedLayeredProject.project.layers.map((layer) => ({
          ...layer,
          imageUrl: 'blob:http://127.0.0.1/still-uploading',
        })),
      }),
    },
  );
  assert.equal(
    preserveExistingLayerAsset.status,
    200,
    'A transient Blob URL must preserve the existing durable projected-layer asset.',
  );
  const preservedProject = await preserveExistingLayerAsset.json();
  assert.equal(preservedProject.project.layers[0].imageUrl, layerImageAsset.asset.url);

  const staleProjectSave = await fetch(
    `${baseUrl}/api/projects/${encodeURIComponent(created.project.id)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', Cookie: cookie, Origin: allowedOrigin },
      body: JSON.stringify({ ...preservedProject.project, updatedAt: '2000-01-01T00:00:00.000Z' }),
    },
  );
  assert.equal(
    staleProjectSave.status,
    409,
    'An older full-project snapshot must not overwrite newer captures or projected layers.',
  );

  const rejectNewVolatileLayer = await fetch(
    `${baseUrl}/api/projects/${encodeURIComponent(created.project.id)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', Cookie: cookie, Origin: allowedOrigin },
      body: JSON.stringify({
        ...preservedProject.project,
        layers: [
          {
            ...preservedProject.project.layers[0],
            id: 'new-volatile-projected-layer',
            imageUrl: 'blob:http://127.0.0.1/not-uploaded-yet',
          },
          ...preservedProject.project.layers,
        ],
      }),
    },
  );
  assert.equal(
    rejectNewVolatileLayer.status,
    409,
    'A new projected layer must not be persisted before its image upload completes.',
  );

  const rawProjectPath = path.join(
    workspaceDir,
    'users',
    loggedIn.user.id,
    'projects',
    created.slug,
    'project.liclick.json',
  );
  const damagedProject = JSON.parse(await fs.readFile(rawProjectPath, 'utf8'));
  const foreignWorkspaceRecoveryUrl =
    'http://127.0.0.1:9/workspace/users/atlas-user/recoveries/modelview-inpaint/result.png';
  damagedProject.generations = [
    {
      id: 'foreign-repaint-result',
      mode: 'inpaint',
      prompt: 'smoke repaint',
      referenceIds: [],
      status: 'succeeded',
      resultUrl: foreignWorkspaceRecoveryUrl,
      metadata: { provider: 'modelview-seedvr2', workflow: 'local-repaint' },
    },
  ];
  delete damagedProject.layers[0].imageUrl;
  delete damagedProject.layers[0].maskUrl;
  delete damagedProject.layers[0].depthUrl;
  await fs.writeFile(rawProjectPath, `${JSON.stringify(damagedProject, null, 2)}\n`, 'utf8');
  const repairedProjectResponse = await fetch(
    `${baseUrl}/api/projects/${encodeURIComponent(created.project.id)}`,
    { headers: { Cookie: cookie, Origin: allowedOrigin } },
  );
  assert.equal(repairedProjectResponse.status, 200);
  const repairedProject = await repairedProjectResponse.json();
  assert.equal(repairedProject.project.layers[0].imageUrl, layerImageAsset.asset.url);
  assert.equal(repairedProject.project.layers[0].maskUrl, layerMaskAsset.asset.url);
  assert.equal(repairedProject.project.layers[0].depthUrl, layerDepthAsset.asset.url);
  assert.equal(
    repairedProject.project.generations[0].resultUrl,
    foreignWorkspaceRecoveryUrl,
    'Loading a local project must not rewrite a different workspace origin to this server.',
  );

  const asset = await fetch(uploaded.asset.url, {
    headers: { Cookie: cookie, Origin: allowedOrigin },
  });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await asset.text(), 'local-smoke-image');

  const assetHead = await fetch(uploaded.asset.url, {
    method: 'HEAD',
    headers: { Cookie: cookie, Origin: allowedOrigin },
  });
  assert.equal(assetHead.status, 200);
  assert.equal(await assetHead.text(), '');

  const recoveryDirectory = path.join(
    workspaceDir,
    'users',
    loggedIn.user.id,
    'recoveries',
    'modelview-inpaint',
  );
  await fs.mkdir(recoveryDirectory, { recursive: true });
  await fs.writeFile(path.join(recoveryDirectory, 'local-repaint-result.png'), 'local-repaint');
  const recoveryAsset = await fetch(
    `${baseUrl}/workspace/users/${encodeURIComponent(loggedIn.user.id)}/recoveries/modelview-inpaint/local-repaint-result.png`,
    { headers: { Cookie: cookie, Origin: allowedOrigin } },
  );
  assert.equal(
    recoveryAsset.status,
    200,
    'Local repaint recovery images must remain readable by the owning workspace.',
  );
  assert.equal(await recoveryAsset.text(), 'local-repaint');

  const privateWorkspaceFile = await fetch(`${baseUrl}/workspace/auth.json`, {
    headers: { Cookie: cookie, Origin: allowedOrigin },
  });
  assert.equal(privateWorkspaceFile.status, 403, 'Workspace metadata must never be publicly served.');

  const assetUrl = new URL(uploaded.asset.url);
  const traversalUrl = `${baseUrl}${assetUrl.pathname.replace(/\/assets\/references\/[^/]+$/, '/assets/references/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/auth.json')}`;
  const traversal = await fetch(traversalUrl, {
    headers: { Cookie: cookie, Origin: allowedOrigin },
  });
  assert.notEqual(traversal.status, 200, 'Traversal from a public asset directory must not reach workspace metadata.');

  const deniedAsset = await fetch(uploaded.asset.url, {
    headers: { Cookie: cookie, Origin: deniedOrigin },
  });
  assert.equal(deniedAsset.status, 403, 'Workspace assets must reject untrusted Origins.');

  await verifyExternalBindRequiresSecret();
  console.log('Local server smoke passed: auth, safe cancellation, project creation, upload, repaint recovery, CORS, HEAD, and workspace isolation.');
} catch (error) {
  if (output.trim()) console.error(output.trim());
  throw error;
} finally {
  await stopChild(child);
  await fs.rm(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
