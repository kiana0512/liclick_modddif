const api = window.liclickLauncher;

const elements = {
  headerVersion: document.querySelector('#headerVersion'),
  headerStatusDot: document.querySelector('#headerStatusDot'),
  primaryLaunch: document.querySelector('#primaryLaunch'),
  primaryLaunchText: document.querySelector('#primaryLaunchText'),
  heroState: document.querySelector('#heroState'),
  heroStateText: document.querySelector('#heroStateText'),
  currentVersion: document.querySelector('#currentVersion'),
  currentBuild: document.querySelector('#currentBuild'),
  checkUpdates: document.querySelector('#checkUpdates'),
  updateMessage: document.querySelector('#updateMessage'),
  webStatus: document.querySelector('#webStatus'),
  webStatusDot: document.querySelector('#webStatusDot'),
  workspaceStatus: document.querySelector('#workspaceStatus'),
  workspaceStatusDot: document.querySelector('#workspaceStatusDot'),
  bakerStatus: document.querySelector('#bakerStatus'),
  bakerStatusDot: document.querySelector('#bakerStatusDot'),
  photoshopHomeStatus: document.querySelector('#photoshopHomeStatus'),
  photoshopStatusDot: document.querySelector('#photoshopStatusDot'),
  workspacePath: document.querySelector('#workspacePath'),
  settingsWorkspacePath: document.querySelector('#settingsWorkspacePath'),
  autoStartServices: document.querySelector('#autoStartServices'),
  closeToTray: document.querySelector('#closeToTray'),
  photoshopDetail: document.querySelector('#photoshopDetail'),
  photoshopSettingsStatus: document.querySelector('#photoshopSettingsStatus'),
  bakerDetail: document.querySelector('#bakerDetail'),
  bakerSettingsStatus: document.querySelector('#bakerSettingsStatus'),
  openSubstanceInstall: document.querySelector('#openSubstanceInstall'),
  launchPhotoshop: document.querySelector('#launchPhotoshop'),
  installPhotoshopPlugin: document.querySelector('#installPhotoshopPlugin'),
  maintenanceStatus: document.querySelector('#maintenanceStatus'),
  toast: document.querySelector('#toast'),
  authGate: document.querySelector('#authGate'),
  authGateMessage: document.querySelector('#authGateMessage'),
  authGateLogin: document.querySelector('#authGateLogin'),
  authGateLoginText: document.querySelector('#authGateLoginText'),
  authGateLater: document.querySelector('#authGateLater'),
};

const previewState = {
  phase: 'running',
  workspace: 'online',
  web: 'online',
  baker: 'online',
  bakerVersion: '15.0.1',
  workspaceDir: 'C:\\Users\\User\\AppData\\Local\\Li3D\\workspace',
  appVersion: '0.1.3',
  shellBuild: '2026.07.22.1130',
};

let currentState = previewState;
let currentSettings = {
  autoStartServices: true,
  closeToTray: true,
};
let photoshopStatus = {
  serverAvailable: true,
  plugin: { connected: false },
  installations: [{ label: 'Adobe Photoshop', version: '2021' }],
  selectedInstallation: { label: 'Adobe Photoshop', version: '2021' },
  localPlugin: { installed: true },
};
let toastTimer;
let settingsSaveInFlight = false;
let launchInFlight = false;
let authInFlight = false;
let authGateDismissed = false;
let currentAuth = { authenticated: false, pending: true };

const sleep = (duration) => new Promise((resolve) => window.setTimeout(resolve, duration));

function isWorkspaceReady(state = currentState) {
  return state.workspace === 'online' && state.web === 'online';
}

function statusClass(value) {
  if (value === 'online' || value === 'running') return 'online';
  if (value === 'starting' || value === 'unknown') return 'warning';
  return 'offline';
}

function componentLabel(value, readyText = '已就绪') {
  if (value === 'online') return readyText;
  if (value === 'starting' || value === 'unknown') return '检查中';
  if (value === 'missing') return '未安装';
  return '未运行';
}

function setStatusDot(element, value) {
  element?.classList.remove('online', 'warning', 'offline');
  element?.classList.add(statusClass(value));
}

function renderAuth(auth = currentAuth) {
  currentAuth = { ...currentAuth, ...auth };
  const authenticated = currentAuth.authenticated === true || currentState.auth === 'authenticated';
  const signingIn = authInFlight || currentState.auth === 'signing-in';
  const servicesReady = isWorkspaceReady();

  elements.authGateLogin.disabled = signingIn;
  elements.authGateLoginText.textContent = signingIn ? '等待登录完成…' : '登录 Li3D';
  elements.authGateMessage.textContent = signingIn
    ? '授权页面已经打开，请完成登录。成功后启动器会自动继续。'
    : '登录状态会安全保存在这台电脑上。以后从启动器打开 Li3D，无需重复登录。';
  elements.authGate.hidden = authenticated || authGateDismissed || !servicesReady || currentAuth.pending === true;
}

