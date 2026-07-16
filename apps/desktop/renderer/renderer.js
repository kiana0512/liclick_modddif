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
  localAvatarPreview: document.querySelector('#localAvatarPreview'),
  localProfileId: document.querySelector('#localProfileId'),
  localAvatarFile: document.querySelector('#localAvatarFile'),
  chooseLocalAvatar: document.querySelector('#chooseLocalAvatar'),
  saveLocalProfile: document.querySelector('#saveLocalProfile'),
  resetLocalProfile: document.querySelector('#resetLocalProfile'),
  profileSaveStatus: document.querySelector('#profileSaveStatus'),
  performanceModeToggle: document.querySelector('#performanceModeToggle'),
  performanceModeLabel: document.querySelector('#performanceModeLabel'),
  openShortcutSettings: document.querySelector('#openShortcutSettings'),
  shortcutModal: document.querySelector('#shortcutModal'),
  closeShortcutSettings: document.querySelector('#closeShortcutSettings'),
  shortcutSearch: document.querySelector('#shortcutSearch'),
  shortcutList: document.querySelector('#shortcutList'),
  shortcutMessage: document.querySelector('#shortcutMessage'),
  resetAllShortcuts: document.querySelector('#resetAllShortcuts'),
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
let currentLocalSettings = {
  activeUserId: 'anonymous',
  performanceTestModeEnabled: false,
  profile: { customId: '' },
  shortcutOverrides: {},
};
let pendingAvatarDataUrl;
let recordingShortcutId;

const shortcutDefinitions = Array.isArray(window.LICLICK_SHORTCUT_DEFINITIONS)
  ? window.LICLICK_SHORTCUT_DEFINITIONS
  : [];

function bindingKey(binding) {
  return [binding.primary ? 'primary' : '', binding.shift ? 'shift' : '', binding.alt ? 'alt' : '', binding.code]
    .filter(Boolean)
    .join('+');
}

function formatBinding(binding) {
  const keyLabels = {
    Space: 'Space',
    BracketLeft: '[',
    BracketRight: ']',
    NumpadDecimal: 'Num .',
  };
  const codeLabel =
    keyLabels[binding.code] ??
    (binding.code.startsWith('Key')
      ? binding.code.slice(3)
      : binding.code.replace('Numpad', 'Num '));
  return [binding.primary ? 'Ctrl' : '', binding.shift ? 'Shift' : '', binding.alt ? 'Alt' : '', codeLabel]
    .filter(Boolean)
    .join(' + ');
}

function bindingsFor(definition) {
  return currentLocalSettings.shortcutOverrides[definition.id] ?? definition.defaults;
}

function renderLocalProfile() {
  const profile = currentLocalSettings.profile ?? { customId: '' };
  elements.localProfileId.value = profile.customId ?? '';
  pendingAvatarDataUrl = profile.avatarDataUrl;
  elements.localAvatarPreview.replaceChildren();
  if (profile.avatarDataUrl) {
    const image = document.createElement('img');
    image.src = profile.avatarDataUrl;
    image.alt = '';
    elements.localAvatarPreview.append(image);
  } else {
    const fallback = document.createElement('span');
    fallback.textContent = 'LI';
    elements.localAvatarPreview.append(fallback);
  }
}

function renderLocalSettings(settings) {
  currentLocalSettings = {
    ...currentLocalSettings,
    ...settings,
    profile: settings?.profile ?? currentLocalSettings.profile,
    shortcutOverrides: settings?.shortcutOverrides ?? currentLocalSettings.shortcutOverrides,
  };
  renderLocalProfile();
  elements.performanceModeToggle.checked = currentLocalSettings.performanceTestModeEnabled;
  elements.performanceModeLabel.textContent = currentLocalSettings.performanceTestModeEnabled
    ? '已启用'
    : '已关闭';
  if (!elements.shortcutModal.hidden) renderShortcutList();
}

async function updateSharedSettings(patch) {
  if (!api?.updateLocalSettings) {
    renderLocalSettings({ ...currentLocalSettings, ...patch });
    return currentLocalSettings;
  }
  const result = await api.updateLocalSettings({
    userId: currentLocalSettings.activeUserId,
    ...patch,
  });
  renderLocalSettings(result);
  return result;
}

