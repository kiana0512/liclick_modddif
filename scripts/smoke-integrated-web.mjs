import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const serverEntry = path.join(repoRoot, 'apps', 'server', 'dist', 'index.js');
const webDist = path.join(repoRoot, 'apps', 'web', 'dist');
const installerManifest = JSON.parse(
  await fs.readFile(path.join(webDist, 'downloads', 'local-component', 'manifest.json'), 'utf8'),
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
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForHealth(baseUrl, child) {
  const timeoutAt = Date.now() + 15_000;
  while (Date.now() < timeoutAt) {
    if (child.exitCode !== null) throw new Error(`Server exited before health check (${child.exitCode}).`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the integrated Web server.');
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

const port = await reservePort();
const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'li3d-integrated-web-'));
const baseUrl = `http://127.0.0.1:${port}`;
let output = '';
const child = spawn(process.execPath, [serverEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    AUTH_MODE: 'dev-mock',
    LICLICK_ENABLE_ATLAS_LOCAL_LOGIN: 'false',
    LICLICK_FRONTEND_URL: baseUrl,
    LICLICK_PUBLIC_WORKSPACE_URL: baseUrl,
    LICLICK_SERVE_WEB: 'true',
    LICLICK_WEB_DIST_DIR: webDist,
    LICLICK_WORKSPACE_DIR: workspaceDir,
    SERVER_HOST: '127.0.0.1',
    SERVER_PORT: String(port),
    SESSION_SECRET: 'integrated-web-smoke-secret-not-for-production',
    FEISHU_OAUTH_CLIENT_ID: '',
    FEISHU_OAUTH_CLIENT_SECRET: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
child.stdout.on('data', (chunk) => { output += chunk.toString(); });
child.stderr.on('data', (chunk) => { output += chunk.toString(); });

try {
  const health = await waitForHealth(baseUrl, child);
  assert.equal(health.features?.integratedWeb, true);

  const homepage = await fetch(`${baseUrl}/`);
  assert.equal(homepage.status, 200);
  assert.match(homepage.headers.get('content-type') ?? '', /^text\/html/);
  assert.match(await homepage.text(), /<div id="root"><\/div>/);

  const spaRoute = await fetch(`${baseUrl}/texture/projects/example`);
  assert.equal(spaRoute.status, 200);
  assert.match(spaRoute.headers.get('content-type') ?? '', /^text\/html/);

  const providerStatus = await fetch(`${baseUrl}/api/auth/provider-status`);
  assert.equal(providerStatus.status, 200);
  assert.match(providerStatus.headers.get('content-type') ?? '', /^application\/json/);
  const providerPayload = await providerStatus.json();
  assert.equal(providerPayload.feishuOAuthEnabled, false);
  assert.equal(providerPayload.feishuConfigured, false);
  assert.equal(providerPayload.feishuLoginProvider, 'not-configured');
  assert.deepEqual(providerPayload.missingConfigKeys, [
    'FEISHU_OAUTH_CLIENT_ID or IDAAS_OAUTH_CLIENT_ID',
    'FEISHU_OAUTH_CLIENT_SECRET or IDAAS_OAUTH_CLIENT_SECRET',
  ]);

  const unavailableLogin = await fetch(`${baseUrl}/api/auth/feishu/start`);
  assert.equal(unavailableLogin.status, 409);
  assert.match(unavailableLogin.headers.get('content-type') ?? '', /^application\/json/);

  const cloudPhotoshopBridge = await fetch(`${baseUrl}/api/photoshop/status`);
  assert.equal(cloudPhotoshopBridge.status, 404);

  const anonymousWorkspaceFile = await fetch(
    `${baseUrl}/workspace/users/victim/projects/example/assets/private.png`,
  );
  assert.equal(anonymousWorkspaceFile.status, 401);

  const spoofedSettings = await fetch(`${baseUrl}/api/local-settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userId: 'victim',
      activate: true,
      profile: { customId: 'anonymous-only' },
      performanceTestModeEnabled: true,
      photoshop: { executablePath: 'must-not-be-written' },
    }),
  });
  assert.equal(spoofedSettings.status, 200);
  const spoofedSettingsPayload = await spoofedSettings.json();
  assert.equal(spoofedSettingsPayload.activeUserId, 'anonymous');
  assert.equal(spoofedSettingsPayload.performanceTestModeConfigured, false);
  assert.equal(spoofedSettingsPayload.photoshop.executablePath, '');

  const unknownApi = await fetch(`${baseUrl}/api/does-not-exist`);
  assert.equal(unknownApi.status, 404);
  assert.match(unknownApi.headers.get('content-type') ?? '', /^application\/json/);

  const installer = await fetch(
    `${baseUrl}/downloads/LIclick-3D-Texture-Local-Component-Setup.exe`,
  );
  assert.equal(installer.status, 200);
  assert.match(installer.headers.get('content-disposition') ?? '', /\.exe/);
  const installerBuffer = Buffer.from(await installer.arrayBuffer());
  assert.equal(installerBuffer.length, installerManifest.bytes);
  assert.equal(
    crypto.createHash('sha256').update(installerBuffer).digest('hex'),
    installerManifest.sha256,
  );

  console.log(
    `Integrated Web smoke passed: SPA, auth boundaries, JSON API boundary, and ${installerBuffer.length}-byte local component download.`,
  );
} catch (error) {
  if (output.trim()) console.error(output.trim());
  throw error;
} finally {
  await stopChild(child);
  await fs.rm(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
