// Bridge between the Settings window and the app (main.js).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('c07', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  action: (name) => ipcRenderer.invoke('settings:action', name),
  onProgress: (fn) => ipcRenderer.on('update-progress', (_e, text) => fn(text)),
});