function renderState(nextState) {
  currentState = { ...currentState, ...nextState };
  const ready = currentState.workspace === 'online' && currentState.web === 'online';
  const starting = currentState.phase === 'starting';
  const version = currentState.appVersion ?? '0.1.3';
  window.queueMicrotask(() =>
    renderAuth({
      authenticated: currentState.auth === 'authenticated',
      pending: currentState.auth === 'checking' && currentAuth.pending,
      user: currentState.authUser,
    }),
  );

  elements.headerVersion.textContent = `v${version}`;
  elements.currentVersion.textContent = `Li3D ${version}`;
  elements.currentBuild.textContent = `Build ${currentState.shellBuild ?? '本地开发版'}`;
  elements.workspacePath.textContent = currentState.workspaceDir || '本地工作区';
  elements.settingsWorkspacePath.textContent = currentState.workspaceDir || '本地工作区';

  elements.webStatus.textContent = componentLabel(currentState.web, '可以打开');
  elements.workspaceStatus.textContent = componentLabel(currentState.workspace, '运行正常');
  elements.bakerStatus.textContent = componentLabel(currentState.baker, '已安装');
  setStatusDot(elements.webStatusDot, currentState.web);
  setStatusDot(elements.workspaceStatusDot, currentState.workspace);
  setStatusDot(elements.bakerStatusDot, currentState.baker);
  setStatusDot(elements.headerStatusDot, ready ? 'online' : starting ? 'starting' : 'offline');

  elements.heroState.classList.remove('online', 'warning', 'offline');
  elements.heroState.classList.add(ready ? 'online' : starting ? 'warning' : 'offline');
  elements.heroStateText.textContent = ready
    ? '本地工作区已连接'
    : starting
      ? '正在准备 Li3D'
      : 'Li3D 服务尚未启动';

  // 自动启动服务时仍允许用户点击。点击后会进入“等待就绪并打开工作台”的完整流程。
  elements.primaryLaunch.disabled = launchInFlight;
  elements.primaryLaunch.classList.toggle('is-launching', launchInFlight);
  elements.primaryLaunch.setAttribute('aria-busy', String(launchInFlight));
  elements.primaryLaunchText.textContent = ready
    ? '打开 Li3D'
    : starting || launchInFlight
      ? '正在准备…'
      : '启动 Li3D';
  elements.primaryLaunch.setAttribute(
    'aria-label',
    ready ? '打开 Li3D' : starting || launchInFlight ? '正在准备 Li3D' : '启动 Li3D',
  );

  elements.bakerSettingsStatus.className = `component-state ${statusClass(currentState.baker)}`;
  elements.bakerSettingsStatus.textContent = componentLabel(currentState.baker, '已安装');
  elements.bakerDetail.textContent =
    currentState.baker === 'online'
      ? `版本 ${currentState.bakerVersion || '已检测'} · 用于一键烘焙贴图`
      : currentState.baker === 'missing'
        ? '未检测到 Adobe Substance 3D Baker'
        : '用于一键烘焙贴图';
  elements.openSubstanceInstall.textContent =
    currentState.baker === 'online' ? '查看状态' : '获取组件';
  elements.maintenanceStatus.textContent = ready
    ? '当前服务运行正常，通常不需要手动维护。'
    : starting
      ? 'Li3D 正在准备本地服务，请稍候。'
      : '服务尚未运行，可在这里重启或查看日志。';
}

function renderSettings(settings) {
  currentSettings = { ...currentSettings, ...settings };
  elements.autoStartServices.checked = currentSettings.autoStartServices !== false;
  elements.closeToTray.checked = currentSettings.closeToTray !== false;
}

