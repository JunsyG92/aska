'use strict';
// Seul pont entre l'interface (bac à sable, sans Node) et le processus principal.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('aska', {
  getState: () => ipcRenderer.invoke('aska:state'),
  run: (req) => ipcRenderer.invoke('aska:run', req),
  cancel: () => ipcRenderer.invoke('aska:cancel'),
  pickDir: () => ipcRenderer.invoke('aska:pick-dir'),
  resetDir: () => ipcRenderer.invoke('aska:reset-dir'),
  copy: (text) => ipcRenderer.invoke('aska:copy', text),
  hide: () => ipcRenderer.invoke('aska:hide'),
  resize: (size) => ipcRenderer.invoke('aska:resize', size),
  setMini: (v) => ipcRenderer.invoke('aska:set-mini', v),
  onRunEvent: on('aska:run-event'),
  onShown: on('aska:shown'),
  onWillHide: on('aska:will-hide'),
});
