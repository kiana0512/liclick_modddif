import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const launcherDir = path.dirname(fileURLToPath(import.meta.url));
const installRoot = path.resolve(launcherDir, '..');
const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
const appDataRoot = path.join(localAppData, 'Liclick 3D Texture');
const runtimeRoot = path.join(appDataRoot, 'runtime');
const workspaceDir = process.env.LICLICK_WORKSPACE_DIR ?? path.join(appDataRoot, 'workspace');
const logsDir = path.join(appDataRoot, 'logs');
const manifestPath = path.join(runtimeRoot, '.liclick-runtime-manifest.json');
const preparedInstallMarker = path.join(installRoot, '.liclick-prepared-runtime.json');
const workspacePort = process.env.LICLICK_WORKSPACE_PORT ?? '4617';
const webPort = process.env.LICLICK_WEB_PORT ?? '5673';
const workspaceUrl = process.env.LICLICK_PUBLIC_WORKSPACE_URL ?? `http://127.0.0.1:${workspacePort}`;
const webUrl = process.env.LICLICK_FRONTEND_URL ?? `http://127.0.0.1:${webPort}`;
const isWindows = process.platform === 'win32';
const shouldOpenBrowser = process.env.LICLICK_OPEN_BROWSER !== '0';
const shouldHideChildWindows = process.env.LICLICK_WINDOWS_HIDE === '1';
const managedChildren = new Set();

fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(workspaceDir, { recursive: true });
fs.mkdirSync(runtimeRoot, { recursive: true });

const launcherLog = fs.createWriteStream(path.join(logsDir, 'launcher.log'), { flags: 'a' });
const serverLog = path.join(logsDir, 'server.log');
const webLog = path.join(logsDir, 'web.log');

function timestamp() {
  return new Date().toISOString();
}

function writeLog(message = '') {
  const line = `[${timestamp()}] ${message}`;
  console.log(line);
  launcherLog.write(`${line}\n`);
}

