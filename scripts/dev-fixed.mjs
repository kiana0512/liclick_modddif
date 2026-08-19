import { spawn, spawnSync } from 'node:child_process';
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
  '4618',
  'VITE_LICLICK_LOCAL_COMPONENT_PORT',
);
const workspaceOrigin = `http://127.0.0.1:${workspacePort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const localComponentOrigin = `http://127.0.0.1:${localComponentPort}`;
const managedChildren = new Set();
const installedLocalComponentRoot = path.join(
  process.env.LOCALAPPDATA ?? '',
  'Programs',
  'LIclick 3D Texture Local Component',
);
const installedLocalComponentNode = path.join(installedLocalComponentRoot, 'node', 'node.exe');
const installedLocalComponentStop = path.join(
  installedLocalComponentRoot,
  'scripts',
  'stop-local-component.mjs',
);
const installedLocalComponentLauncher = path.join(
  installedLocalComponentRoot,
  'scripts',
  'windows-local-component.mjs',
);
const installedFrontendUrlFile = path.join(installedLocalComponentRoot, 'frontend-url.txt');

function readInstalledFrontendOrigin() {
  try {
    const configured = fs.readFileSync(installedFrontendUrlFile, 'utf8').trim();
    const url = new URL(configured);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  } catch {
    // A development-only installation may not include the server origin file.
  }
  return webOrigin;
}

const installedFrontendOrigin = readInstalledFrontendOrigin();

const workspaceDir = path.resolve(
  process.env.LICLICK_WORKSPACE_DIR ?? path.join(repoRoot, 'workspace'),
);
const managedLanCaPath = path.join(workspaceDir, 'config', 'GPU_CONTROL_LAN_CA.crt');
const configuredSubstanceCaPath = process.env.LICLICK_SUBSTANCE_BAKER_CA_PATH?.trim();
const configuredModelviewCaPath = process.env.LICLICK_MODELVIEW_INPAINT_CA_PATH?.trim();
const env = {
  ...process.env,
  SERVER_PORT: workspacePort,
  LICLICK_WORKSPACE_PORT: workspacePort,
  LICLICK_WORKSPACE_DIR: workspaceDir,
  LICLICK_PUBLIC_WORKSPACE_URL: process.env.LICLICK_PUBLIC_WORKSPACE_URL ?? workspaceOrigin,
  LICLICK_FRONTEND_URL: process.env.LICLICK_FRONTEND_URL ?? webOrigin,
  LICLICK_ALLOWED_ORIGINS:
    process.env.LICLICK_ALLOWED_ORIGINS ?? `${webOrigin},http://localhost:${webPort}`,
  VITE_LICLICK_WORKSPACE_API: process.env.VITE_LICLICK_WORKSPACE_API ?? workspaceOrigin,
  VITE_LICLICK_LOCAL_COMPONENT_PORT: localComponentPort,
  // An old absolute path in a copied workspace must not break TLS. Preserve an
  // existing operator certificate, otherwise use the managed certificate that
  // the current server materializes inside the active workspace.
  LICLICK_SUBSTANCE_BAKER_CA_PATH:
    configuredSubstanceCaPath && fs.existsSync(path.resolve(configuredSubstanceCaPath))
      ? path.resolve(configuredSubstanceCaPath)
      : managedLanCaPath,
  LICLICK_MODELVIEW_INPAINT_CA_PATH:
    configuredModelviewCaPath && fs.existsSync(path.resolve(configuredModelviewCaPath))
      ? path.resolve(configuredModelviewCaPath)
      : managedLanCaPath,
  AUTH_MODE: process.env.AUTH_MODE ?? 'feishu-oauth',
  LICLICK_ENABLE_ATLAS_LOCAL_LOGIN: process.env.LICLICK_ENABLE_ATLAS_LOCAL_LOGIN ?? 'true',
  LICLICK_IDENTITY_PROOF_FALLBACK_VERIFIER_URL:
    process.env.LICLICK_IDENTITY_PROOF_FALLBACK_VERIFIER_URL ??
    `${installedFrontendOrigin}/api/auth/local-proof/verify`,
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

async function stopPreviousLi3dServices() {
  const services = [
    { label: 'LI3D identity/workspace service', port: workspacePort, probe: workspaceHealth },
    { label: 'LI3D web app', port: webPort, probe: webHealth },
  ];
  for (const service of services) {
    if (!(await isPortOpen(service.port))) continue;
    if (!(await service.probe())) {
      throw new Error(
        `[dev] Port ${service.port} is occupied by something other than ${service.label}; refusing to stop it.`,
      );
    }
  }
  const occupiedPorts = [];
  for (const service of services) {
    if (await isPortOpen(service.port)) occupiedPorts.push(service.port);
  }
  if (occupiedPorts.length === 0) return;
  if (process.platform !== 'win32') {
    throw new Error('[dev] Automatic restart of existing services is currently supported on Windows.');
  }

  // Restart only the development workspace and web processes. Port 4618 belongs
  // to the separately installed local component and must never be terminated or
  // replaced by this repository's development launcher.
  const portFilter = occupiedPorts.join(',');
  const script = [
    `$targetPorts = @(${portFilter})`,
    '$listenerPids = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $targetPorts -contains $_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique)',
    '$roots = New-Object System.Collections.Generic.HashSet[int]',
    'foreach ($listenerPid in $listenerPids) {',
    '  $cursor = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerPid" -ErrorAction SilentlyContinue',
    '  while ($cursor) {',
    '    if ($cursor.Name -eq "node.exe" -and $cursor.CommandLine -match "scripts[\\\\/]dev-fixed\\.mjs") { [void]$roots.Add([int]$cursor.ProcessId); break }',
    '    if (-not $cursor.ParentProcessId) { break }',
    '    $cursor = Get-CimInstance Win32_Process -Filter "ProcessId=$($cursor.ParentProcessId)" -ErrorAction SilentlyContinue',
    '  }',
    '}',
    'foreach ($rootPid in $roots) { & taskkill.exe /PID $rootPid /T /F *> $null }',
    'Start-Sleep -Milliseconds 250',
    '$remaining = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $targetPorts -contains $_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique)',
    'foreach ($remainingPid in $remaining) { Stop-Process -Id $remainingPid -Force -ErrorAction SilentlyContinue }',
  ].join('; ');
  const stopped = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: true },
  );
  if (stopped.status !== 0) {
    throw new Error(
      `[dev] Could not restart previous LI3D services: ${(stopped.stderr || stopped.stdout || '').trim()}`,
    );
  }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const states = await Promise.all(occupiedPorts.map((port) => isPortOpen(port)));
    if (states.every((open) => !open)) return;
    await delay(150);
  }
  throw new Error(`[dev] Timed out stopping LI3D services on ${occupiedPorts.join(', ')}.`);
}

