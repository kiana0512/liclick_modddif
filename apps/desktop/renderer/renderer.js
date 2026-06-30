const api = window.liclickLauncher;

const elements = {
  overallDot: document.querySelector('#overallDot'),
  overallText: document.querySelector('#overallText'),
  openWorkspace: document.querySelector('#openWorkspace'),
  restartServices: document.querySelector('#restartServices'),
  openLogs: document.querySelector('#openLogs'),
  workspaceStatus: document.querySelector('#workspaceStatus'),
  webStatus: document.querySelector('#webStatus'),
  workspaceUrl: document.querySelector('#workspaceUrl'),
  webUrl: document.querySelector('#webUrl'),
  workspaceDir: document.querySelector('#workspaceDir'),
  pidText: document.querySelector('#pidText'),
  runtimeDot: document.querySelector('#runtimeDot'),
  serverDot: document.querySelector('#serverDot'),
  webDot: document.querySelector('#webDot'),
  logOutput: document.querySelector('#logOutput'),
  clearLogs: document.querySelector('#clearLogs'),
  buildText: document.querySelector('#buildText'),
};

const statusText = {
  online: '已就绪',
  offline: '未运行',
  starting: '启动中',
  unknown: '检查中',
};

const emptyLogText = '等待启动日志...';

if (!api) {
  elements.overallText.textContent = '启动壳通信失败，请重新安装或查看日志。';
  setTone(elements.overallDot, 'error');
  elements.logOutput.textContent =
    '启动壳通信失败：window.liclickLauncher 不存在。\n' +
    '这通常表示 Electron preload 没有加载成功，按钮和托盘命令将无法工作。\n';
  elements.logOutput.dataset.empty = 'false';
  throw new Error('Liclick launcher preload bridge is unavailable.');
}

function setTone(element, tone) {
  element.dataset.tone = tone;
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
  const running = state.phase === 'running';
  const starting = state.phase === 'starting';
  const error = state.phase === 'error';

  elements.overallText.textContent = state.message;
  setTone(elements.overallDot, running ? 'online' : error ? 'error' : starting ? 'starting' : 'offline');
  elements.openWorkspace.disabled = state.web !== 'online';
  elements.workspaceStatus.textContent = statusText[state.workspace] ?? state.workspace;
  elements.webStatus.textContent = statusText[state.web] ?? state.web;
  elements.workspaceUrl.textContent = state.workspaceUrl;
  elements.webUrl.textContent = state.webUrl;
  elements.workspaceDir.textContent = state.workspaceDir;
  elements.pidText.textContent = state.launcherPid ? `PID ${state.launcherPid}` : 'PID -';
  elements.buildText.textContent = state.shellBuild ? `Build ${state.shellBuild}` : '';

  setTone(elements.runtimeDot, starting || running ? 'online' : error ? 'error' : 'offline');
  setTone(elements.serverDot, state.workspace === 'online' ? 'online' : starting ? 'starting' : 'offline');
  setTone(elements.webDot, state.web === 'online' ? 'online' : starting ? 'starting' : 'offline');

  if (Array.isArray(state.logs) && (!elements.logOutput.textContent || elements.logOutput.dataset.empty === 'true')) {
    if (state.logs.length > 0) {
      elements.logOutput.textContent = `${state.logs.join('\n')}\n`;
      elements.logOutput.dataset.empty = 'false';
    } else {
      elements.logOutput.textContent = emptyLogText;
      elements.logOutput.dataset.empty = 'true';
    }
    elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
  }
}

elements.openWorkspace.addEventListener('click', () => api.openWorkspace());
elements.restartServices.addEventListener('click', () => api.restart());
elements.openLogs.addEventListener('click', () => api.openLogs());
elements.clearLogs.addEventListener('click', () => {
  elements.logOutput.textContent = emptyLogText;
  elements.logOutput.dataset.empty = 'true';
});

api.onState(renderState);
api.onLog(appendLog);
api.getState().then((state) => {
  renderState(state);
  if (!elements.logOutput.textContent) {
    elements.logOutput.textContent = emptyLogText;
    elements.logOutput.dataset.empty = 'true';
  }
});
