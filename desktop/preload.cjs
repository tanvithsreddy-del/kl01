const { contextBridge, ipcRenderer } = require('electron');

const zoom = action => ipcRenderer.invoke('kl01:zoom', action);

contextBridge.exposeInMainWorld('kl01Desktop', Object.freeze({
  getZoom: () => zoom('get'),
  zoomIn: () => zoom('in'),
  zoomOut: () => zoom('out'),
  resetZoom: () => zoom('reset'),
  onZoomChanged: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('kl01:zoom-changed', listener);
    return () => ipcRenderer.removeListener('kl01:zoom-changed', listener);
  },
}));
