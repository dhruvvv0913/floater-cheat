'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between the renderer and Node.
 *
 * Deliberately explicit: every capability is a named method, so adding a
 * feature means adding a method here and a matching handler in main/index.js.
 * Nothing generic is exposed, and nothing here can reach the filesystem or the
 * network on the renderer's behalf. The API key is write-only — there is no
 * method that returns it.
 */

const on = (channel, callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('overlay', {
  /* ---- queries ---- */
  getState: () => ipcRenderer.invoke('overlay:get-state'),
  getInfo: () => ipcRenderer.invoke('overlay:get-info'),

  /* ---- window control ---- */
  moveBy: (dx, dy) => ipcRenderer.send('overlay:move-by', { dx, dy }),
  resizeBy: (dw, dh) => ipcRenderer.send('overlay:resize-by', { dw, dh }),
  reportHeight: (px) => ipcRenderer.send('overlay:content-height', px),
  setDragging: (v) => ipcRenderer.send('overlay:set-dragging', v),
  setInputOpen: (v) => ipcRenderer.send('overlay:set-input-open', v),
  setMode: (mode) => ipcRenderer.send('overlay:set-mode', mode),
  setProtection: (v) => ipcRenderer.send('overlay:set-protection', v),
  quit: () => ipcRenderer.send('overlay:quit'),

  /* ---- answers ---- */
  copyAnswer: () => ipcRenderer.invoke('answer:copy'),
  stepAnswer: (offset) => ipcRenderer.invoke('answer:step', offset),
  currentAnswer: () => ipcRenderer.invoke('answer:current'),

  /* ---- region ---- */
  pickRegion: () => ipcRenderer.invoke('region:pick'),
  clearRegion: () => ipcRenderer.invoke('region:clear'),

  /* ---- document ---- */
  pickDocument: () => ipcRenderer.invoke('document:pick'),
  clearDocument: () => ipcRenderer.invoke('document:clear'),

  /* ---- self-test ---- */
  runSelfTest: () => ipcRenderer.invoke('overlay:run-selftest'),
  // Sent back once the marker has actually painted, so the test captures a real
  // frame instead of racing the compositor.
  markerPainted: () => ipcRenderer.send('selftest:marker-painted'),

  /* ---- ai ---- */
  ai: {
    oneShot: () => ipcRenderer.invoke('ai:one-shot'),
    ask: (question) => ipcRenderer.invoke('ai:ask', { question }),
    retryHarder: () => ipcRenderer.invoke('ai:retry-harder'),
    explain: () => ipcRenderer.invoke('ai:explain'),
    clipboard: () => ipcRenderer.invoke('ai:clipboard'),
    panic: () => ipcRenderer.invoke('ai:panic'),
    cancel: () => ipcRenderer.invoke('ai:cancel'),
    clearHistory: () => ipcRenderer.invoke('ai:clear-history'),
    getSettings: () => ipcRenderer.invoke('ai:get-settings'),
    setKey: (key) => ipcRenderer.invoke('ai:set-key', key),
    setOption: (name, value) => ipcRenderer.invoke('ai:set-option', { name, value }),
    resetUsage: () => ipcRenderer.invoke('ai:reset-usage'),
    onStart: (cb) => on('ai:start', cb),
    onDelta: (cb) => on('ai:delta', cb),
    onDone: (cb) => on('ai:done', cb),
  },

  /* ---- events ---- */
  onState: (cb) => on('overlay:state', cb),
  onBlank: (cb) => on('overlay:blank', cb),
  onDisplay: (cb) => on('overlay:display', cb),
  onAskOpen: (cb) => on('ask:open', cb),
  onAnswer: (cb) => on('answer:show', cb),
  onToast: (cb) => on('toast', cb),
  onShowMarker: (cb) => on('selftest:show-marker', cb),
  onSelfTestStarted: (cb) => on('selftest:started', cb),
  onSelfTestResult: (cb) => on('selftest:result', cb),
});
