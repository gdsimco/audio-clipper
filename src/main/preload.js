const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  initialFile: () => ipcRenderer.invoke('initial-file'),
  exportMenu: (opts) => ipcRenderer.invoke('export-menu', opts),
  saveDialog: (opts) => ipcRenderer.invoke('save-dialog', opts),
  writeExport: (opts) => ipcRenderer.invoke('write-export', opts),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  setDirty: (v) => ipcRenderer.send('set-dirty', v),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, p) => cb(p)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
});
