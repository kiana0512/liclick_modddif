import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeTheme, shell } from 'electron';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
const appDataRoot = path.join(localAppData, 'Liclick 3D Texture');
const logsDir = path.join(appDataRoot, 'logs');
const localSettingsPath = path.join(appDataRoot, 'config', 'local-settings.json');
const workspaceDir = process.env.LICLICK_WORKSPACE_DIR ?? path.join(appDataRoot, 'workspace');
const workspacePort = process.env.LICLICK_WORKSPACE_PORT ?? '4617';
const webPort = process.env.LICLICK_WEB_PORT ?? '5673';
const workspaceUrl =
  process.env.LICLICK_PUBLIC_WORKSPACE_URL ?? `http://127.0.0.1:${workspacePort}`;
const webUrl = process.env.LICLICK_FRONTEND_URL ?? `http://127.0.0.1:${webPort}`;
const rendererUrl = new URL('./renderer/index.html', import.meta.url);
const iconPath = path.join(appRoot, 'assets', 'liclick-icon.png');
const shellBuild = '2026.07.17.1135';

const state = {
  launcherPid: undefined,
  phase: 'idle',
  message: 'Liclick desktop shell is ready.',
  workspace: 'unknown',
  web: 'unknown',
  logsDir,
  workspaceDir,
  workspacePort,
  webPort,
  workspaceUrl,
  webUrl,
  startedAt: undefined,
  shellBuild,
};

let mainWindow;
let tray;
let launcherProcess;
let bootstrapProcess;
let healthTimer;
let isStarting = false;
let isQuitting = false;
let hasShownTrayHint = false;
let hasAutoOpenedWorkspace = false;
let lastLogLines = [];
let photoshopPluginCache;
let photoshopInstallationsCache;

const defaultLocalSettings = {
  version: 1,
  activeUserId: 'anonymous',
  performanceTestModeEnabled: false,
  performanceTestModeConfigured: false,
  profiles: {},
  shortcutsByUser: {},
  shortcutsConfiguredByUser: {},
  photoshop: {
    executablePath: '',
    preferredVersion: '',
    syncMode: 'live',
    liveSyncDelayMs: 120,
    autoLaunch: true,
    keepSessionFiles: true,
    windowPlacement: 'none',
  },
};

function normalizeLocalUserId(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed && trimmed.length <= 200 ? trimmed : 'anonymous';
}

function normalizeLocalProfile(value) {
  if (!value || typeof value !== 'object') return { customId: '' };
  const customId = typeof value.customId === 'string' ? value.customId.trim().slice(0, 24) : '';
  const avatarDataUrl =
    typeof value.avatarDataUrl === 'string' &&
    /^data:image\/(?:png|jpeg|webp);base64,/i.test(value.avatarDataUrl) &&
    value.avatarDataUrl.length <= 3_000_000
      ? value.avatarDataUrl
      : undefined;
  return { customId, ...(avatarDataUrl ? { avatarDataUrl } : {}) };
}

function normalizeLocalShortcuts(value) {
  if (!value || typeof value !== 'object') return {};
  const result = {};
  for (const [actionId, bindings] of Object.entries(value)) {
    if (!/^[a-z]+(?:\.[A-Za-z]+)+$/.test(actionId) || !Array.isArray(bindings)) continue;
    result[actionId] = bindings
      .flatMap((binding) => {
        if (!binding || typeof binding !== 'object' || typeof binding.code !== 'string') return [];
        return [{
          code: binding.code.slice(0, 80),
          ...(binding.primary === true ? { primary: true } : {}),
          ...(binding.shift === true ? { shift: true } : {}),
          ...(binding.alt === true ? { alt: true } : {}),
        }];
      })
      .slice(0, 4);
  }
  return result;
}

