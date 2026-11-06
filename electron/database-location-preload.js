'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('databaseLocation', {
  browse: () => ipcRenderer.invoke('database-location-browse'),
  confirm: directoryPath => ipcRenderer.invoke('database-location-confirm', directoryPath),
  cancel: () => ipcRenderer.invoke('database-location-cancel')
});
