const api = window.liclickLauncher;

const elements = {
  primaryLaunch: document.querySelector('#primaryLaunch'),
  primaryLaunchText: document.querySelector('#primaryLaunch span'),
  openWorkspace: document.querySelector('#openWorkspace'),
  quickOpenWorkspace: document.querySelector('#quickOpenWorkspace'),
  restartServices: document.querySelector('#restartServices'),
  stopServices: document.querySelector('#stopServices'),
  openLogs: document.querySelector('#openLogs'),
  openLogsFromView: document.querySelector('#openLogsFromView'),
  diagOpenLogs: document.querySelector('#diagOpenLogs'),
  settingsOpenLogs: document.querySelector('#settingsOpenLogs'),
  openWorkspaceDir: document.querySelector('#openWorkspaceDir'),
  openProjectResources: document.querySelector('#openProjectResources'),
  settingsOpenWorkspaceDir: document.querySelector('#settingsOpenWorkspaceDir'),
  diagRestartServices: document.querySelector('#diagRestartServices'),
  quitLauncher: document.querySelector('#quitLauncher'),
  workspaceStatus: document.querySelector('#workspaceStatus'),
  webStatus: document.querySelector('#webStatus'),
  runtimeStatus: document.querySelector('#runtimeStatus'),
  workspaceUrl: document.querySelector('#workspaceUrl'),
  webUrl: document.querySelector('#webUrl'),
  workspaceDir: document.querySelector('#workspaceDir'),
  settingsWorkspaceDir: document.querySelector('#settingsWorkspaceDir'),
  pidText: document.querySelector('#pidText'),
  runtimeDot: document.querySelector('#runtimeDot'),
  serverDot: document.querySelector('#serverDot'),
  webDot: document.querySelector('#webDot'),
  logOutput: document.querySelector('#logOutput'),
  clearLogs: document.querySelector('#clearLogs'),
  footerBuild: document.querySelector('#footerBuild'),
  sidebarBuild: document.querySelector('#sidebarBuild'),
  connectionTitle: document.querySelector('#connectionTitle'),
  connectionCopy: document.querySelector('#connectionCopy'),
  serviceRuntimeText: document.querySelector('#serviceRuntimeText'),
  serviceWorkspaceText: document.querySelector('#serviceWorkspaceText'),
  serviceWebText: document.querySelector('#serviceWebText'),
  diagRuntimeText: document.querySelector('#diagRuntimeText'),
  diagWorkspaceText: document.querySelector('#diagWorkspaceText'),
  diagWebText: document.querySelector('#diagWebText'),
};

const statusText = {
  online: '已就绪',
  offline: '未运行',
  starting: '启动中',
  unknown: '检查中',
};

const emptyLogText = '等待启动日志...';
let currentState = {
  phase: 'idle',
  message: '启动器已就绪。',
  workspace: 'unknown',
  web: 'unknown',
  workspaceUrl: 'http://127.0.0.1:4617',
  webUrl: 'http://127.0.0.1:5673',
  workspaceDir: '-',
  shellBuild: '2026.07.15.1104',
  logs: [],
};

function setTone(element, tone) {
  if (!element) return;
  element.dataset.tone = tone;
  document.querySelectorAll(`[data-mirror="${element.id}"]`).forEach((mirror) => {
    mirror.dataset.tone = tone;
  });
}

function appendLog(line) {
  if (elements.logOutput.dataset.empty === 'true') {
    elements.logOutput.textContent = '';
    elements.logOutput.dataset.empty = 'false';
  }
  elements.logOutput.textContent += `${line}\n`;
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function renderState(state) {
  currentState = { ...currentState, ...state };
  const running = currentState.phase === 'running';
  const starting = currentState.phase === 'starting';
  const error = currentState.phase === 'error';
  const runtimeReady =
    running || currentState.workspace === 'online' || currentState.web === 'online';

  elements.openWorkspace.disabled = currentState.web !== 'online';
  elements.workspaceStatus.textContent =
    statusText[currentState.workspace] ?? currentState.workspace;
  elements.webStatus.textContent = statusText[currentState.web] ?? currentState.web;
  elements.runtimeStatus.textContent = error
    ? '准备失败'
    : starting && !runtimeReady
      ? '正在同步'
      : runtimeReady
        ? '准备就绪'
        : '等待启动';
  elements.workspaceUrl.textContent = currentState.workspaceUrl;
  elements.webUrl.textContent = currentState.webUrl;
  elements.workspaceDir.textContent = currentState.workspaceDir;
  elements.workspaceDir.title = currentState.workspaceDir;
  elements.settingsWorkspaceDir.textContent = currentState.workspaceDir;
  elements.settingsWorkspaceDir.title = currentState.workspaceDir;
  elements.pidText.textContent = currentState.launcherPid
    ? `PID ${currentState.launcherPid}`
    : '本地服务';
  elements.footerBuild.textContent = currentState.shellBuild
    ? `Build ${currentState.shellBuild}`
    : 'Launcher';
  elements.sidebarBuild.textContent = currentState.shellBuild
    ? `Build ${currentState.shellBuild}`
    : 'Launcher';

  const runtimeLabel = error
    ? '准备失败'
    : starting && !runtimeReady
      ? '正在准备'
      : runtimeReady
        ? '准备就绪'
        : '等待启动';
  const workspaceLabel = statusText[currentState.workspace] ?? currentState.workspace;
  const webLabel = statusText[currentState.web] ?? currentState.web;
  elements.serviceRuntimeText.textContent = runtimeLabel;
  elements.serviceWorkspaceText.textContent = workspaceLabel;
  elements.serviceWebText.textContent = webLabel;
  elements.diagRuntimeText.textContent = runtimeLabel;
  elements.diagWorkspaceText.textContent = workspaceLabel;
  elements.diagWebText.textContent = webLabel;
  elements.connectionTitle.textContent = running
    ? '本地工作区已连接'
    : error
      ? '本地工作区连接失败'
      : starting
        ? '正在连接本地工作区'
        : '本地工作区未连接';
  elements.connectionCopy.textContent = running
    ? '启动器已与本地服务通信，可以正常访问工作台与资源。'
    : error
      ? '请进入“诊断”或“日志”查看失败原因。'
      : starting
        ? '正在检查运行环境与前后端服务，请稍候。'
        : '点击“一键启动”准备本地服务。';

  setTone(
    elements.runtimeDot,
    runtimeReady ? 'online' : error ? 'error' : starting ? 'starting' : 'offline',
  );
  setTone(
    elements.serverDot,
    currentState.workspace === 'online' ? 'online' : starting ? 'starting' : 'offline',
  );
  setTone(
    elements.webDot,
    currentState.web === 'online' ? 'online' : starting ? 'starting' : 'offline',
  );

  elements.primaryLaunch.disabled = starting;
  elements.primaryLaunchText.textContent = starting
    ? '正在启动...'
    : running
      ? '打开工作台'
      : '一键启动';

  if (
    Array.isArray(currentState.logs) &&
    (!elements.logOutput.textContent || elements.logOutput.dataset.empty === 'true')
  ) {
    if (currentState.logs.length > 0) {
      elements.logOutput.textContent = `${currentState.logs.join('\n')}\n`;
      elements.logOutput.dataset.empty = 'false';
    } else {
      elements.logOutput.textContent = emptyLogText;
      elements.logOutput.dataset.empty = 'true';
    }
    elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
  }
}

function showView(viewName) {
  document.querySelectorAll('[data-view-target]').forEach((button) => {
    const active = button.dataset.viewTarget === viewName;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-view]').forEach((view) => {
    view.classList.toggle('is-active', view.dataset.view === viewName);
  });
}

