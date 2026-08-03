import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const serverEntry = path.join(repoRoot, 'apps', 'server', 'dist', 'index.js');
const allowedOrigin = 'http://127.0.0.1:5173';

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
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before health check (${child.exitCode}).`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: allowedOrigin },
      });
      if (response.ok) return;
    } catch {
      // Server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for task history smoke server.');
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

async function login(baseUrl, displayName, email) {
  const response = await fetch(`${baseUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: {
      Origin: allowedOrigin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ displayName, email }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert(payload.user?.id, 'Dev login must return a user id.');
  assert(cookie, 'Dev login must set a session cookie.');
  return { id: payload.user.id, cookie };
}

function bakeSettings() {
  return {
    resolution: 1024,
    padding: 16,
    sampling: '2x2',
    normalOrientation: 'directx',
    device: 'gpu',
    udim: 1001,
    frontalDistance: 0.1,
    rearDistance: 0.1,
    matchMode: 'always',
    projectionMode: 'distance',
    hitStrategy: 'inward',
    ignoreBackfaces: false,
    channels: ['baseColor'],
  };
}

function bakeFixture(id, ownerUserId, sourceName, createdAt) {
  return {
    id,
    ...(ownerUserId ? { ownerUserId } : {}),
    kind: 'bake-maps',
    projectId: 'history-smoke-project',
    objectId: 'history-smoke-object',
    status: 'succeeded',
    stage: 'finished',
    progress: 100,
    settings: bakeSettings(),
    input: {
      high: sourceName,
      low: sourceName.replace('_high.', '_low.'),
    },
    outputs: {
      baseColor: {
        fileName: 'basecolor.png',
        width: 1,
        height: 1,
        url: `/api/bake/jobs/${encodeURIComponent(id)}/output/baseColor`,
      },
    },
    logs: [],
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    finishedAt: createdAt,
  };
}

async function seedBake(workspaceDir, fixture, outputBytes) {
  const directory = path.join(workspaceDir, 'bake-jobs', fixture.id);
  await fs.mkdir(path.join(directory, 'output'), { recursive: true });
  await fs.writeFile(path.join(directory, 'job.json'), JSON.stringify(fixture, null, 2));
  await fs.writeFile(path.join(directory, 'output', 'basecolor.png'), outputBytes);
  await fs.writeFile(
    path.join(directory, 'output', 'baker_result.json'),
    JSON.stringify({
      schema_version: 'history-smoke-v1',
      status: 'SUCCEEDED',
      output_sha256: {
        base_color: crypto.createHash('sha256').update(outputBytes).digest('hex'),
      },
    }),
  );
}

async function getHistory(baseUrl, cookie, module) {
  const response = await fetch(`${baseUrl}/api/history?module=${module}&limit=30`, {
    headers: { Origin: allowedOrigin, Cookie: cookie },
  });
  assert.equal(response.status, 200, `${module} history must be readable.`);
  const payload = await response.json();
  assert(Array.isArray(payload.records), 'History response must contain records.');
  return payload.records;
}

function outputUrl(baseUrl, value) {
  assert(value, 'Successful bake history output must expose a download URL.');
  const resolved = new URL(value, baseUrl);
  assert.equal(resolved.origin, new URL(baseUrl).origin, 'Download must stay on the LI3D origin.');
  assert.match(resolved.pathname, /^\/api\//, 'Download must use an authenticated API route.');
  return resolved;
}

const port = await reservePort();
const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'li3d-task-history-smoke-'));
const baseUrl = `http://127.0.0.1:${port}`;
let serverOutput = '';
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
    SESSION_SECRET: 'task-history-smoke-secret-not-for-production',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
child.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
child.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