function renderShortcutList() {
  const query = elements.shortcutSearch.value.trim().toLowerCase();
  const visibleDefinitions = shortcutDefinitions.filter((definition) =>
    `${definition.category} ${definition.label} ${definition.id}`.toLowerCase().includes(query),
  );
  elements.shortcutList.replaceChildren();
  let previousCategory = '';
  for (const definition of visibleDefinitions) {
    if (definition.category !== previousCategory) {
      previousCategory = definition.category;
      const heading = document.createElement('div');
      heading.className = 'shortcut-group-title';
      heading.textContent = definition.category;
      elements.shortcutList.append(heading);
    }
    const row = document.createElement('div');
    row.className = 'shortcut-row';
    const label = document.createElement('span');
    label.textContent = definition.label;
    const bindingButton = document.createElement('button');
    bindingButton.type = 'button';
    bindingButton.className = `shortcut-binding${recordingShortcutId === definition.id ? ' is-recording' : ''}`;
    const bindings = bindingsFor(definition);
    bindingButton.textContent =
      recordingShortcutId === definition.id
        ? '请按新快捷键…'
        : bindings.length > 0
          ? bindings.map(formatBinding).join(' / ')
          : '未设置';
    bindingButton.addEventListener('click', () => {
      recordingShortcutId = definition.id;
      elements.shortcutMessage.textContent = '请直接按下新的快捷键组合，Esc 取消，Delete 清除。';
      renderShortcutList();
    });
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'shortcut-clear';
    clearButton.textContent = '×';
    clearButton.title = '清除快捷键';
    clearButton.addEventListener('click', () => {
      const nextOverrides = { ...currentLocalSettings.shortcutOverrides, [definition.id]: [] };
      void updateSharedSettings({ shortcutOverrides: nextOverrides });
      recordingShortcutId = undefined;
      renderShortcutList();
    });
    row.append(label, bindingButton, clearButton);
    elements.shortcutList.append(row);
  }
}

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
  button.addEventListener('click', () => {
    showView(button.dataset.viewTarget);
    if (button.dataset.viewTarget === 'settings' && api?.getLocalSettings) {
      void api.getLocalSettings().then(renderLocalSettings).catch(() => undefined);
    }
  });
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

elements.chooseLocalAvatar.addEventListener('click', () => elements.localAvatarFile.click());
elements.localAvatarFile.addEventListener('change', () => {
  const file = elements.localAvatarFile.files?.[0];
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    window.alert('请选择 PNG、JPG 或 WebP 图片。');
    elements.localAvatarFile.value = '';
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    window.alert('头像文件不能超过 2 MB。');
    elements.localAvatarFile.value = '';
    return;
  }
  const reader = new FileReader();
  reader.addEventListener('load', () => {
    if (typeof reader.result !== 'string') return;
    pendingAvatarDataUrl = reader.result;
    elements.localAvatarPreview.replaceChildren();
    const image = document.createElement('img');
    image.src = reader.result;
    image.alt = '';
    elements.localAvatarPreview.append(image);
    elements.profileSaveStatus.textContent = '等待保存';
  });
  reader.readAsDataURL(file);
});

elements.localProfileId.addEventListener('input', () => {
  elements.profileSaveStatus.textContent = '等待保存';
});