function writeRaw(stream, chunk) {
  process[stream].write(chunk);
  launcherLog.write(chunk);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveCommand(command) {
  if (!isWindows) return command;
  if (command === 'node') {
    for (const root of [runtimeRoot, installRoot]) {
      const bundledNode = path.join(root, 'node', 'node.exe');
      if (fs.existsSync(bundledNode)) return bundledNode;
    }
  }
  const bundled = path.join(runtimeRoot, 'node', `${command}.cmd`);
  if (fs.existsSync(bundled)) return bundled;
  const installBundled = path.join(installRoot, 'node', `${command}.cmd`);
  if (fs.existsSync(installBundled)) return installBundled;
  return command;
}

function shouldRunWithShell(command) {
  return isWindows && /\.(cmd|bat)$/i.test(command);
}

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function commandInvocation(command, args) {
  const resolvedCommand = resolveCommand(command);
  if (!shouldRunWithShell(resolvedCommand)) {
    return {
      command: resolvedCommand,
      args,
      display: `${resolvedCommand} ${args.join(' ')}`,
    };
  }
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/c', ['call', quoteCmdArg(resolvedCommand), ...args.map(quoteCmdArg)].join(' ')],
    display: `${resolvedCommand} ${args.join(' ')}`,
    windowsVerbatimArguments: true,
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const invocation = commandInvocation(command, args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd ?? runtimeRoot,
      env: options.env ?? launcherEnv(),
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
      windowsHide: shouldHideChildWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const logStream = options.logFile ? fs.createWriteStream(options.logFile, { flags: 'a' }) : undefined;
    child.stdout?.on('data', (chunk) => {
      process.stdout.write(chunk);
      launcherLog.write(chunk);
      logStream?.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      process.stderr.write(chunk);
      launcherLog.write(chunk);
      logStream?.write(chunk);
    });
    child.on('error', (error) => {
      logStream?.end();
      reject(error);
    });
    child.on('exit', (code, signal) => {
      logStream?.end();
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}

function spawnService(name, command, args, logFile) {
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const invocation = commandInvocation(command, args);
  writeLog(`${name} command: ${invocation.display}`);
  const child = spawn(invocation.command, invocation.args, {
    cwd: runtimeRoot,
    env: launcherEnv(),
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
    windowsHide: shouldHideChildWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  managedChildren.add(child);
  writeLog(`${name} PID: ${child.pid}`);

  child.stdout?.on('data', (chunk) => {
    writeRaw('stdout', chunk);
    logStream.write(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    writeRaw('stderr', chunk);
    logStream.write(chunk);
  });
  child.on('exit', (code, signal) => {
    managedChildren.delete(child);
    logStream.end();
    writeLog(`${name} stopped (${signal ? `signal ${signal}` : `exit code ${code ?? 0}`}).`);
  });
  child.on('error', (error) => {
    managedChildren.delete(child);
    logStream.end();
    writeLog(`${name} failed to start: ${error.message}`);
  });

  return child;
}

function launcherEnv() {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const userNpmRoot = path.join(appData, 'npm');
  const atlasSkillhubPath = path.join(userNpmRoot, 'node_modules', '@lilith', 'atlas-skillhub', 'dist', 'index.js');
  const pathEntries = [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'),
    userNpmRoot,
    process.env.Path ?? process.env.PATH ?? '',
  ].filter(Boolean);
  const env = {
    ...process.env,
    LICLICK_WORKSPACE_PORT: workspacePort,
    LICLICK_WEB_PORT: webPort,
    LICLICK_WORKSPACE_DIR: workspaceDir,
    LICLICK_PUBLIC_WORKSPACE_URL: workspaceUrl,
    VITE_LICLICK_WORKSPACE_API: workspaceUrl,
    LICLICK_FRONTEND_URL: webUrl,
    LICLICK_ALLOWED_ORIGINS: `${webUrl},${workspaceUrl},http://localhost:${webPort},http://127.0.0.1:${webPort}`,
    DATABASE_URL: process.env.DATABASE_URL ?? `file:${path.join(workspaceDir, 'liclick.db').replaceAll('\\', '/')}`,
    AUTH_MODE: process.env.AUTH_MODE ?? 'feishu-oauth',
    ATLAS_SKILLHUB_PATH: process.env.ATLAS_SKILLHUB_PATH ?? atlasSkillhubPath,
    CI: process.env.CI ?? 'true',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT ?? '0',
    Path: pathEntries.join(path.delimiter),
    PATH: pathEntries.join(path.delimiter),
  };
  return env;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function hashFile(hash, filePath) {
  if (!fs.existsSync(filePath)) return;
  hash.update(filePath.replace(installRoot, ''));
  hash.update(fs.readFileSync(filePath));
}

function sourceSignature() {
  const hash = crypto.createHash('sha256');
  const rootFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json'];
  rootFiles.forEach((file) => hashFile(hash, path.join(installRoot, file)));
  for (const manifest of findPackageManifests(path.join(installRoot, 'apps'))) hashFile(hash, manifest);
  for (const manifest of findPackageManifests(path.join(installRoot, 'packages'))) hashFile(hash, manifest);
  hashFile(hash, path.join(installRoot, 'scripts', 'windows-desktop-launcher.mjs'));
  hashFile(hash, preparedInstallMarker);
  return hash.digest('hex');
}

function findPackageManifests(dir) {
  if (!fs.existsSync(dir)) return [];
  const manifests = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(dir, entry.name, 'package.json');
    if (fs.existsSync(candidate)) manifests.push(candidate);
  }
  return manifests;
}

function shouldCopyPath(sourcePath, includePreparedArtifacts) {
  const relative = path.relative(installRoot, sourcePath);
  if (!relative) return true;
  const parts = relative.split(path.sep);
  const filename = parts.at(-1) ?? '';
  const excludedRoots = new Set([
    '.agents',
    '.codex',
    '.git',
    '.pnpm-store',
    'dist',
    'dist-installer',
    'docs',
    'electron',
    'examples',
    'logs',
    'packages',
    'secrets',
    'workspace',
    'workspace-auth-smoke',
    'workspace-auth-smoke-feishu',
  ]);
  if (excludedRoots.has(parts[0])) return false;
  if (parts.includes('src')) return false;
  if (parts.includes('node_modules') && !includePreparedArtifacts) return false;
  if (parts.includes('dist') && !includePreparedArtifacts) return false;
  if (filename.endsWith('.log')) return false;
  if (filename.endsWith('.ts') || filename.endsWith('.tsx') || filename.endsWith('.map')) return false;
  if (filename === '.env' || filename.endsWith('.tsbuildinfo')) return false;
  return true;
}

async function syncRuntimeSource(includePreparedArtifacts) {
  writeLog(`Syncing runtime files to ${runtimeRoot}`);
  for (const entry of [
    'apps',
    'assets',
    'connectors',
    'docs',
    'examples',
    'packages',
    'scripts',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.liclick-prepared-runtime.json',
  ]) {
    fs.rmSync(path.join(runtimeRoot, entry), { recursive: true, force: true });
  }
  await fs.promises.cp(installRoot, runtimeRoot, {
    recursive: true,
    force: true,
    filter: (sourcePath) => shouldCopyPath(sourcePath, includePreparedArtifacts),
  });
}

function runtimeIsReady(signature) {
  const manifest = readJson(manifestPath);
  if (manifest?.sourceSignature !== signature) return false;
  return runtimeFilesReady();
}

function runtimeFilesReady() {
  if (!fs.existsSync(path.join(runtimeRoot, 'apps', 'server', 'dist', 'index.js'))) return false;
  if (!fs.existsSync(path.join(runtimeRoot, 'apps', 'web', 'dist', 'index.html'))) return false;
  return true;
}

async function prepareRuntime() {
  const signature = sourceSignature();
  const readyBeforeCopy = runtimeIsReady(signature);
  const includePreparedArtifacts = !readyBeforeCopy && fs.existsSync(preparedInstallMarker);
  await syncRuntimeSource(includePreparedArtifacts);
  if (runtimeIsReady(signature)) {
    writeLog('Runtime artifacts and dependencies are ready; skipping dependency install.');
    return;
  }
  if (runtimeFilesReady()) {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ sourceSignature: signature, preparedAt: new Date().toISOString(), mode: 'self-contained' }, null, 2),
    );
    writeLog('Self-contained runtime artifacts are ready; no package-manager setup is required.');
    return;
  }

  throw new Error(
    'Packaged runtime artifacts are missing. Reinstall Liclick 3D Texture from a source-free production installer.',
  );
}

function requestText(url, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ ok: res.statusCode ? res.statusCode < 500 : false, body }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, body: '' });
    });
    req.on('error', () => resolve({ ok: false, body: '' }));
  });
}

