import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');

function loadDevelopmentEnvironment(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`[dev] Invalid environment key in ${filePath}: ${key}`);
    }
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

const developmentEnvironmentFile =
  process.env.LICLICK_DEV_ENV_FILE ?? path.join(repoRoot, 'secrets', 'li3d-dev.env');
const loadedDevelopmentEnvironment = loadDevelopmentEnvironment(developmentEnvironmentFile);

function devPort(value, fallback, label) {
  const candidate = value ?? fallback;
  if (!/^\d{1,5}$/.test(candidate) || Number(candidate) < 1 || Number(candidate) > 65535) {
    throw new Error(`[dev] Invalid ${label}: ${candidate}`);
  }
  return candidate;
}

const workspacePort = devPort(process.env.LICLICK_WORKSPACE_PORT, '4518', 'LICLICK_WORKSPACE_PORT');
const webPort = devPort(process.env.LICLICK_WEB_PORT, '5173', 'LICLICK_WEB_PORT');
const localComponentPort = devPort(
  process.env.VITE_LICLICK_LOCAL_COMPONENT_PORT,
  '4619',
  'VITE_LICLICK_LOCAL_COMPONENT_PORT',
);
const workspaceOrigin = `http://127.0.0.1:${workspacePort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const localComponentOrigin = `http://127.0.0.1:${localComponentPort}`;
const managedChildren = new Set();

const env = {
  ...process.env,
  SERVER_PORT: workspacePort,
  LICLICK_WORKSPACE_PORT: workspacePort,
  LICLICK_WORKSPACE_DIR: process.env.LICLICK_WORKSPACE_DIR ?? path.join(repoRoot, 'workspace'),
  LICLICK_PUBLIC_WORKSPACE_URL: process.env.LICLICK_PUBLIC_WORKSPACE_URL ?? workspaceOrigin,
  LICLICK_FRONTEND_URL: process.env.LICLICK_FRONTEND_URL ?? webOrigin,
  LICLICK_ALLOWED_ORIGINS:
    process.env.LICLICK_ALLOWED_ORIGINS ?? `${webOrigin},http://localhost:${webPort}`,
  VITE_LICLICK_WORKSPACE_API: process.env.VITE_LICLICK_WORKSPACE_API ?? workspaceOrigin,
  VITE_LICLICK_LOCAL_COMPONENT_PORT: localComponentPort,
  AUTH_MODE: process.env.AUTH_MODE ?? 'feishu-oauth',
  LICLICK_ENABLE_ATLAS_LOCAL_LOGIN: process.env.LICLICK_ENABLE_ATLAS_LOCAL_LOGIN ?? 'true',
};

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function request(url, responseType = 'json', timeoutMs = 1_200) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (responseType === 'text') {
          resolve({ ok: res.statusCode === 200, status: res.statusCode, body });
          return;
        }
        try {
          resolve({ ok: res.statusCode === 200, status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ ok: false, status: res.statusCode, body: null });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, body: null });
    });
    req.on('error', () => resolve({ ok: false, body: null }));
  });
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(700);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function corepackCommand(args) {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', 'corepack', 'pnpm', ...args],
    };
  }
  return { command: 'corepack', args: ['pnpm', ...args] };
}

