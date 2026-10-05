const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexNative', {
  isElectron: true,
  platform: process.platform,
  openFolderPicker: () => ipcRenderer.invoke('dialog:openFolder'),
  showItemInFolder: (path) => ipcRenderer.invoke('shell:showItemInFolder', path)
});