async function workspaceHealthy() {
  const result = await requestText(`${workspaceUrl}/api/health`);
  if (!result.ok) return false;
  try {
    return JSON.parse(result.body)?.ok === true;
  } catch {
    return false;
  }
}

async function webHealthy() {
  const result = await requestText(webUrl);
  return result.ok && /Liclick|3D Texture|root/i.test(result.body);
}

async function waitFor(check, label, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return true;
    await sleep(500);
  }
  throw new Error(`${label} did not become ready within ${Math.round(timeoutMs / 1000)} seconds.`);
}

function getPortOwners(port) {
  if (!isWindows) return [];
  const script = [
    `$items = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`,
    '$items | Select-Object -ExpandProperty OwningProcess -Unique',
  ].join('; ');
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
  });
  return `${result.stdout}\n${result.stderr}`
    .match(/\b\d+\b/g)
    ?.map(Number)
    .filter((pid) => pid > 0) ?? [];
}

async function startServices() {
  if (await workspaceHealthy()) {
    writeLog(`Existing healthy Liclick workspace server found at ${workspaceUrl}; reusing it.`);
  } else {
    const owners = getPortOwners(workspacePort);
    if (owners.length > 0) {
      throw new Error(
        `Port ${workspacePort} is occupied by another process (PID: ${owners.join(
          ', ',
        )}). Close that process and launch Liclick again.`,
      );
    }
    spawnService('workspace server', 'node', ['apps/server/dist/index.js'], serverLog);
    await waitFor(workspaceHealthy, 'Workspace server');
  }

  if (await webHealthy()) {
    writeLog(`Existing Liclick web server found at ${webUrl}; reusing it.`);
  } else {
    const owners = getPortOwners(webPort);
    if (owners.length > 0) {
      throw new Error(
        `Port ${webPort} is occupied by another process (PID: ${owners.join(
          ', ',
        )}). Close that process and launch Liclick again.`,
      );
    }
    spawnService('web server', 'node', ['scripts/windows-static-web-server.mjs'], webLog);
    await waitFor(webHealthy, 'Web server');
  }
}

function openBrowser() {
  writeLog(`Opening browser: ${webUrl}`);
  if (isWindows) {
    spawn('cmd', ['/c', 'start', '', webUrl], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(opener, [webUrl], { detached: true, stdio: 'ignore' }).unref();
}

function killChild(child) {
  if (!child.pid) return;
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Ignore cleanup races.
  }
}

function stopManagedChildren() {
  for (const child of [...managedChildren]) killChild(child);
}

function cleanup() {
  stopManagedChildren();
  launcherLog.end();
}

process.on('SIGINT', () => {
  writeLog('Received Ctrl+C. Stopping Liclick services...');
  cleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  writeLog('Received termination signal. Stopping Liclick services...');
  cleanup();
  process.exit(0);
});
process.on('exit', cleanup);

writeLog('============================================================');
writeLog('Liclick 3D Texture local desktop launcher');
writeLog('正在准备自包含本地运行环境，无需下载 pnpm 或安装服务依赖。');
writeLog('使用软件期间请不要关闭这个终端；关闭终端会停止前后端服务。');
writeLog(`Install root: ${installRoot}`);
writeLog(`Runtime: ${runtimeRoot}`);
writeLog(`Workspace: ${workspaceDir}`);
writeLog(`Logs: ${logsDir}`);
writeLog(`Desktop ports: workspace ${workspacePort}, web ${webPort}. Dev ports remain 4517/5173.`);
writeLog('============================================================');

try {
  await prepareRuntime();
  await startServices();
  if (shouldOpenBrowser) openBrowser();
  writeLog('Liclick 3D Texture is running. Keep this terminal open while using the app.');
  await new Promise(() => undefined);
} catch (error) {
  writeLog(`Startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  cleanup();
  process.exitCode = 1;
}
