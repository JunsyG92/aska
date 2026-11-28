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
  setWide: (v) => ipcRenderer.invoke('aska:set-wide', v === true),
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
  getSettings: () => ipcRenderer.invoke('aska:settings-get'),
  saveSettings: (values) => ipcRenderer.invoke('aska:settings-save', values),
  listBots: () => ipcRenderer.invoke('aska:bots-list'),
  saveBot: (id, values) => ipcRenderer.invoke('aska:bot-save', { id, values }),
  openBotFolder: (id) => ipcRenderer.invoke('aska:bot-open-folder', id),
  createBot: (req) => ipcRenderer.invoke('aska:bot-create', req),
  draftBot: (description) => ipcRenderer.invoke('aska:bot-draft', description),
  cancelBotDraft: () => ipcRenderer.invoke('aska:bot-draft-cancel'),
  deleteBot: (id) => ipcRenderer.invoke('aska:bot-delete', id),
  remember: (botId, text) => ipcRenderer.invoke('aska:bot-remember', { botId, text }),
  compactMemory: (botId) => ipcRenderer.invoke('aska:bot-compact', botId),
  replaceMemory: (botId, memory) => ipcRenderer.invoke('aska:bot-memory-replace', { botId, memory }),
  undoMemory: (botId) => ipcRenderer.invoke('aska:bot-memory-undo', botId),
  pickBotAvatar: (botId) => ipcRenderer.invoke('aska:bot-avatar-pick', botId),
  clearBotAvatar: (botId) => ipcRenderer.invoke('aska:bot-avatar-clear', botId),
  listTasks: () => ipcRenderer.invoke('aska:tasks-list'),
  createTask: (task) => ipcRenderer.invoke('aska:task-create', task),
  startTask: (id, numbers) => ipcRenderer.invoke('aska:task-start', { id, numbers }),
  cancelTask: (id, n) => ipcRenderer.invoke('aska:task-cancel', { id, n }),
  cleanupTask: (id) => ipcRenderer.invoke('aska:task-cleanup', id),
  keepTaskBot: (id, n) => ipcRenderer.invoke('aska:task-keep-bot', { id, n }),
  planTask: (req) => ipcRenderer.invoke('aska:task-plan', req),
  cancelTaskPlan: () => ipcRenderer.invoke('aska:task-plan-cancel'),
  proposeWave: (id) => ipcRenderer.invoke('aska:task-wave', id),
  approveWave: (id, subtasks) => ipcRenderer.invoke('aska:task-wave-approve', { id, subtasks }),
  dismissWave: (id) => ipcRenderer.invoke('aska:task-wave-dismiss', id),
  openTaskPr: (id, n) => ipcRenderer.invoke('aska:task-pr', { id, n }),
  rememberFromTask: (id, n, i) => ipcRenderer.invoke('aska:task-remember', { id, n, i }),
  pickTaskRoot: (from) => ipcRenderer.invoke('aska:task-pick-root', from),
  onRunEvent: on('aska:run-event'),
  onShown: on('aska:shown'),
  onWillHide: on('aska:will-hide'),
  onFading: on('aska:fading'),
  onNewConversation: on('aska:new-conversation'),
  onOpenSettings: on('aska:open-settings'),
  onOpenTasks: on('aska:open-tasks'),
  onSelection: on('aska:selection'),
  onUnread: on('aska:unread'),
  onTabs: on('aska:tabs'),
  onTask: on('aska:task'),
});
