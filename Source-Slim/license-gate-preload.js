'use strict';

const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('licenseGate', {
  getStatus: () => ipcRenderer.invoke('license:get-status'),
  activate: (licenseObj) => ipcRenderer.invoke('license:activate', licenseObj),
  quit: () => ipcRenderer.invoke('license:quit'),
  proceedToApp: () => ipcRenderer.send('license:proceed'),
  copyToClipboard: (text) => clipboard.writeText(text)
});
