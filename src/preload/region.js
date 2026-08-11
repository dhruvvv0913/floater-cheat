'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Minimal bridge for the region picker — two messages, nothing else. */
contextBridge.exposeInMainWorld('region', {
  done: (rect) => ipcRenderer.send('region:done', rect),
  cancel: () => ipcRenderer.send('region:cancel'),
});