function normalizePhotoshopSettings(value) {
  const defaults = defaultLocalSettings.photoshop;
  if (!value || typeof value !== 'object') return { ...defaults };
  const requestedDelay = Number.isFinite(value.liveSyncDelayMs)
    ? value.liveSyncDelayMs
    : defaults.liveSyncDelayMs;
  return {
    executablePath:
      typeof value.executablePath === 'string' ? value.executablePath.trim().slice(0, 1024) : '',
    preferredVersion:
      typeof value.preferredVersion === 'string' ? value.preferredVersion.trim().slice(0, 100) : '',
    syncMode: value.syncMode === 'save' ? 'save' : 'live',
    liveSyncDelayMs: Math.round(Math.max(80, Math.min(5000, requestedDelay))),
    autoLaunch: value.autoLaunch !== false,
    keepSessionFiles: value.keepSessionFiles !== false,
    windowPlacement: value.windowPlacement === 'side-by-side' ? 'side-by-side' : 'none',
  };
}

function normalizeLocalSettings(value) {
  if (!value || typeof value !== 'object') return structuredClone(defaultLocalSettings);
  const activeUserId = normalizeLocalUserId(value.activeUserId);
  const profiles = Object.fromEntries(
    Object.entries(value.profiles && typeof value.profiles === 'object' ? value.profiles : {})
      .slice(0, 50)
      .map(([userId, profile]) => [normalizeLocalUserId(userId), normalizeLocalProfile(profile)]),
  );
  const shortcutsByUser = Object.fromEntries(
    Object.entries(
      value.shortcutsByUser && typeof value.shortcutsByUser === 'object'
        ? value.shortcutsByUser
        : {},
    )
      .slice(0, 50)
      .map(([userId, shortcuts]) => [normalizeLocalUserId(userId), normalizeLocalShortcuts(shortcuts)]),
  );
  const shortcutsConfiguredByUser = Object.fromEntries(
    Object.entries(
      value.shortcutsConfiguredByUser && typeof value.shortcutsConfiguredByUser === 'object'
        ? value.shortcutsConfiguredByUser
        : {},
    )
      .slice(0, 50)
      .map(([userId, configured]) => [normalizeLocalUserId(userId), configured === true]),
  );
  return {
    version: 1,
    activeUserId,
    performanceTestModeEnabled: value.performanceTestModeEnabled === true,
    performanceTestModeConfigured: value.performanceTestModeConfigured === true,
    profiles,
    shortcutsByUser,
    shortcutsConfiguredByUser,
    photoshop: normalizePhotoshopSettings(value.photoshop),
  };
}