function renderPhotoshop(status) {
  photoshopStatus = status ?? photoshopStatus;
  const installation =
    photoshopStatus.selectedInstallation ?? photoshopStatus.installations?.[0];
  const installed = Boolean(installation);
  const pluginInstalled = photoshopStatus.localPlugin?.installed === true;
  const connected = photoshopStatus.plugin?.connected === true;
  const displayState = connected
    ? '已连接'
    : installed && pluginInstalled
      ? '插件已安装'
      : installed
        ? '需要安装插件'
        : '未检测到';
  const displayClass = connected || (installed && pluginInstalled) ? 'online' : installed ? 'warning' : '';

  elements.photoshopHomeStatus.textContent = displayState;
  setStatusDot(elements.photoshopStatusDot, connected || (installed && pluginInstalled) ? 'online' : installed ? 'starting' : 'offline');
  elements.photoshopSettingsStatus.className = `component-state ${displayClass}`;
  elements.photoshopSettingsStatus.textContent = displayState;
  elements.photoshopDetail.textContent = installed
    ? `${installation.label || 'Adobe Photoshop'} ${installation.version || ''} · ${pluginInstalled ? '实时编辑组件可用' : '安装插件后可实时编辑'}`
    : '本机未检测到 Adobe Photoshop';
  elements.launchPhotoshop.disabled = !installed;
  elements.installPhotoshopPlugin.disabled = !photoshopStatus.localPlugin?.bundled && !pluginInstalled;
  elements.installPhotoshopPlugin.textContent = pluginInstalled ? '修复插件' : '安装插件';
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3600);
}

function showView(viewName) {
  document.querySelectorAll('[data-view]').forEach((view) => {
    const active = view.dataset.view === viewName;
    view.hidden = !active;
    view.classList.toggle('is-active', active);
    if (active) view.scrollTop = 0;
  });
  document.querySelectorAll('[data-view-target]').forEach((button) => {
    const active = button.dataset.viewTarget === viewName;
    if (button.classList.contains('nav-button')) {
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    }
  });
}

async function saveBehaviorSettings() {
  if (!api || settingsSaveInFlight) return;
  settingsSaveInFlight = true;
  try {
    const settings = await api.updateLocalSettings({
      autoStartServices: elements.autoStartServices.checked,
      closeToTray: elements.closeToTray.checked,
    });
    renderSettings(settings);
    showToast('设置已保存在本机。');
  } catch {
    renderSettings(currentSettings);
    showToast('设置保存失败，请查看日志。');
  } finally {
    settingsSaveInFlight = false;
  }
}

async function refreshPhotoshopStatus() {
  if (!api) {
    renderPhotoshop(photoshopStatus);
    return;
  }
  try {
    renderPhotoshop(await api.getPhotoshopStatus());
  } catch {
    renderPhotoshop({ installations: [], localPlugin: { installed: false } });
  }
}

async function waitForWorkspaceReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = currentState;

  while (Date.now() < deadline) {
    lastState = await api.getState();
    renderState(lastState);
    if (isWorkspaceReady(lastState)) return lastState;
    if (lastState.phase === 'error') {
      throw new Error(lastState.message || 'Li3D 本地服务启动失败。');
    }
    await sleep(850);
  }

  throw new Error(lastState.message || '等待 Li3D 本地服务超时。');
}

async function startAndOpenWorkspace() {
  if (!api) {
    showToast('这是静态设计预览，桌面版中会启动 Li3D。');
    return;
  }
  if (launchInFlight) return;

  launchInFlight = true;
  renderState(currentState);
  try {
    if (!isWorkspaceReady()) {
      showToast('正在启动 Li3D，本地服务就绪后会自动打开工作台。');
      await api.start();
      await waitForWorkspaceReady();
    }
    await api.openWorkspace();
    showToast('Li3D 工作台已打开。');
  } catch (error) {
    console.error('[launcher] failed to start and open workspace', error);
    showToast(error?.message || 'Li3D 启动失败，请在设置中打开日志查看原因。');
  } finally {
    launchInFlight = false;
    renderState(currentState);
  }
}

async function refreshAuthStatus({ forcePrompt = false } = {}) {
  if (!api || !isWorkspaceReady()) return currentAuth;
  if (forcePrompt) authGateDismissed = false;
  try {
    const result = await api.getAuthStatus();
    renderAuth({ ...result, pending: false });
    return result;
  } catch (error) {
    console.error('[launcher] failed to read auth status', error);
    renderAuth({ authenticated: false, pending: false });
    return currentAuth;
  }
}

async function loginFromGate() {
  if (!api || authInFlight) return;
  authInFlight = true;
  authGateDismissed = false;
  renderAuth({ authenticated: false, pending: false });
  try {
    const result = await api.login();
    renderAuth({ ...result, authenticated: true, pending: false });
    showToast('登录成功，以后从启动器进入无需重复登录。');
  } catch (error) {
    console.error('[launcher] login failed', error);
    elements.authGateMessage.textContent = error?.message || '登录未完成，请重新尝试。';
    showToast(error?.message || '登录未完成，请重新尝试。');
  } finally {
    authInFlight = false;
    renderAuth(currentAuth);
  }
}

function bindButton(selector, handler) {
  const button = document.querySelector(selector);
  if (!button) {
    console.warn(`[launcher] button not found: ${selector}`);
    return;
  }
  button.addEventListener('click', handler);
}