function runPnpm(args, { label, foreground = false, extraEnv = {} } = {}) {
  const command = corepackCommand(args);
  const child = spawn(command.command, command.args, {
    cwd: repoRoot,
    env: { ...env, ...extraEnv },
    shell: false,
    stdio: foreground ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });

  if (!foreground) {
    managedChildren.add(child);
    child.stdout?.on('data', (chunk) => process.stdout.write(`[${label}] ${chunk}`));
    child.stderr?.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk}`));
    child.on('exit', () => managedChildren.delete(child));
  }
  return child;
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

async function synchronizeDependencies() {
  if (process.env.LICLICK_DEV_SKIP_INSTALL === '1') {
    console.log('[dev] Dependency synchronization skipped by LICLICK_DEV_SKIP_INSTALL=1.');
    return;
  }
  const packageRoots = [
    repoRoot,
    path.join(repoRoot, 'apps', 'server'),
    path.join(repoRoot, 'apps', 'web'),
    path.join(repoRoot, 'packages', 'core'),
  ];
  const missingDependencies = packageRoots.flatMap((packageRoot) => {
    const packageFile = path.join(packageRoot, 'package.json');
    if (!fs.existsSync(packageFile)) return [];
    const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const names = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]);
    return [...names]
      .filter((name) => !fs.existsSync(path.join(packageRoot, 'node_modules', ...name.split('/'))))
      .map((name) => `${path.relative(repoRoot, packageRoot) || '.'}:${name}`);
  });
  if (missingDependencies.length === 0 && process.env.LICLICK_DEV_FORCE_INSTALL !== '1') {
    console.log('[dev] Workspace dependencies are ready.');
    return;
  }
  if (missingDependencies.length > 0) {
    console.log(`[dev] Missing dependencies: ${missingDependencies.join(', ')}`);
  }
  console.log('[dev] Synchronizing workspace dependencies...');
  const result = await waitForExit(
    runPnpm(['install', '--frozen-lockfile', '--prefer-offline'], {
      foreground: true,
      // pnpm prompts before rebuilding an incompatible modules directory on
      // Windows. A one-click/hidden launcher has no usable stdin, so explicitly
      // opt into the deterministic frozen-lockfile repair.
      extraEnv: { CI: 'true' },
    }),
  );
  if (result.code !== 0) {
    throw new Error(`[dev] Dependency synchronization failed with exit code ${result.code}.`);
  }
}

async function waitForHealthy(label, probe, child, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probe();
    if (health) return health;
    if (child.exitCode !== null) {
      throw new Error(`[dev] ${label} exited before becoming ready (exit ${child.exitCode}).`);
    }
    await delay(300);
  }
  throw new Error(`[dev] Timed out waiting for ${label}.`);
}

async function workspaceHealth() {
  const result = await request(`${workspaceOrigin}/api/health`);
  return result.ok && result.body?.ok === true ? result.body : null;
}

async function webHealth() {
  const result = await request(webOrigin, 'text');
  return result.ok && result.body.includes('<title>LIclick 3D Texture</title>') ? true : null;
}

async function localComponentHealth() {
  const result = await request(`${localComponentOrigin}/api/health`);
  const capabilities = Array.isArray(result.body?.capabilities) ? result.body.capabilities : [];
  return result.ok &&
    result.body?.ok === true &&
    capabilities.includes('texture-painting') &&
    capabilities.includes('atlas-personal-auth')
    ? result.body
    : null;
}

async function ensureService({ label, port, probe, pnpmArgs, extraEnv = {} }) {
  const existing = await probe();
  if (existing) {
    console.log(`[dev] Reusing healthy ${label} on 127.0.0.1:${port}.`);
    return { health: existing, child: null };
  }
  if (await isPortOpen(port)) {
    throw new Error(
      `[dev] Port ${port} is occupied, but it is not a healthy ${label}. Stop that process and retry.`,
    );
  }

  console.log(`[dev] Starting ${label} on 127.0.0.1:${port}...`);
  const child = runPnpm(pnpmArgs, { label, extraEnv });
  const health = await waitForHealthy(label, probe, child);
  console.log(`[dev] ${label} is ready.`);
  return { health, child };
}

function describeAuthProvider(status) {
  if (status?.feishuOAuthEnabled) return status.feishuLoginProvider ?? 'configured';
  const missing = Array.isArray(status?.missingConfigKeys) ? status.missingConfigKeys.join(', ') : '';
  return missing ? `unavailable; missing ${missing}` : 'unavailable';
}

function shutdown(signal) {
  for (const child of managedChildren) child.kill(signal);
}

process.on('SIGINT', () => {
  shutdown('SIGINT');
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
  process.exit(0);
});

try {
  if (loadedDevelopmentEnvironment) {
    console.log(`[dev] Loaded local development configuration from ${developmentEnvironmentFile}.`);
  }
  await synchronizeDependencies();
  const workspace = await ensureService({
    label: 'LI3D identity/workspace service',
    port: workspacePort,
    probe: workspaceHealth,
    pnpmArgs: ['--filter', '@liclick/server', 'dev'],
  });
  const provider = await request(`${workspaceOrigin}/api/auth/provider-status`);
  console.log(`[dev] Feishu/IDaaS authentication: ${describeAuthProvider(provider.body)}.`);
  const directoryAvatarConfigured =
    env.FEISHU_DIRECTORY_ENRICHMENT_ENABLED === 'true' &&
    Boolean(env.FEISHU_PLATFORM_APP_ID || env.FEISHU_OAUTH_CLIENT_ID) &&
    Boolean(env.FEISHU_PLATFORM_APP_SECRET || env.FEISHU_OAUTH_CLIENT_SECRET);
  if (provider.body?.feishuLoginProvider === 'atlas-cli') {
    console.log(
      directoryAvatarConfigured
        ? '[dev] Feishu directory avatars: configured.'
        : '[dev] Feishu directory avatars: using generated fallback. Run "corepack pnpm configure:dev:feishu" once to align with production.',
    );
  }

  await ensureService({
    label: 'LI3D web app',
    port: webPort,
    probe: webHealth,
    pnpmArgs: ['--filter', '@liclick/web', 'dev'],
  });

  const localComponent = await ensureService({
    label: 'LI3D development local component',
    port: localComponentPort,
    probe: localComponentHealth,
    pnpmArgs: ['--filter', '@liclick/server', 'serve:local-component'],
    extraEnv: {
      SERVER_PORT: localComponentPort,
      LICLICK_WORKSPACE_PORT: localComponentPort,
      LICLICK_PUBLIC_WORKSPACE_URL: localComponentOrigin,
      LICLICK_FRONTEND_URL: webOrigin,
      LICLICK_ALLOWED_ORIGINS: `${webOrigin},http://localhost:${webPort}`,
      LICLICK_LOCAL_COMPONENT_MODE: '1',
    },
  });
  console.log(
    `[dev] Isolated local component ready on 127.0.0.1:${localComponentPort} (runtime ${localComponent.health.runtimeVersion ?? 'unknown'}); installed/server component 4618 remains untouched.`,
  );
  console.log(`[dev] Ready: ${webOrigin}`);

  if (managedChildren.size === 0) {
    console.log('[dev] All services were already running; nothing new was started.');
  } else {
    for (const child of [...managedChildren]) {
      child.once('exit', (code, signal) => {
        if (signal || code === 0) return;
        console.error(`[dev] A managed service exited with code ${code}.`);
        shutdown('SIGTERM');
        process.exitCode = code ?? 1;
      });
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  shutdown('SIGTERM');
  process.exitCode = 1;
}