async function restartInstalledLocalComponent() {
  const requiredFiles = [
    installedLocalComponentNode,
    installedLocalComponentStop,
    installedLocalComponentLauncher,
  ];
  if (process.platform !== 'win32' || requiredFiles.some((file) => !fs.existsSync(file))) {
    return false;
  }
  const stop = spawnSync(installedLocalComponentNode, [installedLocalComponentStop], {
    cwd: installedLocalComponentRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (stop.status !== 0) {
    throw new Error(
      `[dev] Could not restart the installed LI3D local component: ${(stop.stderr || stop.stdout || '').trim()}`,
    );
  }
  const closeDeadline = Date.now() + 8_000;
  while (Date.now() < closeDeadline && (await isPortOpen(localComponentPort))) {
    await delay(150);
  }
  if (await isPortOpen(localComponentPort)) {
    throw new Error(`[dev] Installed LI3D local component did not release port ${localComponentPort}.`);
  }
  const launch = spawnSync(installedLocalComponentNode, [installedLocalComponentLauncher], {
    cwd: installedLocalComponentRoot,
    env: {
      ...process.env,
      // Preserve the installed/server frontend as the component owner. The
      // component build already permits loopback 5173, so both server and local
      // development pages can use the same installed runtime concurrently.
      LICLICK_FRONTEND_URL: installedFrontendOrigin,
      LICLICK_IDENTITY_PROOF_VERIFIER_URL: `${workspaceOrigin}/api/auth/local-proof/verify`,
    },
    encoding: 'utf8',
    windowsHide: true,
  });
  if (launch.status !== 0) {
    throw new Error(
      `[dev] Installed LI3D local component failed to start: ${(launch.stderr || launch.stdout || '').trim()}`,
    );
  }
  const readyDeadline = Date.now() + 12_000;
  while (Date.now() < readyDeadline) {
    if (await localComponentHealth()) return true;
    await delay(200);
  }
  throw new Error(`[dev] Installed LI3D local component did not become ready on ${localComponentOrigin}.`);
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
  if (process.argv.includes('--restart-all')) {
    await stopPreviousLi3dServices();
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

  if (process.argv.includes('--restart-all')) {
    const restarted = await restartInstalledLocalComponent();
    if (restarted) {
      console.log(
        `[dev] Restarted the installed LI3D local component with the development identity verifier; its installed files and workspace remain untouched.`,
      );
    }
  }

  const localComponent = await localComponentHealth();
  if (localComponent) {
    console.log(
      `[dev] Reusing installed LI3D local component on 127.0.0.1:${localComponentPort} (runtime ${localComponent.runtimeVersion ?? 'unknown'}); it remains untouched.`,
    );
  } else {
    console.warn(
      `[dev] Installed LI3D local component is not ready on 127.0.0.1:${localComponentPort}; development services remain available and the installed component was not modified.`,
    );
  }
  console.log(`[dev] Atlas CLI identity and generation use the workspace service on 127.0.0.1:${workspacePort}.`);
  console.log(`[dev] Managed LAN CA: ${managedLanCaPath}.`);
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