async function safeCall(action, failureMessage) {
  if (!api) {
    appendLog(`[launcher] ${failureMessage}：当前不是 Electron 启动器环境。`);
    return;
  }
  try {
    await action();
  } catch (error) {
    appendLog(
      `[launcher] ${failureMessage}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

document.querySelectorAll('[data-view-target]').forEach((button) => {
  button.addEventListener('click', () => showView(button.dataset.viewTarget));
});

elements.primaryLaunch.addEventListener('click', () => {
  if (currentState.phase === 'running' || currentState.web === 'online') {
    void safeCall(() => api.openWorkspace(), '无法打开工作台');
    return;
  }
  void safeCall(() => api.start(), '无法启动服务');
});

elements.openWorkspace.addEventListener(
  'click',
  () => void safeCall(() => api.openWorkspace(), '无法打开工作台'),
);
elements.quickOpenWorkspace.addEventListener('click', () => {
  if (currentState.web === 'online') void safeCall(() => api.openWorkspace(), '无法打开工作台');
  else void safeCall(() => api.start(), '无法启动服务');
});
elements.restartServices.addEventListener(
  'click',
  () => void safeCall(() => api.restart(), '无法重启服务'),
);
elements.stopServices.addEventListener(
  'click',
  () => void safeCall(() => api.stop(), '无法停止服务'),
);
elements.openLogs.addEventListener(
  'click',
  () => void safeCall(() => api.openLogs(), '无法打开日志目录'),
);
elements.openLogsFromView.addEventListener(
  'click',
  () => void safeCall(() => api.openLogs(), '无法打开日志目录'),
);
elements.diagOpenLogs.addEventListener(
  'click',
  () => void safeCall(() => api.openLogs(), '无法打开日志目录'),
);
elements.settingsOpenLogs.addEventListener(
  'click',
  () => void safeCall(() => api.openLogs(), '无法打开日志目录'),
);
elements.openWorkspaceDir.addEventListener(
  'click',
  () => void safeCall(() => api.openWorkspaceDir(), '无法打开工作目录'),
);
elements.openProjectResources.addEventListener(
  'click',
  () => void safeCall(() => api.openWorkspaceDir(), '无法打开项目资源'),
);
elements.settingsOpenWorkspaceDir.addEventListener(
  'click',
  () => void safeCall(() => api.openWorkspaceDir(), '无法打开工作目录'),
);
elements.diagRestartServices.addEventListener(
  'click',
  () => void safeCall(() => api.restart(), '无法重新检查服务'),
);
elements.quitLauncher.addEventListener('click', () => {
  if (!window.confirm('确定要停止本地服务并彻底退出 LI3D 启动器吗？')) return;
  void safeCall(() => api.quit(), '无法退出启动器');
});
elements.clearLogs.addEventListener('click', () => {
  elements.logOutput.textContent = emptyLogText;
  elements.logOutput.dataset.empty = 'true';
});

if (api) {
  api.onState(renderState);
  api.onLog(appendLog);
  api
    .getState()
    .then(renderState)
    .catch((error) => {
      renderState({ phase: 'error', message: '无法读取启动器状态。' });
      appendLog(
        `[launcher] 无法读取状态：${error instanceof Error ? error.message : String(error)}`,
      );
    });
} else {
  renderState({
    phase: 'error',
    message: '启动壳通信不可用，请通过 EXE 启动器打开。',
    workspaceDir: 'C:\\Users\\User\\AppData\\Local\\LIclick 3D Texture\\workspace',
  });
  elements.logOutput.textContent =
    '浏览器预览模式：Electron preload 未连接。\n通过 LIclick 3D Texture.exe 启动后，这里会显示实时服务日志。\n';
  elements.logOutput.dataset.empty = 'false';
}
