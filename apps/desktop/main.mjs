import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell } from 'electron';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
const appDataRoot = path.join(localAppData, 'Liclick 3D Texture');
const logsDir = path.join(appDataRoot, 'logs');
const workspaceDir = process.env.LICLICK_WORKSPACE_DIR ?? path.join(appDataRoot, 'workspace');
const workspacePort = process.env.LICLICK_WORKSPACE_PORT ?? '4617';
const webPort = process.env.LICLICK_WEB_PORT ?? '5673';
const workspaceUrl = process.env.LICLICK_PUBLIC_WORKSPACE_URL ?? `http://127.0.0.1:${workspacePort}`;
const webUrl = process.env.LICLICK_FRONTEND_URL ?? `http://127.0.0.1:${webPort}`;
const rendererUrl = new URL('./renderer/index.html', import.meta.url);
const iconPath = path.join(appRoot, 'assets', 'liclick-icon.png');
const shellBuild = '2026.06.30.1420';

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
  const web = webResult.ok && /Liclick|3D Texture|root/i.test(webResult.body) ? 'online' : 'offline';
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
  const result = await streamProcess('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bootstrap]);
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
  setState({ phase: 'starting', message: '正在准备 Liclick 本地服务。', startedAt: new Date().toISOString() });
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

    launcherProcess = spawn(nodeExe, [path.join(appRoot, 'scripts', 'windows-desktop-launcher.mjs')], {
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
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
      emitLog(`[desktop] launcher stopped (${signal ? `signal ${signal}` : `exit code ${code ?? 0}`}).`);
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
    spawnSync('taskkill', ['/PID', String(bootstrapProcess.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    bootstrapProcess = undefined;
  }
  if (!launcherProcess?.pid) return;
  emitLog('[desktop] stopping Liclick services...');
  spawnSync('taskkill', ['/PID', String(launcherProcess.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  launcherProcess = undefined;
  setState({ launcherPid: undefined, phase: 'stopped', message: '服务已关闭。', workspace: 'offline', web: 'offline' });
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

function autoOpenWorkspace() {
  if (hasAutoOpenedWorkspace) return;
  hasAutoOpenedWorkspace = true;
  emitLog(`[desktop] opening workspace in browser: ${webUrl}`);
  shell.openExternal(webUrl).catch((error) => emitLog(`[desktop] failed to open workspace: ${error.message}`));
}

function openLogsDir() {
  fs.mkdirSync(logsDir, { recursive: true });
  shell.openPath(logsDir);
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 520,
    minHeight: 420,
    title: 'Liclick 3D Texture',
    icon: iconPath,
    backgroundColor: '#f4f2ec',
    show: false,
    webPreferences: {
      preload: path.join(appRoot, 'apps', 'desktop', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
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
        title: 'Liclick 3D Texture 正在后台运行',
        content: '启动器已收回到系统托盘。需要彻底关闭时，请右键托盘图标选择“彻底关闭”。',
      });
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const status = state.phase === 'running' ? '服务运行中' : state.phase === 'starting' ? '正在启动' : '服务未运行';
  tray.setToolTip(`Liclick 3D Texture - ${status}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: 'separator' },
      { label: '打开启动器', click: showWindow },
      { label: '隐藏启动器', click: () => mainWindow?.hide(), enabled: Boolean(mainWindow?.isVisible()) },
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
    app.setName('Liclick 3D Texture');
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
ipcMain.handle('launcher:open-logs', () => openLogsDir());
ipcMain.handle('launcher:show-window', () => showWindow());
ipcMain.handle('launcher:quit', () => {
  isQuitting = true;
  stopServices();
  app.quit();
});
