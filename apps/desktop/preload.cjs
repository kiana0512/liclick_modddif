const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liclickLauncher', {
  getState: () => ipcRenderer.invoke('launcher:get-state'),
  start: () => ipcRenderer.invoke('launcher:start'),
  restart: () => ipcRenderer.invoke('launcher:restart'),
  stop: () => ipcRenderer.invoke('launcher:stop'),
  openWorkspace: () => ipcRenderer.invoke('launcher:open-workspace'),
  openWorkspaceDir: () => ipcRenderer.invoke('launcher:open-workspace-dir'),
  openLogs: () => ipcRenderer.invoke('launcher:open-logs'),
  getLocalSettings: () => ipcRenderer.invoke('launcher:get-local-settings'),
  updateLocalSettings: (input) => ipcRenderer.invoke('launcher:update-local-settings', input),
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