function readLocalSettingsDocument() {
  try {
    return normalizeLocalSettings(JSON.parse(fs.readFileSync(localSettingsPath, 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      emitLog(`[desktop] failed to read local settings: ${error.message}`);
    }
    return structuredClone(defaultLocalSettings);
  }
}

function localSettingsView(document, requestedUserId) {
  const userId = normalizeLocalUserId(requestedUserId ?? document.activeUserId);
  return {
    version: 1,
    activeUserId: userId,
    performanceTestModeEnabled: document.performanceTestModeEnabled,
    performanceTestModeConfigured: document.performanceTestModeConfigured,
    profile: document.profiles[userId] ?? { customId: '' },
    shortcutOverrides: document.shortcutsByUser[userId] ?? {},
    shortcutOverridesConfigured: document.shortcutsConfiguredByUser[userId] === true,
    photoshop: document.photoshop,
  };
}

function getLocalSettings() {
  const document = readLocalSettingsDocument();
  return localSettingsView(document);
}

function updateLocalSettings(input = {}) {
  const document = readLocalSettingsDocument();
  const userId = normalizeLocalUserId(input.userId ?? document.activeUserId);
  if (input.activate === true) document.activeUserId = userId;
  if (typeof input.performanceTestModeEnabled === 'boolean') {
    document.performanceTestModeEnabled = input.performanceTestModeEnabled;
    document.performanceTestModeConfigured = true;
  }
  if (input.profile !== undefined) document.profiles[userId] = normalizeLocalProfile(input.profile);
  if (input.shortcutOverrides !== undefined) {
    document.shortcutsByUser[userId] = normalizeLocalShortcuts(input.shortcutOverrides);
    document.shortcutsConfiguredByUser[userId] = true;
  }
  if (input.photoshop !== undefined) document.photoshop = normalizePhotoshopSettings(input.photoshop);
  fs.mkdirSync(path.dirname(localSettingsPath), { recursive: true });
  fs.writeFileSync(localSettingsPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  const view = localSettingsView(document, userId);
  mainWindow?.webContents.send('launcher:local-settings', view);
  return view;
}

function emitLog(line) {
  const text = String(line).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const part of text.split('\n')) {
    if (!part) continue;
    lastLogLines.push(part);
    if (lastLogLines.length > 600) lastLogLines = lastLogLines.slice(-600);
    mainWindow?.webContents.send('launcher:log', part);
  }
}

function setState(patch) {
  const wasRunning = state.workspace === 'online' && state.web === 'online';
  Object.assign(state, patch);
  mainWindow?.webContents.send('launcher:state', snapshot());
  updateTrayMenu();
  const isRunning = state.workspace === 'online' && state.web === 'online';
  if (!wasRunning && isRunning) {
    autoOpenWorkspace();
  }
}

function snapshot() {
  return { ...state, logs: lastLogLines };
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

async function requestWorkspaceJson(pathname, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 8000);
  try {
    const response = await fetch(`${workspaceUrl}${pathname}`, {
      method: init.method ?? 'GET',
      headers: init.body ? { 'content-type': 'application/json' } : undefined,
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error ?? `Workspace request failed: ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function runBuffered(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? appRoot,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => resolve({ status: 1, stdout, stderr: error.message }));
    child.on('exit', (code) => resolve({ status: code ?? 0, stdout, stderr }));
  });
}

function streamProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? appRoot,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => emitLog(chunk));
    child.stderr?.on('data', (chunk) => emitLog(chunk));
    child.on('error', (error) => resolve({ status: 1, error }));
    child.on('exit', (code, signal) => resolve({ status: code ?? 0, signal }));
    bootstrapProcess = child;
  }).finally(() => {
    bootstrapProcess = undefined;
  });
}

async function checkHealth() {
  const [workspaceResult, webResult] = await Promise.all([
    requestText(`${workspaceUrl}/api/health`),
    requestText(webUrl),
  ]);
  let workspace = 'offline';
  if (workspaceResult.ok) {
    try {
      workspace = JSON.parse(workspaceResult.body)?.ok === true ? 'online' : 'starting';
    } catch {
      workspace = 'starting';
    }
  }
  const web =
    webResult.ok && /Liclick|3D Texture|root/i.test(webResult.body) ? 'online' : 'offline';
  const phase =
    workspace === 'online' && web === 'online'
      ? 'running'
      : launcherProcess || bootstrapProcess || isStarting
        ? 'starting'
        : 'stopped';
  const message =
    phase === 'running'
      ? '前后端服务已就绪，可以打开工作台。'
      : phase === 'starting'
        ? '正在检查并启动本地服务。'
        : workspace === 'online'
          ? '后端已就绪，前端工作台尚未启动。'
          : web === 'online'
            ? '前端已响应，正在等待后端服务。'
            : '服务未运行。';
  setState({ workspace, web, phase, message });
}

function startHealthPolling() {
  clearInterval(healthTimer);
  healthTimer = setInterval(() => {
    checkHealth().catch((error) => emitLog(`[desktop] health check failed: ${error.message}`));
  }, 1500);
  checkHealth().catch((error) => emitLog(`[desktop] health check failed: ${error.message}`));
}

async function resolveNodeExe() {
  const installNode = path.join(appRoot, 'node', 'node.exe');
  emitLog(`[desktop] checking bundled Node: ${installNode}`);
  if (fs.existsSync(installNode)) {
    emitLog('[desktop] bundled Node runtime found.');
    return installNode;
  }

  const localNode = path.join(appDataRoot, 'node', 'node.exe');
  emitLog(`[desktop] checking user Node runtime: ${localNode}`);
  if (fs.existsSync(localNode)) {
    emitLog('[desktop] user Node runtime found.');
    return localNode;
  }

  emitLog('[desktop] checking system Node from PATH...');
  const whereNode = await runBuffered('where', ['node']);
  const firstNode = whereNode.stdout
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (whereNode.status === 0 && firstNode) {
    emitLog(`[desktop] system Node found: ${firstNode}`);
    return firstNode;
  }

  const bootstrap = path.join(appRoot, 'scripts', 'windows-node-bootstrap.ps1');
  if (!fs.existsSync(bootstrap)) {
    emitLog(`[desktop] Node bootstrap script was not found: ${bootstrap}`);
    return undefined;
  }
  setState({ phase: 'starting', message: '首次启动正在准备本地 Node 运行时，窗口仍可正常操作。' });
  emitLog('[desktop] Node.js was not found. Installing local runtime asynchronously...');
  const result = await streamProcess('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    bootstrap,
  ]);
  if (result.status !== 0) return undefined;
  return fs.existsSync(localNode) ? localNode : undefined;
}

async function startServices() {
  if (isStarting) {
    showWindow();
    return;
  }
  if (launcherProcess) {
    showWindow();
    return;
  }

  isStarting = true;
  setState({
    phase: 'starting',
    message: '正在准备 Liclick 本地服务。',
    startedAt: new Date().toISOString(),
  });
  emitLog('[desktop] starting Liclick desktop service flow...');
  emitLog(`[desktop] install root: ${appRoot}`);
  emitLog(`[desktop] logs: ${logsDir}`);
  emitLog(`[desktop] workspace: ${workspaceDir}`);
  emitLog(`[desktop] ports: workspace ${workspacePort}, web ${webPort}`);
  try {
    const nodeExe = await resolveNodeExe();
    if (!nodeExe) {
      setState({
        phase: 'error',
        message: '无法准备 Node 运行时，请查看日志后重新启动。',
        workspace: 'offline',
        web: 'offline',
      });
      return;
    }

    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    setState({ phase: 'starting', message: '正在启动 Liclick 本地服务。' });
    emitLog(`[desktop] launching services with ${nodeExe}`);

    launcherProcess = spawn(
      nodeExe,
      [path.join(appRoot, 'scripts', 'windows-desktop-launcher.mjs')],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          LICLICK_OPEN_BROWSER: '0',
          LICLICK_WINDOWS_HIDE: '1',
          LICLICK_WORKSPACE_PORT: workspacePort,
          LICLICK_WEB_PORT: webPort,
          LICLICK_PUBLIC_WORKSPACE_URL: workspaceUrl,
          VITE_LICLICK_WORKSPACE_API: workspaceUrl,
          LICLICK_FRONTEND_URL: webUrl,
          LICLICK_WORKSPACE_DIR: workspaceDir,
          LICLICK_LOCAL_SETTINGS_PATH: localSettingsPath,
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    setState({ launcherPid: launcherProcess.pid });
    emitLog(`[desktop] launcher PID: ${launcherProcess.pid}`);
    launcherProcess.stdout?.on('data', (chunk) => emitLog(chunk));
    launcherProcess.stderr?.on('data', (chunk) => emitLog(chunk));
    launcherProcess.on('error', (error) => {
      emitLog(`[desktop] launcher failed: ${error.message}`);
      launcherProcess = undefined;
      setState({ launcherPid: undefined, phase: 'error', message: error.message });
    });
    launcherProcess.on('exit', (code, signal) => {
      emitLog(
        `[desktop] launcher stopped (${signal ? `signal ${signal}` : `exit code ${code ?? 0}`}).`,
      );
      launcherProcess = undefined;
      setState({
        launcherPid: undefined,
        phase: isQuitting ? 'stopped' : 'error',
        message: isQuitting ? '服务已关闭。' : '本地服务已停止，请查看日志。',
        workspace: 'offline',
        web: 'offline',
      });
    });
  } finally {
    isStarting = false;
  }
}

function stopServices() {
  if (bootstrapProcess?.pid) {
    emitLog('[desktop] stopping runtime preparation...');
    spawnSync('taskkill', ['/PID', String(bootstrapProcess.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    bootstrapProcess = undefined;
  }
  if (!launcherProcess?.pid) return;
  emitLog('[desktop] stopping Liclick services...');
  spawnSync('taskkill', ['/PID', String(launcherProcess.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  launcherProcess = undefined;
  setState({
    launcherPid: undefined,
    phase: 'stopped',
    message: '服务已关闭。',
    workspace: 'offline',
    web: 'offline',
  });
}

function restartServices() {
  hasAutoOpenedWorkspace = false;
  stopServices();
  setTimeout(() => {
    startServices().catch((error) => emitLog(`[desktop] restart failed: ${error.message}`));
  }, 600);
}

function openWorkspace() {
  shell.openExternal(webUrl);
}

function openWorkspaceDir() {
  fs.mkdirSync(workspaceDir, { recursive: true });
  shell.openPath(workspaceDir);
}

function autoOpenWorkspace() {
  if (hasAutoOpenedWorkspace) return;
  hasAutoOpenedWorkspace = true;
  emitLog(`[desktop] opening workspace in browser: ${webUrl}`);
  shell
    .openExternal(webUrl)
    .catch((error) => emitLog(`[desktop] failed to open workspace: ${error.message}`));
}

function openLogsDir() {
  fs.mkdirSync(logsDir, { recursive: true });
  shell.openPath(logsDir);
}

async function choosePhotoshopExecutable() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Adobe Photoshop',
    properties: ['openFile'],
    defaultPath: 'C:\\Program Files\\Adobe',
    filters: [{ name: 'Adobe Photoshop', extensions: ['exe'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return { canceled: false, executablePath: result.filePaths[0] };
}

function photoshopPluginDirectories() {
  const roamingAppData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return {
    destination: path.join(
      roamingAppData,
      'Adobe',
      'CEP',
      'extensions',
      'com.liclick.live-texture',
    ),
    candidates: [
      path.join(appRoot, 'plugins', 'photoshop-cep'),
      path.join(appRoot, 'integrations', 'photoshop-cep'),
    ],
  };
}

function photoshopPluginVersion(manifestPath) {
  try {
    const manifest = fs.readFileSync(manifestPath, 'utf8');
    return manifest.match(/ExtensionBundleVersion="([^"]+)"/i)?.[1] ?? '';
  } catch {
    return '';
  }
}

function isCepDebugModeEnabled() {
  if (process.platform !== 'win32') return true;
  return ['10', '11', '12'].some((version) => {
    const result = spawnSync(
      'reg.exe',
      ['query', `HKCU\\Software\\Adobe\\CSXS.${version}`, '/v', 'PlayerDebugMode'],
      { windowsHide: true, encoding: 'utf8' },
    );
    return result.status === 0 && /PlayerDebugMode\s+REG_SZ\s+1/i.test(result.stdout ?? '');
  });
}

function getPhotoshopPluginInstallation(force = false) {
  if (!force && photoshopPluginCache && Date.now() - photoshopPluginCache.checkedAt < 15_000) {
    return photoshopPluginCache.value;
  }
  const { destination, candidates } = photoshopPluginDirectories();
  const installedManifest = path.join(destination, 'CSXS', 'manifest.xml');
  const bundledSource = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'CSXS', 'manifest.xml')),
  );
  const value = {
    installed: fs.existsSync(installedManifest),
    destination,
    version: photoshopPluginVersion(installedManifest),
    bundled: Boolean(bundledSource),
    bundledVersion: bundledSource
      ? photoshopPluginVersion(path.join(bundledSource, 'CSXS', 'manifest.xml'))
      : '',
    debugModeEnabled: isCepDebugModeEnabled(),
  };
  photoshopPluginCache = { checkedAt: Date.now(), value };
  return value;
}

function photoshopVersionFromPath(executablePath) {
  const folder = path.basename(path.dirname(executablePath));
  return folder.match(/Photoshop\s+(.+)$/i)?.[1]?.trim() ?? '';
}

function detectLocalPhotoshopInstallations(force = false) {
  const configuredPath = getLocalSettings().photoshop?.executablePath ?? '';
  const cacheKey = `${configuredPath.toLowerCase()}|${process.env.LICLICK_PHOTOSHOP_PATH ?? ''}`;
  if (
    !force &&
    photoshopInstallationsCache?.key === cacheKey &&
    Date.now() - photoshopInstallationsCache.checkedAt < 15_000
  ) {
    return photoshopInstallationsCache.value;
  }

  const candidates = [];
  const append = (executablePath, source) => {
    if (typeof executablePath !== 'string' || !executablePath.trim()) return;
    candidates.push({ executablePath: executablePath.trim().replace(/^"|"$/g, ''), source });
  };
  append(configuredPath, 'settings');
  append(process.env.LICLICK_PHOTOSHOP_PATH, 'environment');

  if (process.platform === 'win32') {
    for (const registryKey of [
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Photoshop.exe',
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Photoshop.exe',
    ]) {
      const result = spawnSync('reg.exe', ['query', registryKey, '/ve'], {
        windowsHide: true,
        encoding: 'utf8',
      });
      const registryPath = (result.stdout ?? '').match(/REG_SZ\s+(.+?Photoshop\.exe)\s*$/im)?.[1];
      append(registryPath, 'registry');
    }
  }

  for (const programFiles of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (!programFiles) continue;
    const adobeRoot = path.join(programFiles, 'Adobe');
    try {
      for (const entry of fs.readdirSync(adobeRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && /^Adobe Photoshop/i.test(entry.name)) {
          append(path.join(adobeRoot, entry.name, 'Photoshop.exe'), 'filesystem');
        }
      }
    } catch {
      // Adobe may not be installed under this Program Files root.
    }
  }

  const unique = new Map();
  for (const candidate of candidates) {
    const executablePath = path.resolve(candidate.executablePath);
    try {
      if (!fs.statSync(executablePath).isFile()) continue;
    } catch {
      continue;
    }
    const key = executablePath.toLowerCase();
    if (unique.has(key)) continue;
    const label = path.basename(path.dirname(executablePath)) || 'Adobe Photoshop';
    unique.set(key, {
      id: key,
      label,
      version: photoshopVersionFromPath(executablePath),
      executablePath,
      source: candidate.source,
      selected: configuredPath
        ? key === path.resolve(configuredPath).toLowerCase()
        : false,
    });
  }
  const value = [...unique.values()].sort((left, right) =>
    right.version.localeCompare(left.version, undefined, { numeric: true }),
  );
  if (!value.some((installation) => installation.selected) && value[0]) value[0].selected = true;
  photoshopInstallationsCache = { key: cacheKey, checkedAt: Date.now(), value };
  return value;
}

async function getPhotoshopStatus() {
  const localPlugin = getPhotoshopPluginInstallation();
  const localInstallations = detectLocalPhotoshopInstallations();
  try {
    const serverStatus = await requestWorkspaceJson('/api/photoshop/status');
    const installations = serverStatus.installations?.length
      ? serverStatus.installations
      : localInstallations;
    return {
      ...serverStatus,
      installations,
      selectedInstallation:
        serverStatus.selectedInstallation ?? installations.find((installation) => installation.selected),
      serverAvailable: true,
      localPlugin,
    };
  } catch (error) {
    return {
      protocolVersion: 'offline',
      plugin: { connected: false },
      installations: localInstallations,
      selectedInstallation: localInstallations.find((installation) => installation.selected),
      activeSessions: 0,
      serverAvailable: false,
      localPlugin,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function installPhotoshopPlugin() {
  const { candidates, destination } = photoshopPluginDirectories();
  const sourceDirectory = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'CSXS', 'manifest.xml')),
  );
  if (!sourceDirectory) throw new Error('Photoshop 本地桥接插件尚未包含在当前版本中。');

  const extensionParent = path.dirname(destination);
  const temporary = `${destination}.installing-${process.pid}`;
  fs.mkdirSync(extensionParent, { recursive: true });
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.cpSync(sourceDirectory, temporary, { recursive: true });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(temporary, destination);

  if (process.platform === 'win32') {
    for (const version of ['10', '11', '12']) {
      const result = spawnSync(
        'reg.exe',
        [
          'add',
          `HKCU\\Software\\Adobe\\CSXS.${version}`,
          '/v',
          'PlayerDebugMode',
          '/t',
          'REG_SZ',
          '/d',
          '1',
          '/f',
        ],
        { windowsHide: true, encoding: 'utf8' },
      );
      if (result.status !== 0) {
        throw new Error(result.stderr?.trim() || `无法启用 Adobe CEP ${version} 本地插件模式。`);
      }
    }
  }

  photoshopPluginCache = undefined;
  return { ...getPhotoshopPluginInstallation(true), restartRequired: true };
}

function launchPhotoshopFromLauncher() {
  const installations = detectLocalPhotoshopInstallations(true);
  const selected = installations.find((installation) => installation.selected) ?? installations[0];
  if (!selected) {
    throw new Error('未检测到 Photoshop。请在高级设置中选择 Photoshop.exe 并保存。');
  }
  const child = spawn(selected.executablePath, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  emitLog(`[desktop] launching Photoshop: ${selected.executablePath}`);
  return { installation: selected };
}

function openPhotoshopBackups() {
  const directory = path.join(workspaceDir, 'photoshop-sessions');
  fs.mkdirSync(directory, { recursive: true });
  return shell.openPath(directory);
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: 'LIclick 3D Texture',
    icon: iconPath,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#101014',
      symbolColor: '#f4f4f6',
      height: 40,
    },
    backgroundColor: '#0d0d10',
    show: false,
    webPreferences: {
      preload: path.join(appRoot, 'apps', 'desktop', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== rendererUrl.href) event.preventDefault();
  });
  mainWindow.loadURL(rendererUrl.href);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.webContents.send('launcher:state', snapshot());
  });
  mainWindow.on('close', async (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    if (!hasShownTrayHint) {
      hasShownTrayHint = true;
      tray?.displayBalloon?.({
        title: 'LIclick 3D Texture 正在后台运行',
        content: '启动器已收回到系统托盘。需要彻底关闭时，请右键托盘图标选择“彻底关闭”。',
      });
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const status =
    state.phase === 'running'
      ? '服务运行中'
      : state.phase === 'starting'
        ? '正在启动'
        : '服务未运行';
  tray.setToolTip(`LIclick 3D Texture - ${status}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: 'separator' },
      { label: '打开启动器', click: showWindow },
      {
        label: '隐藏启动器',
        click: () => mainWindow?.hide(),
        enabled: Boolean(mainWindow?.isVisible()),
      },
      { label: '打开工作台', click: openWorkspace, enabled: state.web === 'online' },
      { label: '打开日志目录', click: openLogsDir },
      { type: 'separator' },
      { label: '重启服务', click: restartServices },
      {
        label: '彻底关闭',
        click: () => {
          isQuitting = true;
          stopServices();
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  tray = new Tray(iconPath);
  tray.on('click', showWindow);
  updateTrayMenu();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    app.setName('LIclick 3D Texture');
    nativeTheme.themeSource = 'dark';
    Menu.setApplicationMenu(null);
    createWindow();
    createTray();
    startHealthPolling();
    startServices().catch((error) => emitLog(`[desktop] startup failed: ${error.message}`));
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  stopServices();
});

app.on('window-all-closed', () => {
  // Keep the tray process alive after the visible window is hidden or closed.
});

ipcMain.handle('launcher:get-state', () => snapshot());
ipcMain.handle('launcher:start', () => startServices());
ipcMain.handle('launcher:restart', () => restartServices());
ipcMain.handle('launcher:stop', () => stopServices());
ipcMain.handle('launcher:open-workspace', () => openWorkspace());
ipcMain.handle('launcher:open-workspace-dir', () => openWorkspaceDir());
ipcMain.handle('launcher:open-logs', () => openLogsDir());
ipcMain.handle('launcher:get-local-settings', () => getLocalSettings());
ipcMain.handle('launcher:update-local-settings', (_event, input) => updateLocalSettings(input));
ipcMain.handle('launcher:get-photoshop-status', () => getPhotoshopStatus());
ipcMain.handle('launcher:launch-photoshop', () => launchPhotoshopFromLauncher());
ipcMain.handle('launcher:choose-photoshop-executable', () => choosePhotoshopExecutable());
ipcMain.handle('launcher:install-photoshop-plugin', () => installPhotoshopPlugin());
ipcMain.handle('launcher:open-photoshop-backups', () => openPhotoshopBackups());
ipcMain.handle('launcher:show-window', () => showWindow());
ipcMain.handle('launcher:quit', () => {
  isQuitting = true;
  stopServices();
  app.quit();
});
