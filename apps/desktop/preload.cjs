const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liclickLauncher', {
  getState: () => ipcRenderer.invoke('launcher:get-state'),
  start: () => ipcRenderer.invoke('launcher:start'),
  restart: () => ipcRenderer.invoke('launcher:restart'),
  stop: () => ipcRenderer.invoke('launcher:stop'),
  openWorkspace: () => ipcRenderer.invoke('launcher:open-workspace'),
  getAuthStatus: () => ipcRenderer.invoke('launcher:get-auth-status'),
  login: () => ipcRenderer.invoke('launcher:login'),
  openWorkspaceDir: () => ipcRenderer.invoke('launcher:open-workspace-dir'),
  openLogs: () => ipcRenderer.invoke('launcher:open-logs'),
  getLocalSettings: () => ipcRenderer.invoke('launcher:get-local-settings'),
  updateLocalSettings: (input) => ipcRenderer.invoke('launcher:update-local-settings', input),
  getPhotoshopStatus: () => ipcRenderer.invoke('launcher:get-photoshop-status'),
  launchPhotoshop: () => ipcRenderer.invoke('launcher:launch-photoshop'),
  choosePhotoshopExecutable: () => ipcRenderer.invoke('launcher:choose-photoshop-executable'),
  installPhotoshopPlugin: () => ipcRenderer.invoke('launcher:install-photoshop-plugin'),
  openPhotoshopBackups: () => ipcRenderer.invoke('launcher:open-photoshop-backups'),
  openSubstanceInstall: () => ipcRenderer.invoke('launcher:open-substance-install'),
  checkForUpdates: () => ipcRenderer.invoke('launcher:check-for-updates'),
  quit: () => ipcRenderer.invoke('launcher:quit'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('launcher:state', listener);
    return () => ipcRenderer.removeListener('launcher:state', listener);
  },
  onLog: (callback) => {
    const listener = (_event, line) => callback(line);
    ipcRenderer.on('launcher:log', listener);
    return () => ipcRenderer.removeListener('launcher:log', listener);
  },
  onLocalSettings: (callback) => {
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on('launcher:local-settings', listener);
    return () => ipcRenderer.removeListener('launcher:local-settings', listener);
  },
});
