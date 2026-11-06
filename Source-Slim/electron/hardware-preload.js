'use strict';

function exposeHardwareBridge(ipcRenderer) {
  return {
    listPrinters: () => ipcRenderer.invoke('hardware:list-printers'),
    printSpooler: options => ipcRenderer.invoke('hardware:print-spooler', options),
    printEscpos: options => ipcRenderer.invoke('hardware:print-escpos', options),
    printNetwork: options => ipcRenderer.invoke('hardware:print-network', options),
    printMock: options => ipcRenderer.invoke('hardware:print-mock', options),
    printerTest: options => ipcRenderer.invoke('hardware:printer-test', options),
    openDrawer: options => ipcRenderer.invoke('hardware:open-drawer', options),
    drawerStatus: () => ipcRenderer.invoke('hardware:drawer-status'),
    listPorts: () => ipcRenderer.invoke('hardware:list-ports'),
    scaleRead: options => ipcRenderer.invoke('hardware:scale-read', options),
    scaleStreamStart: options => ipcRenderer.invoke('hardware:scale-stream-start', options),
    scaleStreamStop: options => ipcRenderer.invoke('hardware:scale-stream-stop', options),
    scaleSetWeight: options => ipcRenderer.invoke('hardware:scale-set-weight', options),
    scaleListProtocols: () => ipcRenderer.invoke('hardware:scale-list-protocols'),
    scannerRead: () => ipcRenderer.invoke('hardware:scanner-read'),
    scannerSetValue: options => ipcRenderer.invoke('hardware:scanner-set-value', options),
    diagnose: () => ipcRenderer.invoke('hardware:diagnose'),
    onScaleUpdate: callback => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('hardware:scale-update', listener);
      return () => ipcRenderer.off('hardware:scale-update', listener);
    }
  };
}

module.exports = { exposeHardwareBridge };
