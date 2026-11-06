const { contextBridge, ipcRenderer } = require('electron');
const { exposeHardwareBridge } = require('./hardware-preload');

contextBridge.exposeInMainWorld('rawdaDesktop', {
  buildMode: process.env.BUILD_MODE === 'dev' ? 'dev' : 'client',
  chooseDatabaseFolder: () => ipcRenderer.invoke('choose-database-folder'),
  confirmDatabasePath: (filePath) => ipcRenderer.invoke('confirm-database-path', filePath),
  databaseLocationBrowse: () => ipcRenderer.invoke('database-location-browse'),
  databaseLocationConfirm: (directoryPath) => ipcRenderer.invoke('database-location-confirm', directoryPath),
  databaseLocationCancel: () => ipcRenderer.invoke('database-location-cancel'),
  openDatabaseFolder: (filePath) => ipcRenderer.invoke('open-database-folder', filePath),
  chooseBusinessCatalogFile: () => ipcRenderer.invoke('business-catalog-open'),
  getDeviceId: () => ipcRenderer.invoke('license-device-id'),
  getLicenseStatus: () => ipcRenderer.invoke('license-status'),
  onTrialExpired: (callback) => {
    ipcRenderer.on('trial-expired', callback);
    return () => ipcRenderer.off('trial-expired', callback);
  },
  getRememberedLogin: () => ipcRenderer.invoke('remembered-login-get'),
  saveRememberedLogin: (credentials) => ipcRenderer.invoke('remembered-login-save', credentials),
  clearRememberedLogin: () => ipcRenderer.invoke('remembered-login-clear'),
  appendErrorLog: (entry) => ipcRenderer.invoke('append-error-log', entry),
  setAppLanguage: language => ipcRenderer.invoke('ui-language-set', language),
  activateOffline: () => ipcRenderer.invoke('license-activate-offline'),
  activateLicenseText: (licenseText) => ipcRenderer.invoke('license-activate-text', licenseText),
  activateLicense: (licenseText) => ipcRenderer.invoke('license-activate-text', licenseText),
  activateCentral: (options) => ipcRenderer.invoke('license-activate-central', options)
});
contextBridge.exposeInMainWorld('rawdaHardware', exposeHardwareBridge(ipcRenderer));
