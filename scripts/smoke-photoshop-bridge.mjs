import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from '../apps/server/node_modules/ws/wrapper.mjs';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGJ5JrGJQAAAABJRU5ErkJggg==',
  'base64',
);

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === 'string') throw new Error('Could not allocate a smoke-test port.');
  return address.port;
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The child server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Photoshop bridge smoke server did not become healthy.');
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed: ${response.status}`);
  return payload;
}

const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const socketBase = `ws://127.0.0.1:${port}`;
const smokeRoot = path.join(os.tmpdir(), `liclick-photoshop-bridge-${process.pid}-${Date.now()}`);
const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    SERVER_PORT: String(port),
    LICLICK_WORKSPACE_PORT: String(port),
    LICLICK_PUBLIC_WORKSPACE_URL: baseUrl,
    LICLICK_FRONTEND_URL: 'http://127.0.0.1:5173',
    LICLICK_WORKSPACE_DIR: smokeRoot,
    LICLICK_LOCAL_SETTINGS_PATH: path.join(smokeRoot, 'config', 'local-settings.json'),
    AUTH_MODE: 'dev-mock',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let childLog = '';
child.stdout.on('data', (chunk) => {
  childLog += chunk;
});
child.stderr.on('data', (chunk) => {
  childLog += chunk;
});

let plugin;
let web;
try {
  await waitForHealth(baseUrl);
  await requestJson(`${baseUrl}/api/local-settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ photoshop: { autoLaunch: false, syncMode: 'live', liveSyncDelayMs: 700 } }),
  });
  const session = await requestJson(`${baseUrl}/api/photoshop/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: 'photoshop-smoke-project',
      layerId: 'photoshop-smoke-layer',
      layerName: 'Photoshop smoke layer',
      layerType: 'projected',
    }),
  });
  await requestJson(`${baseUrl}/api/photoshop/sessions/${session.id}/source`, {
    method: 'PUT',
    headers: {
      'content-type': 'image/png',
      'x-liclick-session-token': session.token,
    },
    body: png,
  });

  plugin = new WebSocket(`${socketBase}/api/photoshop/socket?role=plugin`);
  web = new WebSocket(
    `${socketBase}/api/photoshop/socket?role=web&sessionId=${session.id}&token=${encodeURIComponent(session.token)}`,
  );
  let openCommands = 0;
  let resultSettled = false;
  const resultPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Photoshop bridge smoke test timed out.')), 8000);
    plugin.on('open', () => {
      plugin.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: '1.0.0',
          pluginVersion: 'smoke',
          photoshopVersion: '25.2',
        }),
      );
    });
    plugin.on('message', async (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== 'open-session' || message.session.id !== session.id) return;
      openCommands += 1;
      const filename = 'rev-smoke-000001.png';
      await fs.writeFile(path.join(message.session.revisionsDirectory, filename), png);
      plugin.send(JSON.stringify({ type: 'session-status', sessionId: session.id, status: 'ready' }));
      plugin.send(JSON.stringify({ type: 'session-exported', sessionId: session.id, filename }));
      plugin.send(JSON.stringify({ type: 'session-exported', sessionId: session.id, filename }));
    });
    web.on('message', async (raw) => {
      const message = JSON.parse(String(raw));
      if (resultSettled || message.type !== 'session-updated' || !message.session.latestImageUrl) return;
      resultSettled = true;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
      const latest = await requestJson(
        `${baseUrl}/api/photoshop/sessions/${session.id}?token=${encodeURIComponent(session.token)}`,
      );
      const imageResponse = await fetch(latest.latestImageUrl);
      clearTimeout(timeout);
      resolve({
        openCommands,
        revision: latest.latestRevision,
        status: latest.status,
        imageOk: imageResponse.ok,
        imageBytes: (await imageResponse.arrayBuffer()).byteLength,
      });
    });
  });

  await requestJson(`${baseUrl}/api/photoshop/sessions/${session.id}/open`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-liclick-session-token': session.token,
    },
    body: '{}',
  });
  const result = await resultPromise;
  if (
    result.openCommands !== 1 ||
    result.revision !== 1 ||
    result.status !== 'synced' ||
    !result.imageOk ||
    result.imageBytes !== png.byteLength
  ) {
    throw new Error(`Unexpected Photoshop bridge result: ${JSON.stringify(result)}`);
  }
  await requestJson(`${baseUrl}/api/photoshop/sessions/${session.id}/close`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-liclick-session-token': session.token,
    },
    body: '{}',
  });
  console.log(`Photoshop bridge smoke passed: ${JSON.stringify(result)}`);
} catch (error) {
  console.error(childLog.trim());
  throw error;
} finally {
  plugin?.close();
  web?.close();
  child.kill();
  const resolvedSmokeRoot = path.resolve(smokeRoot);
  const resolvedTempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (resolvedSmokeRoot.startsWith(resolvedTempRoot) && path.basename(resolvedSmokeRoot).startsWith('liclick-photoshop-bridge-')) {
    await fs.rm(resolvedSmokeRoot, { recursive: true, force: true });
  }
}