elements.saveLocalProfile.addEventListener('click', async () => {
  const customId = elements.localProfileId.value.trim().replace(/^@+/, '');
  if (customId && !/^[\p{L}\p{N}_-]{2,24}$/u.test(customId)) {
    window.alert('自定义 ID 需为 2–24 个中文、英文、数字、下划线或短横线。');
    return;
  }
  elements.saveLocalProfile.disabled = true;
  elements.profileSaveStatus.textContent = '保存中';
  try {
    await updateSharedSettings({
      profile: {
        customId,
        ...(pendingAvatarDataUrl ? { avatarDataUrl: pendingAvatarDataUrl } : {}),
      },
    });
    elements.profileSaveStatus.textContent = '已保存';
  } catch (error) {
    elements.profileSaveStatus.textContent = '保存失败';
    appendLog(`[launcher] 无法保存本地资料：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    elements.saveLocalProfile.disabled = false;
  }
});

elements.resetLocalProfile.addEventListener('click', async () => {
  pendingAvatarDataUrl = undefined;
  try {
    await updateSharedSettings({ profile: { customId: '' } });
    elements.localAvatarFile.value = '';
    elements.profileSaveStatus.textContent = '已恢复默认';
  } catch (error) {
    appendLog(`[launcher] 无法恢复本地资料：${error instanceof Error ? error.message : String(error)}`);
  }
});

elements.performanceModeToggle.addEventListener('change', async () => {
  const enabled = elements.performanceModeToggle.checked;
  elements.performanceModeLabel.textContent = enabled ? '已启用' : '已关闭';
  try {
    await updateSharedSettings({ performanceTestModeEnabled: enabled });
  } catch (error) {
    renderLocalSettings(currentLocalSettings);
    appendLog(`[launcher] 无法保存性能测试模式：${error instanceof Error ? error.message : String(error)}`);
  }
});

elements.openShortcutSettings.addEventListener('click', () => {
  recordingShortcutId = undefined;
  elements.shortcutSearch.value = '';
  elements.shortcutMessage.textContent = '同一作用域内不允许重复快捷键。';
  elements.shortcutModal.hidden = false;
  renderShortcutList();
  elements.shortcutSearch.focus();
});

function closeShortcutModal() {
  recordingShortcutId = undefined;
  elements.shortcutModal.hidden = true;
}

elements.closeShortcutSettings.addEventListener('click', closeShortcutModal);
elements.shortcutModal.addEventListener('mousedown', (event) => {
  if (event.target === elements.shortcutModal) closeShortcutModal();
});
elements.shortcutSearch.addEventListener('input', renderShortcutList);
elements.resetAllShortcuts.addEventListener('click', async () => {
  recordingShortcutId = undefined;
  await updateSharedSettings({ shortcutOverrides: {} });
  elements.shortcutMessage.textContent = '全部快捷键已恢复默认值。';
  renderShortcutList();
});

document.addEventListener('keydown', (event) => {
  if (elements.shortcutModal.hidden) return;
  if (!recordingShortcutId) {
    if (event.key === 'Escape') closeShortcutModal();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const definition = shortcutDefinitions.find((item) => item.id === recordingShortcutId);
  if (!definition) return;
  if (event.key === 'Escape') {
    recordingShortcutId = undefined;
    elements.shortcutMessage.textContent = '已取消录制。';
    renderShortcutList();
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    const nextOverrides = { ...currentLocalSettings.shortcutOverrides, [definition.id]: [] };
    recordingShortcutId = undefined;
    void updateSharedSettings({ shortcutOverrides: nextOverrides });
    renderShortcutList();
    return;
  }
  if (
    ['ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight'].includes(
      event.code,
    )
  ) return;
  const nextBinding = {
    code: event.code,
    ...(event.ctrlKey || event.metaKey ? { primary: true } : {}),
    ...(event.shiftKey ? { shift: true } : {}),
    ...(event.altKey ? { alt: true } : {}),
  };
  const conflict = shortcutDefinitions.find((item) => {
    if (item.id === definition.id) return false;
    const sharesScope =
      item.scope === definition.scope || item.scope === 'global' || definition.scope === 'global';
    return sharesScope && bindingsFor(item).some((binding) => bindingKey(binding) === bindingKey(nextBinding));
  });
  if (conflict) {
    elements.shortcutMessage.textContent = `该快捷键已用于“${conflict.label}”，请换一个组合。`;
    return;
  }
  const nextOverrides = { ...currentLocalSettings.shortcutOverrides, [definition.id]: [nextBinding] };
  recordingShortcutId = undefined;
  void updateSharedSettings({ shortcutOverrides: nextOverrides });
  elements.shortcutMessage.textContent = `已更新“${definition.label}”。`;
  renderShortcutList();
});

if (api) {
  api.onState(renderState);
  api.onLog(appendLog);
  api.onLocalSettings?.(renderLocalSettings);
  api
    .getState()
    .then(renderState)
    .catch((error) => {
      renderState({ phase: 'error', message: '无法读取启动器状态。' });
      appendLog(
        `[launcher] 无法读取状态：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  api
    .getLocalSettings()
    .then(renderLocalSettings)
    .catch((error) => {
      appendLog(
        `[launcher] 无法读取本地设置：${error instanceof Error ? error.message : String(error)}`,
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
  renderLocalSettings(currentLocalSettings);
}
