'use strict';
// The only bridge between the UI (sandboxed, no Node) and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('aska', {
  getState: () => ipcRenderer.invoke('aska:state'),
  run: (req) => ipcRenderer.invoke('aska:run', req),
  cancel: (tabId) => ipcRenderer.invoke('aska:cancel', tabId),
  newTab: () => ipcRenderer.invoke('aska:tab-new'),
  activateTab: (id) => ipcRenderer.invoke('aska:tab-activate', id),
  cycleTab: (dir) => ipcRenderer.invoke('aska:tab-cycle', dir),
  closeTab: (id, force) => ipcRenderer.invoke('aska:tab-close', { id, force: force === true }),
  pickDir: () => ipcRenderer.invoke('aska:pick-dir'),
  resetDir: () => ipcRenderer.invoke('aska:reset-dir'),
  setDir: (dir) => ipcRenderer.invoke('aska:set-dir', dir),
  copy: (text) => ipcRenderer.invoke('aska:copy', text),
  hide: () => ipcRenderer.invoke('aska:hide'),
  setPinned: (v) => ipcRenderer.invoke('aska:set-pinned', v === true),
  openUrl: (url) => ipcRenderer.invoke('aska:open-url', url),
  resize: (size) => ipcRenderer.invoke('aska:resize', size),
  setMini: (v) => ipcRenderer.invoke('aska:set-mini', v),
  // Large view or normal size; resolves once the window has its new size.
  setWide: (wide, opts = {}) => ipcRenderer.invoke('aska:set-wide', { wide: wide === true, compact: opts.compact || null, animate: opts.animate === true }),
  // Something dragged over the window: 'over', then 'drop' or 'leave'.
  drag: (state) => ipcRenderer.invoke('aska:drag', String(state)),
  // Path of a dropped file (the UI has no access to paths otherwise); '' if it has none.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  newConversation: () => ipcRenderer.invoke('aska:conv-new'),
  listConversations: () => ipcRenderer.invoke('aska:conv-list'),
  openConversation: (id) => ipcRenderer.invoke('aska:conv-open', id),
  deleteConversation: (id) => ipcRenderer.invoke('aska:conv-delete', id),
  listModels: (agentId, refresh) => ipcRenderer.invoke('aska:models', { agentId, refresh: refresh === true }),
  setModel: (agentId, model) => ipcRenderer.invoke('aska:set-model', { agentId, model }),
  addSources: (items) => ipcRenderer.invoke('aska:sources-add', items),
  pickSources: () => ipcRenderer.invoke('aska:sources-pick'),
  removeSource: (key) => ipcRenderer.invoke('aska:sources-remove', key),
  listSources: (refresh) => ipcRenderer.invoke('aska:sources-list', { refresh: refresh === true }),
  listenStart: (tabId) => ipcRenderer.invoke('aska:listen-start', tabId),
  listenStop: () => ipcRenderer.invoke('aska:listen-stop'),
  listenAudio: (pcm) => ipcRenderer.invoke('aska:listen-audio', pcm),
  getSettings: () => ipcRenderer.invoke('aska:settings-get'),
  saveSettings: (values) => ipcRenderer.invoke('aska:settings-save', values),
  onRunEvent: on('aska:run-event'),
  onShown: on('aska:shown'),
  onWillHide: on('aska:will-hide'),
  onFading: on('aska:fading'),
  onNewConversation: on('aska:new-conversation'),
  onOpenSettings: on('aska:open-settings'),
  onSelection: on('aska:selection'),
  onUnread: on('aska:unread'),
  onTabs: on('aska:tabs'),
});