async function runButtonAction(action, successMessage, failureMessage) {
  if (!api) {
    showToast('这是静态设计预览。');
    return;
  }
  try {
    await action();
    if (successMessage) showToast(successMessage);
  } catch (error) {
    console.error('[launcher] button action failed', error);
    showToast(error?.message || failureMessage);
  }
}

document.querySelectorAll('[data-view-target]').forEach((button) => {
  button.addEventListener('click', () => showView(button.dataset.viewTarget));
});

elements.primaryLaunch.addEventListener('click', startAndOpenWorkspace);
elements.authGateLogin.addEventListener('click', loginFromGate);
elements.authGateLater.addEventListener('click', () => {
  authGateDismissed = true;
  renderAuth(currentAuth);
});

bindButton('#settingsOpenWorkspaceDir', () =>
  runButtonAction(
    () => api.openWorkspaceDir(),
    '已打开 Li3D 工作目录。',
    '无法打开工作目录。',
  ),
);
bindButton('#homeOpenLogs', () =>
  runButtonAction(() => api.openLogs(), '已打开日志目录。', '无法打开日志目录。'),
);
bindButton('#settingsOpenLogs', () =>
  runButtonAction(() => api.openLogs(), '已打开日志目录。', '无法打开日志目录。'),
);
bindButton('#restartServices', () =>
  runButtonAction(
    async () => {
      showToast('正在重新准备 Li3D 服务…');
      await api.restart();
    },
    'Li3D 服务已进入重启流程。',
    'Li3D 服务重启失败，请查看日志。',
  ),
);
bindButton('#quitLauncher', () => runButtonAction(() => api.quit(), '', '无法退出启动器。'));

elements.checkUpdates.addEventListener('click', async () => {
  const label = elements.checkUpdates.querySelector('span');
  label.textContent = '检查中…';
  elements.checkUpdates.disabled = true;
  try {
    const result = api
      ? await api.checkForUpdates()
      : {
          status: 'manual',
          currentVersion: currentState.appVersion,
          message: '当前为设计预览，在线更新通道尚未接入。',
        };
    elements.updateMessage.textContent = result.message;
    showToast(result.message);
  } catch {
    showToast('暂时无法检查更新，请稍后再试。');
  } finally {
    window.setTimeout(() => {
      label.textContent = '检查更新';
      elements.checkUpdates.disabled = false;
    }, 650);
  }
});

elements.autoStartServices.addEventListener('change', saveBehaviorSettings);
elements.closeToTray.addEventListener('change', saveBehaviorSettings);

elements.launchPhotoshop.addEventListener('click', async () => {
  if (!api) return showToast('这是静态设计预览。');
  try {
    await api.launchPhotoshop();
    showToast('正在打开 Photoshop。');
  } catch {
    showToast('无法打开 Photoshop，请确认软件安装位置。');
  }
});

elements.installPhotoshopPlugin.addEventListener('click', async () => {
  if (!api) return showToast('这是静态设计预览。');
  try {
    await api.installPhotoshopPlugin();
    await refreshPhotoshopStatus();
    showToast('Photoshop 插件已准备完成，重新启动 Photoshop 后生效。');
  } catch {
    showToast('插件安装失败，请打开日志查看原因。');
  }
});

elements.openSubstanceInstall.addEventListener('click', async () => {
  if (currentState.baker === 'online') {
    showToast(`Substance 3D Baker ${currentState.bakerVersion || ''} 已安装。`);
    return;
  }
  if (!api) return showToast('这是静态设计预览。');
  try {
    await api.openSubstanceInstall();
    showToast('已打开 Substance 3D Designer 获取页面。');
  } catch {
    showToast('无法打开 Substance 3D Designer 获取页面。');
  }
});

if (api) {
  api.onState(renderState);
  api.onLocalSettings?.(renderSettings);
  Promise.all([api.getState(), api.getLocalSettings()])
    .then(([state, settings]) => {
      renderState(state);
      renderSettings(settings);
      void refreshAuthStatus();
    })
    .catch(() => showToast('启动器状态读取失败，请尝试重启。'));
  refreshPhotoshopStatus();
  window.setInterval(refreshPhotoshopStatus, 15_000);
  window.setInterval(() => {
    if (!currentAuth.authenticated && !authInFlight) void refreshAuthStatus();
  }, 4_000);
} else {
  renderState(previewState);
  renderSettings(currentSettings);
  renderPhotoshop(photoshopStatus);
  renderAuth({ authenticated: false, pending: false });
}

showView(window.location.hash === '#settings' ? 'settings' : 'home');