try {
  await waitForHealth(baseUrl, child);
  const userA = await login(baseUrl, 'History User A', 'history-a@liclick.test');
  const userB = await login(baseUrl, 'History User B', 'history-b@liclick.test');

  const aBakeId = 'bake_history_owner_a';
  const bBakeId = 'bake_history_owner_b';
  const legacyBakeId = 'bake_history_without_owner';
  const aOutput = Buffer.from('history-owner-a-bake-output');
  await seedBake(
    workspaceDir,
    bakeFixture(aBakeId, userA.id, 'owner-a_high.fbx', '2026-08-01T10:00:00.000Z'),
    aOutput,
  );
  await seedBake(
    workspaceDir,
    bakeFixture(bBakeId, userB.id, 'owner-b_high.fbx', '2026-08-01T11:00:00.000Z'),
    Buffer.from('history-owner-b-bake-output'),
  );
  await seedBake(
    workspaceDir,
    bakeFixture(legacyBakeId, undefined, 'legacy_high.fbx', '2026-08-01T09:00:00.000Z'),
    Buffer.from('history-legacy-bake-output'),
  );

  const assetOwnership = {
    jobs: {
      'asset-uv-new-owner-a': {
        userId: userA.id,
        createdAt: '2026-08-02T10:00:00.000Z',
        updatedAt: '2026-08-02T10:05:00.000Z',
        finishedAt: '2026-08-02T10:05:00.000Z',
        mode: 'uv',
        sourceName: 'owner-a-uv.fbx',
        parameters: [
          { label: '输出尺寸', value: '2K' },
          { label: 'UV 间距', value: '10px' },
        ],
        status: 'SUCCEEDED',
        progress: 100,
        artifacts: [
          {
            id: 'uv-fbx',
            label: 'UV FBX',
            filename: 'owner-a-uv-result.fbx',
            sizeBytes: 128,
            contentType: 'application/octet-stream',
            sha256: 'a'.repeat(64),
          },
        ],
      },
      'asset-retopology-new-owner-b': {
        userId: userB.id,
        createdAt: '2026-08-02T11:00:00.000Z',
        mode: 'retopology',
        sourceName: 'owner-b-retopology.fbx',
        parameters: [{ label: '目标面数', value: '500' }],
        status: 'FAILED',
        progress: 42,
        error: 'History smoke failure.',
        artifacts: [],
      },
      'asset-legacy-owner-a': {
        userId: userA.id,
        createdAt: '2026-08-02T09:00:00.000Z',
      },
    },
  };
  const configDirectory = path.join(workspaceDir, 'config');
  await fs.mkdir(configDirectory, { recursive: true });
  await fs.writeFile(
    path.join(configDirectory, 'asset-processing-jobs.json'),
    JSON.stringify(assetOwnership, null, 2),
  );

  const aBakeHistory = await getHistory(baseUrl, userA.cookie, 'bake');
  const bBakeHistory = await getHistory(baseUrl, userB.cookie, 'bake');
  assert.deepEqual(aBakeHistory.map((record) => record.id), [aBakeId]);
  assert.deepEqual(bBakeHistory.map((record) => record.id), [bBakeId]);
  assert(!aBakeHistory.some((record) => record.id === legacyBakeId));
  assert(!bBakeHistory.some((record) => record.id === legacyBakeId));

  const aBakeRecord = aBakeHistory[0];
  assert.equal(aBakeRecord.module, 'bake');
  assert.equal(aBakeRecord.status, 'succeeded');
  assert(aBakeRecord.parameters.length > 0, 'Bake history must preserve submitted parameters.');
  assert(
    aBakeRecord.parameters.some((parameter) => /1024|1K/i.test(parameter.value)),
    'Bake history must expose resolution.',
  );
  const bakeOutput = aBakeRecord.outputs.find((output) => output.filename === 'basecolor.png');
  assert(bakeOutput, 'Bake history must expose the completed map.');
  assert.equal(bakeOutput.sizeBytes, aOutput.length);
  const controlledDownload = outputUrl(baseUrl, bakeOutput.downloadUrl);

  const anonymousDownload = await fetch(controlledDownload, {
    headers: { Origin: allowedOrigin },
  });
  assert.equal(anonymousDownload.status, 401, 'Anonymous history downloads must be rejected.');
  const crossUserDownload = await fetch(controlledDownload, {
    headers: { Origin: allowedOrigin, Cookie: userB.cookie },
  });
  assert.equal(crossUserDownload.status, 404, 'Another employee must not download an owner artifact.');
  const ownerDownload = await fetch(controlledDownload, {
    headers: { Origin: allowedOrigin, Cookie: userA.cookie },
  });
  assert.equal(ownerDownload.status, 200);
  assert.deepEqual(Buffer.from(await ownerDownload.arrayBuffer()), aOutput);

  const aUvHistory = await getHistory(baseUrl, userA.cookie, 'uv');
  assert(aUvHistory.some((record) => record.id === 'asset-uv-new-owner-a'));
  assert(!aUvHistory.some((record) => record.id === 'asset-retopology-new-owner-b'));
  assert(
    !aUvHistory.some((record) => record.id === 'asset-legacy-owner-a'),
    'A legacy Asset row without a mode must not be guessed into UV history.',
  );
  const newUvRecord = aUvHistory.find((record) => record.id === 'asset-uv-new-owner-a');
  assert.deepEqual(newUvRecord.parameters, assetOwnership.jobs['asset-uv-new-owner-a'].parameters);
  assert.equal(newUvRecord.outputs[0]?.filename, 'owner-a-uv-result.fbx');

  const bRetopologyHistory = await getHistory(baseUrl, userB.cookie, 'retopology');
  assert(bRetopologyHistory.some((record) => record.id === 'asset-retopology-new-owner-b'));
  assert(!bRetopologyHistory.some((record) => record.id === 'asset-uv-new-owner-a'));

  // A legacy ownership row has no mode or task snapshot. Reading either module
  // must remain valid and must never accidentally expose it to another user.
  const aRetopologyHistory = await getHistory(baseUrl, userA.cookie, 'retopology');
  assert(Array.isArray(aRetopologyHistory));
  assert(
    !aRetopologyHistory.some((record) => record.id === 'asset-legacy-owner-a'),
    'A legacy Asset row without a mode must not be guessed into retopology history.',
  );
  assert(!bRetopologyHistory.some((record) => record.id === 'asset-legacy-owner-a'));

  console.log('Task history smoke passed: ownership, legacy deny, parameters, and controlled downloads.');
} catch (error) {
  if (serverOutput.trim()) console.error(serverOutput.trim());
  throw error;
} finally {
  await stopChild(child);
  await fs.rm(workspaceDir, { recursive: true, force: true });
}
