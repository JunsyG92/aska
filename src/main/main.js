'use strict';
const { app, BrowserWindow, globalShortcut, ipcMain, dialog, screen, clipboard, Notification, session, shell, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { paths, loadConfig } = require('./config');
const { MODES, MODE_ORDER, resolveAgents, isModel, buildInvocation } = require('./agents');
const { ConversationStore, MAX_ANSWER } = require('./conversations');
const { discoverModels } = require('./models');
const { shouldNotify, notificationContent, createNotifier } = require('./notify');
const { Tabs } = require('./tabs');
const { isRemote, loadBots, saveBot, createBot, deleteBot, draftPrompt, parseDraft, DESCRIPTION_MAX, seedBots, systemText, fingerprint, invocationFor, importAvatar, clearAvatar } = require('./bots');
const sec = require('./security');
const { runAgent } = require('./runner');
const { resolveLaunch, buildCommand, extendedPath, commandLineExcess } = require('./launch');
const { buildId, runningInstance } = require('./build');
const { createTray } = require('./tray');
const { readSelection, quoteSelection, MAX_CHARS: MAX_SELECTION } = require('./selection');
const { keyLabels, ACTIONS } = require('./keys');
const { settingsView, validateSettings, mergeConfig } = require('./settings');
const gnome = require('./gnome');
const { LANGUAGES } = require('../i18n');
const { wantsCliOutput, printCli } = require('../cli');
const { t, getLanguage, uiStrings } = require('../i18n');

const P = paths();
const BUILD = buildId();
const INDEX = path.join(__dirname, '..', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX).href;
const WIN_W = 748; // initial size; the window then fits the panel
const WIN_H = 110;

// GlobalShortcuts portal: global shortcut on Wayland when the desktop supports it.
app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');

let win = null;
let cfg = null;
let agents = {};
let bots = {}; // custom bots (~/.aska/bots), read at startup and on reload
let offBots = {}; // bots turned off ("enabled": false): only listed in the settings
let warnings = [];
let trust = null;
let cwd = null; // folder of the active tab (and of new tabs)
const MAX_RUNS = 4; // simultaneous requests at most, across all tabs
let tray = null; // system tray icon
let runSeq = 0;
let dialogOpen = false;
let shortcutOk = false;
let selectionShortcutOk = false;
let quitting = false;
let mini = false; // panel collapsed into a pill
let pinned = null; // pinned: stays visible when clicking elsewhere (null = per config)
let unread = 0; // answers that arrived while the chat was out of sight
let notifier = null;
let savedPos = null; // anchor chosen by the user: left edge and BOTTOM edge of the window
let saveTimer = null;
let store = null; // saved conversations
let tabs = null; // open tabs (see tabs.js); each one carries its conversation and its running request
let savedTabs = null; // saved tabs, reopened at startup
const picked = {}; // model chosen per agent: { claude: 'opus' } (missing = default)
const extraModels = {}; // models typed in by hand, per agent
// Full name the CLI reported for a model it was given ("opus" -> "claude-opus-5-5"),
// per agent; "" is its default model. Shown in the model picker.
const resolvedModels = {};
const discovered = {}; // models reported by each CLI: { cursor: { models, error } }

// PATH extended with the usual CLI locations (see launch.js).
const searchPath = () => extendedPath();

// Environment passed to an agent: filtered, with the extended PATH above.
function agentEnv(agent) {
  return sec.setEnvVar(sec.buildEnv(process.env, agent.env, cfg.envPassthrough), 'PATH', searchPath());
}

// Runs an agent command (Windows: without cmd.exe for npm launchers).
function launchAgent(agent, argv, opts, onEvent) {
  let cmd;
  try {
    cmd = buildCommand(agent.launch, argv);
  } catch (e) {
    return { cancel() {}, done: Promise.resolve({ ok: false, reason: 'spawn-error', error: e.message, durationMs: 0, stderrTail: '' }) };
  }
  return runAgent({ ...opts, bin: cmd.command, argv: cmd.args, verbatim: cmd.verbatim, env: agentEnv(agent) }, onEvent);
}

// How far a command goes beyond the system's limit (the history fed back is cut
// down then: prompt passed as an argument by Copilot, Cursor), and whether some
// arguments can be passed at all (cmd.exe launcher: no argument with spaces).
function commandFit(agent) {
  const env = agentEnv(agent);
  return {
    excess: (i) => {
      let cmd;
      try {
        cmd = buildCommand(agent.launch, i.argv);
      } catch {
        return 0; // refused by cmd.exe: launchAgent reports it
      }
      return commandLineExcess(cmd.command, cmd.args, { verbatim: cmd.verbatim, env });
    },
    canPass: (args) => {
      try {
        buildCommand(agent.launch, args);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// System languages, most preferred first (decides the language when "language" is "auto").
function systemLangs() {
  try {
    const langs = app.getPreferredSystemLanguages();
    if (langs.length) return langs;
  } catch { /* older Electron or not ready */ }
  return [app.getLocale()];
}

function loadEverything() {
  const c = loadConfig(P.config, { systemLangs: systemLangs() });
  cfg = c.config;
  const a = resolveAgents(cfg.agents);
  agents = a.agents;
  warnings = [...c.warnings, ...a.warnings];
  for (const agent of Object.values(agents)) {
    const r = sec.resolveBinary(agent.bin, { override: agent.binOverride, envPath: searchPath(), avoid: agent.avoidPath });
    agent.binPath = r.path || null;
    agent.binError = r.error || null;
    if (agent.binPath) {
      const l = resolveLaunch(agent.binPath, { envPath: searchPath() });
      if (l.error) {
        agent.binPath = null;
        agent.binError = l.error;
      } else agent.launch = l;
    }
  }
  // After the agents: a bot's agent must exist.
  // First launch: the example bots, in the interface's language, for the
  // default agent (else the first one installed). Never again afterwards.
  const usable = Object.values(agents).filter((x) => x.binPath);
  const seedAgent = (agents[cfg.defaultAgent] && agents[cfg.defaultAgent].binPath ? agents[cfg.defaultAgent] : usable[0] || agents.claude || {}).id;
  if (seedAgent) seedBots(P.bots, { lang: getLanguage(), agent: seedAgent });
  const b = loadBots(P.bots, { agents, allowAutoMode: cfg.allowAutoMode });
  bots = b.bots;
  offBots = b.off;
  warnings.push(...b.warnings);
  trust = new sec.TrustStore(P.trust);
  sec.ensurePrivateDir(P.workspace);
  if (!cwd) {
    const st = sec.readOwnedJson(P.state);
    const saved = st.data && typeof st.data.cwd === 'string' ? st.data.cwd : null;
    const d = st.data || {};
    for (const [k, v] of Object.entries(d.models && typeof d.models === 'object' ? d.models : {})) {
      if (Object.hasOwn(agents, k) && isModel(v)) picked[k] = v;
    }
    for (const [k, v] of Object.entries(d.extraModels && typeof d.extraModels === 'object' ? d.extraModels : {})) {
      if (Object.hasOwn(agents, k) && Array.isArray(v)) extraModels[k] = v.filter(isModel).slice(0, 12);
    }
    for (const [k, v] of Object.entries(d.resolvedModels && typeof d.resolvedModels === 'object' ? d.resolvedModels : {})) {
      if (!Object.hasOwn(agents, k) || !v || typeof v !== 'object') continue;
      const ok = Object.entries(v).filter(([from, to]) => (from === '' || isModel(from)) && isModel(to)).slice(0, 30);
      if (ok.length) resolvedModels[k] = Object.fromEntries(ok);
    }
    if (typeof d.pinned === 'boolean') pinned = d.pinned;
    savedTabs = { ids: d.tabs, active: d.activeTab };
    const pos = st.data && st.data.pos;
    if (pos && Number.isInteger(pos.x) && Number.isInteger(pos.bottom)) savedPos = { x: pos.x, bottom: pos.bottom };
    cwd = saved && !sec.checkWorkdir(saved, 'read').error ? saved : P.workspace;
  }
  if (pinned === null) pinned = !cfg.hideOnBlur;
  notifier = createNotifier({
    Notification,
    sound: cfg.notifySound,
    logFile: process.env.ASKA_NOTIFY_LOG || null,
    onClick: (cid) => {
      openConversationById(cid);
      showWindow();
    },
  });
  store = new ConversationStore(P.conversations, { persist: cfg.savePrompts });
  if (!tabs) {
    tabs = new Tabs(store);
    tabs.restore(cfg.savePrompts && savedTabs ? savedTabs.ids : [], savedTabs && savedTabs.active, cwd);
    syncCwd();
  } else tabs.store = store; // --reload
}

// The working folder follows the active tab (a folder that is gone falls back to the scratch space).
function syncCwd() {
  const c = tabs.active().conv.cwd;
  cwd = typeof c === 'string' && !sec.checkWorkdir(c, 'read').error ? c : P.workspace;
}

// Tab bar on the interface side.
function publicTabs() {
  return tabs.list.map((t) => {
    const last = t.conv.turns[t.conv.turns.length - 1];
    return {
      id: t.id,
      title: t.conv.title || (last ? last.prompt.slice(0, 60) : ''),
      color: last && agents[last.agent] ? agents[last.agent].color : null,
      // Bot of the last turn, if it still exists: the tab shows it.
      bot: last && typeof last.bot === 'string' && Object.hasOwn(bots, last.bot) ? { id: last.bot, label: bots[last.bot].label, color: bots[last.bot].color, avatar: bots[last.bot].avatar, image: bots[last.bot].image } : null,
      running: !!t.run,
      unread: t.unread,
      active: t.id === tabs.activeId,
    };
  });
}

function pushTabs() {
  if (win && !win.isDestroyed()) win.webContents.send('aska:tabs', publicTabs());
  refreshTray();
}

function fsRealWorkspace() {
  try {
    return require('fs').realpathSync(P.workspace);
  } catch {
    return P.workspace;
  }
}

function saveState() {
  try {
    const open = tabs && cfg.savePrompts ? tabs.serialize() : {};
    sec.writePrivate(P.state, JSON.stringify({ cwd, pos: savedPos, models: picked, extraModels, resolvedModels, pinned, ...open }));
  } catch { /* state is a convenience, not a necessity */ }
}

// Folders are resolved (realpath): the home folder may be reached through a link
// (macOS /var -> /private/var, Fedora Silverblue /home -> /var/home), so both forms count.
const tilde = (p) => {
  if (p === P.workspace || p === fsRealWorkspace()) return t('app.scratch');
  const home = os.homedir();
  let real = home;
  try {
    real = require('fs').realpathSync(home);
  } catch { /* missing home: as is */ }
  for (const h of new Set([home, real])) {
    if (p === h) return '~';
    if (p.startsWith(h + path.sep)) return '~' + p.slice(h.length);
  }
  return p;
};

// Model used for an agent: choice in the UI, else config, else the CLI's default.
function modelFor(a) {
  return picked[a.id] || a.model || null;
}

// The CLI was given `asked` (null: its default) and reports `used`: remembered when they differ.
function noteResolved(agentId, asked, used) {
  const from = asked || '';
  if (!isModel(used) || used === asked) return;
  const r = resolvedModels[agentId] || (resolvedModels[agentId] = Object.create(null));
  if (r[from] === used) return;
  if (!Object.hasOwn(r, from) && Object.keys(r).length >= 30) return;
  r[from] = used;
  saveState();
}

function publicTurn(t) {
  const a = agents[t.agent];
  return {
    agentId: t.agent,
    label: t.label || t.agent,
    color: a ? a.color : '#888888',
    bot: typeof t.bot === 'string' ? t.bot : null,
    botLabel: typeof t.botLabel === 'string' ? t.botLabel : null,
    model: t.model || null,
    mode: t.mode,
    prompt: t.prompt,
    answer: t.answer,
    status: t.status,
    notice: t.notice || null,
    durationMs: t.durationMs || 0,
  };
}

// Conversation list for the UI: agent colors and readable folder.
function publicList() {
  return store.list().map((c) => ({
    id: c.id,
    title: c.title,
    updatedAt: c.updatedAt,
    turns: c.turns,
    preview: c.preview,
    cwd: c.cwd ? tilde(c.cwd) : null,
    agents: c.agents.map((label, i) => ({ label, color: agents[c.agentIds[i]] ? agents[c.agentIds[i]].color : '#888888' })),
  }));
}

function publicState() {
  const list = Object.values(agents).map((a) => ({
    id: a.id,
    label: a.label,
    color: a.color,
    available: !!a.binPath,
    error: a.binError,
    install: a.install || null,
    modes: MODE_ORDER.filter((m) => a.modes[m] && (m !== 'auto' || cfg.allowAutoMode)),
    canPickModel: !!a.modelFlag,
    models: [...new Set([...(a.models || []), ...(extraModels[a.id] || [])])],
    model: modelFor(a),
  }));
  return {
    lang: getLanguage(),
    strings: uiStrings(),
    // Shortcuts inside the window: parsed combos by action, and their labels for {key:…} in the strings.
    keys: cfg.keybindings,
    keyLabels: keyLabels(cfg.keybindings),
    agents: list,
    modes: Object.fromEntries(MODE_ORDER.map((m) => [m, { label: MODES[m].label, hint: MODES[m].hint }])),
    defaultAgent: cfg.defaultAgent,
    defaultMode: cfg.defaultMode,
    allowAutoMode: cfg.allowAutoMode,
    commands: Object.values(cfg.commands || {}),
    // Public fields only: the personality stays in the main process.
    bots: Object.values(bots).map((b) => ({ id: b.id, label: b.label, description: b.description, color: b.color, agent: b.agent, model: b.model, mode: b.mode, maxMode: b.maxMode, avatar: b.avatar, image: b.image, cwd: b.cwd })),
    cwd: tilde(cwd),
    cwdIsScratch: cwd === P.workspace,
    shortcut: shortcutOk ? cfg.shortcut : null,
    warnings,
    history: cfg.savePrompts ? sec.readRecentPrompts(P.audit) : [],
    running: !!tabs.active().run,
    // Running request of the active tab: the interface reattaches to it to follow the answer.
    run: tabs.active().run ? { id: tabs.active().run.id } : null,
    conversation: { id: tabs.active().conv.id, title: tabs.active().conv.title, turns: tabs.active().conv.turns.map(publicTurn) },
    tabs: publicTabs(),
    historyEnabled: cfg.savePrompts,
    pinned,
    unread,
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: cfg.alwaysOnTop,
    hasShadow: false,
    title: 'Aska',
    icon: path.join(__dirname, '..', '..', 'assets', 'aska.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged && process.env.ASKA_DEVTOOLS === '1',
    },
  });
  win.setMenu(null);
  if (cfg.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');
  // macOS: also visible on top of a full-screen application.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // The position chosen by moving the window is kept.
  win.on('moved', () => {
    const b = win.getBounds();
    savedPos = { x: b.x, bottom: b.y + b.height };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 400);
  });

  // The UI only loads its local file: no navigation, no window, no webview.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-redirect', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Click outside: the chat hides, unless it is pinned or collapsed into a pill
  // (whose whole point is to stay visible while you work).
  win.on('blur', () => {
    if (!pinned && !mini && !dialogOpen && !win.webContents.isDevToolsOpened()) hideWindow();
  });
  win.on('show', refreshTray);
  win.on('hide', refreshTray);
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hideWindow();
    }
  });
  win.loadFile(INDEX);
}

function showWindow() {
  if (!win) return;
  if (!win.isVisible()) {
    const [w, h] = win.getSize();
    let pos = null;
    if (savedPos) {
      // The saved position is reused only if it is still on a screen.
      const top = savedPos.bottom - h;
      const wa = screen.getDisplayMatching({ x: savedPos.x, y: top, width: w, height: h }).workArea;
      const inside = savedPos.x + 80 > wa.x && savedPos.x < wa.x + wa.width - 80 && top >= wa.y && savedPos.bottom <= wa.y + wa.height + 40;
      if (inside) pos = { x: savedPos.x, y: top };
    }
    if (!pos) {
      // Default: centered, input at about two thirds of the screen; the thread grows upward.
      const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      pos = { x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + wa.height * 0.68) - h };
    }
    win.setPosition(pos.x, pos.y);
  }
  win.show();
  win.focus();
  if (!mini) setUnread(0);
  win.webContents.send('aska:shown', publicState());
}

let hideTimer = null;
function hideWindow() {
  if (!win || !win.isVisible() || hideTimer) return;
  win.webContents.send('aska:will-hide');
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (win && !win.isDestroyed()) win.hide();
  }, 150);
}

function setUnread(n) {
  unread = n;
  if (win && !win.isDestroyed()) win.webContents.send('aska:unread', unread);
}

// Reopens a saved conversation in a tab (and its working folder, which session
// resume depends on).
function openConversationById(cid) {
  if (typeof cid !== 'string' || !cid) return { error: t('errors.conversationNotFound') };
  const r = tabs.open(cid);
  if (r.error) return r;
  syncCwd();
  saveState();
  pushTabs();
  return { ok: true };
}

function toggleWindow() {
  if (win && win.isVisible() && win.isFocused() && !mini) hideWindow();
  else showWindow();
}

// ---------- system tray icon ----------

function refreshTray() {
  if (!tray) return;
  const runs = tabs ? tabs.running() : [];
  tray.update({ running: runs.length, agentLabels: runs.map((tab) => tab.run.label), visible: !!win && win.isVisible() });
}

function setupTray() {
  if (!cfg.tray) {
    if (tray) tray.destroy();
    tray = null;
    return;
  }
  if (tray) return refreshTray();
  try {
    tray = createTray({ Tray, Menu, nativeImage }, {
      // The menu takes focus away from the window: rely on its visibility only.
      toggle: () => (win && win.isVisible() ? hideWindow() : showWindow()),
      new: () => {
        if (!win) return;
        showWindow();
        // Same path as Ctrl+N in the UI: a new tab.
        win.webContents.send('aska:new-conversation');
      },
      // Cancels every running request, across all tabs.
      cancel: () => {
        for (const tab of tabs ? tabs.running() : []) tab.run.handle.cancel();
        if (taskEngine) taskEngine.stopAll();
      },
      settings: () => {
        if (!win) return;
        showWindow();
        win.webContents.send('aska:open-settings');
      },
      quit: () => {
        quitting = true;
        app.quit();
      },
    });
  } catch (e) {
    tray = null;
    warnings.push(t('tray.unavailable', { error: e.message }));
    return;
  }
  refreshTray();
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  const register = (accel, fn) => {
    try {
      return globalShortcut.register(accel, fn);
    } catch {
      return false;
    }
  };
  shortcutOk = !!cfg.shortcut && register(cfg.shortcut, toggleWindow);
  if (cfg.shortcut && !shortcutOk) warnings.push(t('app.shortcutUnavailable', { shortcut: cfg.shortcut }));
  selectionShortcutOk = !!cfg.selectionShortcut && register(cfg.selectionShortcut, askAboutSelection);
  if (cfg.selectionShortcut && !selectionShortcutOk) {
    warnings.push(t('app.selectionShortcutUnavailable', { shortcut: cfg.selectionShortcut }));
  }
}

// "Ask about the selection": the window shows up with the selected text quoted
// in the field (see selection.js). Nothing is sent.
async function askAboutSelection() {
  if (!win) return;
  const sel = await readSelection(clipboard);
  if (!win || win.isDestroyed()) return;
  showWindow();
  win.webContents.send('aska:selection', {
    quote: sel.text ? quoteSelection(sel.text) : null,
    source: sel.source,
    truncated: sel.truncated,
    max: MAX_SELECTION,
  });
}

// ---------- settings panel (see settings.js) ----------

// GNOME: the global shortcut is a GNOME custom shortcut, set through gsettings
// (absolute path, no shell): the system one first (see gnome.js). null when not in a GNOME session.
function gnomeRunner() {
  if (!gnome.isGnomeSession()) return null;
  const bin = gnome.systemGsettings() || sec.resolveBinary(['gsettings'], { envPath: searchPath() }).path;
  if (!bin) return null;
  const r = { path: bin };
  const { execFile } = require('child_process');
  return (args) => new Promise((resolve, reject) => {
    execFile(r.path, args, { timeout: 5000 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)));
  });
}

async function settingsGet() {
  const view = settingsView(cfg);
  const run = gnomeRunner();
  let gnomeInfo = { active: false };
  if (run) {
    try {
      const g = await gnome.readShortcut(run);
      const s = await gnome.readShortcut(run, gnome.ENTRIES.selection);
      gnomeInfo = { active: true };
      view.values.shortcut = g.binding;
      view.values.selectionShortcut = s.binding;
    } catch (e) {
      gnomeInfo = { active: false, error: e.message }; // gsettings unusable: Aska's own shortcut
    }
  }
  const r = sec.readOwnedJson(P.config);
  const names = Object.fromEntries(['Ctrl', 'Alt', 'Shift', 'Meta', 'Super', 'Space', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'Delete', 'Tab', 'PageUp', 'PageDown', 'Home', 'End', 'Insert'].map((k) => [k, t(`keys.names.${k}`)]));
  return {
    ...view,
    actions: ACTIONS,
    languages: ['auto', ...LANGUAGES],
    agents: Object.values(agents).map((a) => ({ id: a.id, label: a.label, available: !!a.binPath })),
    gnome: gnomeInfo,
    keyNames: names,
    configError: r.error || null,
  };
}

async function settingsSave(patch) {
  const v = validateSettings(patch, { agentIds: Object.keys(agents) });
  if (Object.keys(v.errors).length) return { errors: v.errors };
  // The file is re-read as is, so that what the panel does not manage (agents…) is kept.
  const r = sec.readOwnedJson(P.config);
  if (r.error) return { errors: { _: r.error } };
  const values = { ...v.values };
  const run = gnomeRunner();
  // GNOME handles the global shortcuts: Aska does not register them too.
  for (const [k, entry] of [['shortcut', gnome.ENTRIES.toggle], ['selectionShortcut', gnome.ENTRIES.selection]]) {
    if (!run || !Object.hasOwn(values, k)) continue;
    try {
      await gnome.writeShortcut(run, values[k], gnome.toggleCommand({ appPath: app.getAppPath(), flag: entry.flag }), entry);
    } catch (e) {
      return { errors: { [k]: t('settings.errors.gnome', { error: e.message }) } };
    }
    values[k] = false;
  }
  try {
    const merged = mergeConfig(r.missing ? {} : r.data, values);
    sec.writePrivate(P.config, JSON.stringify(merged, null, 2) + '\n');
  } catch (e) {
    return { errors: { _: t('settings.errors.write', { error: e.message }) } };
  }
  // Applied at once, as with "aska --reload".
  loadEverything();
  registerShortcut();
  setupTray();
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!cfg.alwaysOnTop, 'floating');
  return { ok: true, state: publicState(), settings: await settingsGet() };
}

// ---------- IPC (each call checks its sender and its arguments) ----------

function fromOurUi(event) {
  return !!win && event.sender === win.webContents && event.senderFrame && event.senderFrame.url === INDEX_URL;
}

function handle(channel, fn) {
  ipcMain.handle(channel, (event, arg) => {
    if (!fromOurUi(event)) throw new Error('sender rejected');
    return fn(arg);
  });
}

function send(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('aska:run-event', payload);
}

function startRun(req) {
  if (!req || typeof req !== 'object') return { error: t('errors.invalidRequest') };
  const tab = typeof req.tabId === 'string' ? tabs.get(req.tabId) : null;
  if (!tab) return { error: t('errors.tabNotFound') };
  if (tab.run) return { error: t('errors.tabBusy') };
  // The limit counts the subtasks of the tasks too (when the task module is loaded).
  if (tabs.running().length + (taskEngine ? taskEngine.active : 0) >= MAX_RUNS) return { error: t('errors.tooManyRuns', { max: MAX_RUNS }) };
  const conv = tab.conv;
  const { agentId, mode, prompt, trust: trustChoice } = req;
  const agent = typeof agentId === 'string' && Object.hasOwn(agents, agentId) ? agents[agentId] : null;
  if (!agent) return { error: t('errors.unknownAgent') };
  if (!agent.binPath) return { error: t('errors.agentUnavailable', { agent: agent.label, error: agent.binError }) };
  if (!MODE_ORDER.includes(mode)) return { error: t('errors.unknownMode') };
  if (mode === 'auto' && !cfg.allowAutoMode) {
    return { error: t('errors.autoDisabled') };
  }
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000) return { error: t('errors.invalidPrompt') };
  // Bot chosen in the window: its personality, and a mode ceiling checked here, not only in the UI.
  let bot = null;
  if (req.botId !== undefined && req.botId !== null) {
    bot = typeof req.botId === 'string' && Object.hasOwn(bots, req.botId) ? bots[req.botId] : null;
    if (!bot) return { error: t('errors.unknownBot') };
    if (MODE_ORDER.indexOf(mode) > MODE_ORDER.indexOf(bot.maxMode)) {
      return { error: t('errors.botMaxMode', { bot: bot.label, mode: MODES[mode].label }) };
    }
  }

  const tabCwd = typeof conv.cwd === 'string' && !sec.checkWorkdir(conv.cwd, 'read').error ? conv.cwd : P.workspace;
  const dir = sec.checkWorkdir(tabCwd, mode, os.homedir(), [fsRealWorkspace()]);
  if (dir.error) return { error: dir.error };

  // Writing to a folder requires the user's explicit approval.
  // Some CLIs (Cursor) also require vouching for the folder's content, even
  // when reading: same approval, except in Aska's own empty folder.
  const contentTrust = !!agent.trustFlag && dir.path !== fsRealWorkspace();
  if ((mode !== 'read' || contentTrust) && !trust.isTrusted(dir.path)) {
    if (trustChoice === 'always') trust.add(dir.path);
    else if (trustChoice !== 'once') {
      return { needsTrust: true, cwd: tilde(dir.path), agent: agent.label, mode, reason: mode !== 'read' ? 'write' : 'content' };
    }
  }

  // Remote actions of the bot (push, PR, workflow…), in a writing mode and for
  // a CLI that applies allowed commands: with the "ask" policy, confirmed for
  // this request, always for this folder, or left out ("without").
  let granted = bot ? bot.allow : [];
  const remoteCmds = bot && mode !== 'read' && agent.allowFlag ? bot.allow.filter(isRemote) : [];
  if (remoteCmds.length && bot.remote !== 'auto' && !trust.isRemoteTrusted(dir.path, bot.id, remoteCmds)) {
    const choice = req.remote;
    if (choice === 'always') trust.addRemote(dir.path, bot.id, remoteCmds);
    else if (choice === 'without') granted = bot.allow.filter((c) => !isRemote(c));
    else if (choice !== 'once') return { needsRemote: true, bot: bot.label, cwd: tilde(dir.path), commands: remoteCmds };
  }
  const remoteGranted = granted.filter(isRemote);

  // Follow-up in a conversation: native resume if the CLI already has the whole
  // thread in its session (same agent, same folder), otherwise the context is fed back in.
  // A CLI session keeps the system prompt of its first request (Claude: system
  // prompt snapshot), so it is only resumed with the same bot and the same text.
  const persona = bot ? systemText(bot) : '';
  const sessionKey = bot ? `${agent.id}:${bot.id}:${fingerprint(persona)}` : agent.id;
  const sess = Object.hasOwn(conv.sessions, sessionKey) ? conv.sessions[sessionKey] : null;
  const resume = agent.resumeFlag && sess && sess.cwd === dir.path && sess.upTo === conv.turns.length ? sess.id : null;
  // Model: the request's ("/" command), else the bot's (on its own agent), else the one picked for the agent.
  let model = bot && bot.agent === agent.id && bot.model !== undefined ? bot.model : modelFor(agent);
  if (req.model !== undefined && agent.modelFlag) {
    if (req.model !== null && !isModel(req.model)) return { error: t('errors.invalidModel') };
    model = req.model;
  }

  const { excess, canPass } = commandFit(agent);
  let inv;
  try {
    inv = invocationFor({ agent, mode, prompt, turns: conv.turns, bot, model, resume, excess, canPass, allow: granted });
  } catch (e) {
    return { error: e.message };
  }

  const thread = conv;
  const turn = { agent: agent.id, label: agent.label, model, mode, prompt, answer: '', status: 'running', ts: new Date().toISOString() };
  if (bot) Object.assign(turn, { bot: bot.id, botLabel: bot.label });
  const who = bot ? bot.label : agent.label;
  thread.turns.push(turn);
  thread.cwd = dir.path;
  let sessionId = null;
  let streamError = null;
  let denied = null;

  const id = ++runSeq;
  const startedAt = new Date().toISOString();
  const handleRun = launchAgent(
    agent,
    inv.argv,
    {
      cwd: dir.path,
      stdin: inv.stdin,
      output: agent.output,
      timeoutMs: cfg.timeoutSec * 1000,
      maxBytes: cfg.maxOutputKb * 1024,
    },
    (ev) => {
      if (ev.type === 'text' && turn.answer.length < MAX_ANSWER) turn.answer += ev.text;
      else if (ev.type === 'session') sessionId = ev.id;
      else if (ev.type === 'meta' && ev.model) {
        turn.model = ev.model;
        noteResolved(agent.id, model, ev.model);
      }
      else if (ev.type === 'error') streamError = ev.text;
      else if (ev.type === 'denied') denied = ev;
      if (ev.type !== 'session') send({ id, tabId: tab.id, ...ev });
    }
  );
  tab.run = { id, handle: handleRun, label: who, botId: bot ? bot.id : null };
  pushTabs();

  handleRun.done.then((res) => {
    tab.run = null;
    if (taskEngine) taskEngine.pump(); // a place for a waiting subtask
    const ok = res.ok && !streamError;
    turn.status = ok ? 'ok' : res.reason === 'cancel' ? 'cancel' : 'error';
    turn.durationMs = res.durationMs;
    if (!ok && res.reason !== 'cancel') {
      turn.notice = {
        kind: 'error',
        text: [
          {
            timeout: t('errors.timeout', { sec: cfg.timeoutSec }),
            overflow: t('errors.overflow'),
            'spawn-error': t('errors.spawnError', { error: res.error }),
          }[res.reason] || streamError || t('errors.exitCode', { code: res.code }),
          (res.stderrTail || '').slice(-1500),
        ].filter(Boolean).join('\n\n'),
      };
    } else if (ok && denied) {
      turn.notice = {
        kind: 'warn',
        denied: true, // the window offers to run the request again in a wider mode
        text: t('notices.denied', { count: denied.count, mode: MODES[mode].label, tools: denied.tools.join(', ') }),
      };
    }
    // The CLI session only "covers" the thread if this turn succeeded.
    if (ok && sessionId && agent.resumeFlag) thread.sessions[sessionKey] = { id: sessionId, cwd: dir.path, upTo: thread.turns.length };
    else if (!ok) delete thread.sessions[sessionKey];
    store.save(thread);
    sec.appendAudit(P.audit, {
      ts: startedAt,
      agent: agent.id,
      bot: bot ? bot.id : undefined,
      // Remote actions the bot could run without asking for this request (policy or confirmation).
      remote: remoteGranted.length ? remoteGranted : undefined,
      mode,
      cwd: dir.path,
      bin: agent.binPath,
      argv: inv.logArgv,
      conversation: thread.id,
      model: turn.model,
      prompt: cfg.savePrompts ? prompt : undefined,
      result: res.reason,
      code: res.code ?? null,
      durationMs: res.durationMs,
    });
    // Answer arrived out of view (another tab, or hidden window): the tab flags it.
    const onScreen = !!win && win.isVisible() && !hideTimer && !mini && tabs.activeId === tab.id;
    if (turn.status !== 'cancel' && !onScreen && tabs.get(tab.id)) tab.unread = true;
    saveState();
    send({
      id,
      tabId: tab.id,
      type: 'end',
      turn: publicTurn(turn),
      title: thread.title,
      tabs: publicTabs(),
    });
    // A window that is hiding (exit animation) counts as hidden.
    const seen = { visible: !!win && win.isVisible() && !hideTimer, focused: !!win && win.isFocused(), mini, status: turn.status };
    if (shouldNotify(cfg.notify, seen)) {
      const content = notificationContent({
        agentLabel: who,
        status: turn.status,
        answer: turn.answer,
        notice: turn.notice,
        title: thread.title,
        preview: cfg.notifyPreview,
      });
      notifier({ conversationId: thread.id, ...content });
    }
    if (turn.status !== 'cancel' && (!seen.visible || mini)) setUnread(unread + 1);
  });
  return { ok: true, id };
}

// An agent's model list: those reported by its CLI (queried once, then on
// demand), plus the built-in list, the config and models typed in by hand.
async function listModels(req) {
  const a = req && typeof req.agentId === 'string' && Object.hasOwn(agents, req.agentId) ? agents[req.agentId] : null;
  if (!a || !a.modelFlag) return { models: [], current: null, error: null };
  if (a.binPath && (!discovered[a.id] || req.refresh === true)) {
    const cwdForList = fsRealWorkspace();
    discovered[a.id] = await discoverModels(a.id, (args, { stdin = '', timeoutMs = 12000 } = {}) => {
      let text = '';
      let err = '';
      const h = launchAgent(
        a,
        args,
        { cwd: cwdForList, stdin, output: 'text', timeoutMs, maxBytes: 512 * 1024 },
        (ev) => {
          if (ev.type === 'text') text += ev.text;
          else if (ev.type === 'stderr') err += ev.text;
        }
      );
      return h.done.then((r) => ({ ok: r.ok, text, err: err || r.stderrTail || '' }));
    }, process.env, { cwd: cwdForList });
  }
  const found = discovered[a.id] || { models: [], error: null };
  const byId = new Map();
  for (const id of a.models || []) byId.set(id, { id, label: null });
  for (const m of found.models) byId.set(m.id, { ...byId.get(m.id), ...m });
  for (const id of extraModels[a.id] || []) if (!byId.has(id)) byId.set(id, { id, label: null });
  const current = modelFor(a);
  if (current && !byId.has(current)) byId.set(current, { id: current, label: null });
  // An alias without a label shows the full name the CLI reported for it.
  const resolved = resolvedModels[a.id] || {};
  for (const m of byId.values()) if (!m.label && Object.hasOwn(resolved, m.id)) m.label = resolved[m.id];
  return {
    models: [...byId.values()],
    current,
    defaultModel: Object.hasOwn(resolved, '') ? resolved[''] : null,
    error: found.error,
    fromCli: found.models.length > 0,
  };
}

function registerIpc() {
  handle('aska:models', listModels);
  // Link clicked in an answer: opened in the browser, never in Aska,
  // and only over http(s) (no file:, javascript:, etc.).
  handle('aska:open-url', (url) => {
    if (typeof url !== 'string' || url.length > 2000) return false;
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    shell.openExternal(u.href);
    return true;
  });
  handle('aska:state', () => publicState());
  handle('aska:run', startRun);
  handle('aska:cancel', (tabId) => {
    const tab = typeof tabId === 'string' ? tabs.get(tabId) : tabs.active();
    if (tab && tab.run) tab.run.handle.cancel();
    return true;
  });
  handle('aska:hide', () => hideWindow());
  handle('aska:set-pinned', (v) => {
    pinned = v === true;
    saveState();
    return pinned;
  });
  // ----- tabs -----
  const tabChanged = (extra = {}) => {
    syncCwd();
    saveState();
    return { ...publicState(), ...extra };
  };
  // New tab, in the folder of the active tab.
  handle('aska:tab-new', () => {
    const r = tabs.create(cwd);
    return tabChanged(r.error ? { error: r.error } : {});
  });
  handle('aska:tab-activate', (id) => {
    if (typeof id === 'string') tabs.activate(id);
    return tabChanged();
  });
  handle('aska:tab-cycle', (dir) => {
    tabs.cycle(dir === -1 ? -1 : 1);
    return tabChanged();
  });
  // Closing a working tab asks for confirmation: its request will be cancelled.
  handle('aska:tab-close', (req) => {
    // No id: the active tab. A malformed id is refused, never replaced.
    const id = !req || req.id === undefined ? tabs.activeId : typeof req.id === 'string' ? req.id : null;
    const r = tabs.close(id, { force: !!(req && req.force === true), cwd });
    return tabChanged(r.needsConfirm ? { needsConfirm: id } : r.error ? { error: r.error } : {});
  });
  handle('aska:conv-new', () => {
    const r = tabs.create(cwd);
    return tabChanged(r.error ? { error: r.error } : {});
  });
  handle('aska:conv-list', () => publicList());
  handle('aska:conv-open', (cid) => {
    const r = openConversationById(cid);
    return { ...publicState(), ...(r.error ? { error: r.error } : {}) };
  });
  handle('aska:conv-delete', (cid) => {
    if (typeof cid !== 'string') return publicList();
    // A conversation open in a working tab is not deleted.
    if (tabs.forget(cid, cwd).error) return publicList();
    store.delete(cid);
    syncCwd();
    saveState();
    return publicList();
  });
  handle('aska:settings-get', () => settingsGet());
  handle('aska:settings-save', (values) => settingsSave(values));
  handle('aska:set-model', (req) => {
    const a = req && typeof req.agentId === 'string' && Object.hasOwn(agents, req.agentId) ? agents[req.agentId] : null;
    if (!a || !a.modelFlag) return publicState();
    if (req.model === null) delete picked[a.id];
    else if (isModel(req.model)) {
      picked[a.id] = req.model;
      if (!(a.models || []).includes(req.model)) {
        extraModels[a.id] = [req.model, ...(extraModels[a.id] || []).filter((m) => m !== req.model)].slice(0, 12);
      }
    }
    saveState();
    return publicState();
  });
  handle('aska:set-mini', (v) => {
    mini = v === true;
    if (!mini && win && win.isVisible()) setUnread(0);
  });
  // The window fits the panel: no transparent area blocks clicks around it.
  handle('aska:resize', (size) => {
    if (!size || !Number.isFinite(size.w) || !Number.isFinite(size.h)) return;
    const w = Math.round(Math.min(Math.max(size.w, 120), 900));
    const h = Math.round(Math.min(Math.max(size.h, 40), 800));
    const b = win.getBounds();
    if (b.width === w && b.height === h) return;
    // The bottom edge stays put: the input area does not move when the thread grows.
    const wa = screen.getDisplayMatching(b).workArea;
    const y = Math.max(wa.y, b.y + b.height - h);
    win.setResizable(true);
    win.setBounds({ x: b.x, y, width: w, height: h });
    win.setResizable(false);
  });
  handle('aska:copy', (text) => {
    if (typeof text === 'string' && text.length < 5_000_000) clipboard.writeText(text);
    return true;
  });
  handle('aska:reset-dir', () => {
    if (tabs.active().run) return publicState();
    cwd = P.workspace;
    tabs.active().conv.cwd = cwd;
    saveState();
    return publicState();
  });
  // "/cd <folder>" typed in the field: "~" is the home folder, a relative path
  // starts from the tab's folder (from home in the scratch space). Same checks as the picker.
  handle('aska:set-dir', (raw) => {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 4096 || raw.includes('\0')) return { ...publicState(), error: t('errors.invalidFolder') };
    if (tabs.active().run) return { ...publicState(), error: t('errors.tabBusy') };
    let p = raw.trim();
    if (p === '~' || p.startsWith('~/') || p.startsWith('~' + path.sep)) p = path.join(os.homedir(), p.slice(1));
    if (!path.isAbsolute(p)) p = path.resolve(cwd === P.workspace ? os.homedir() : cwd, p);
    const d = sec.checkWorkdir(p, 'read');
    if (d.error) return { ...publicState(), error: d.error };
    cwd = d.path;
    tabs.active().conv.cwd = cwd;
    saveState();
    return publicState();
  });
  handle('aska:pick-dir', async () => {
    dialogOpen = true;
    try {
      const r = await dialog.showOpenDialog(win, {
        title: t('app.pickDirTitle'),
        defaultPath: cwd === P.workspace ? os.homedir() : cwd,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (!r.canceled && r.filePaths[0]) {
        const d = sec.checkWorkdir(r.filePaths[0], 'read');
        if (!d.error && !tabs.active().run) {
          cwd = d.path;
          tabs.active().conv.cwd = cwd; // the folder belongs to the tab
          saveState();
        }
      }
    } finally {
      dialogOpen = false;
      if (win) win.focus();
    }
    return publicState();
  });

  // A bot's picture, chosen by hand (the settings' Bots tab): copied into its
  // folder, resized or cleaned (see importAvatar), then the bots are read again.
  handle('aska:bot-avatar-pick', async (id) => {
    const bot = typeof id === 'string' && Object.hasOwn(bots, id) ? bots[id] : null;
    if (!bot) return { ...publicState(), error: t('errors.unknownBot') };
    let error = null;
    dialogOpen = true;
    try {
      const r = await dialog.showOpenDialog(win, {
        title: t('app.pickAvatarTitle', { bot: bot.label }),
        defaultPath: os.homedir(),
        properties: ['openFile'],
        filters: [{ name: t('app.avatarFilter'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }],
      });
      if (!r.canceled && r.filePaths[0]) error = importAvatar(bot.dir, r.filePaths[0], { nativeImage }).error || null;
    } finally {
      dialogOpen = false;
      if (win) win.focus();
    }
    reloadBots();
    return error ? { ...publicState(), error } : publicState();
  });
  handle('aska:bots-list', () => ({ bots: botsList(), folder: tilde(P.bots) }));
  // Saves what the settings changed (see saveBot: the fields kept in the files stay).
  handle('aska:bot-save', (req) => {
    const id = req && typeof req.id === 'string' ? req.id : null;
    // A bot turned off can be turned on again from here.
    const bot = id && Object.hasOwn(bots, id) ? bots[id] : id && Object.hasOwn(offBots, id) ? offBots[id] : null;
    if (!bot) return { errors: { _: t('errors.unknownBot') } };
    if (req.values && req.values.enabled === false && botBusy(id)) return { errors: { enabled: t('bots.busy', { bot: bot.label }) } };
    const r = saveBot(bot.dir, req.values, { agents, allowAutoMode: cfg.allowAutoMode });
    if (r.errors) return r;
    reloadBots();
    return { bots: botsList(), state: publicState() };
  });
  // New bot: for the default agent (else the first one installed), read-only.
  // With a proposal (drafted below, then reviewed by the user): its fields too,
  // checked by saveBot; if one is refused, the new folder is removed.
  handle('aska:bot-create', async (req) => {
    const { label, ...fields } = typeof req === 'string' ? { label: req } : req && typeof req === 'object' ? req : {};
    const agent = draftAgent();
    if (!agent) return { errors: { _: t('errors.unknownAgent') } };
    const taken = [...Object.values(bots), ...Object.values(offBots)].map((b) => b.label);
    const r = createBot(P.bots, { label, agent: agent.id, taken });
    if (r.errors) return r;
    const values = {};
    for (const k of ['description', 'soul', 'maxMode', 'allow']) if (fields[k] !== undefined) values[k] = fields[k];
    if (fields.emblem !== undefined) values.avatar = { emblem: fields.emblem };
    if (Object.keys(values).length) {
      const s = saveBot(path.join(P.bots, r.id), values, { agents, allowAutoMode: cfg.allowAutoMode });
      if (s.errors) {
        await deleteBot(P.bots, r.id);
        return s;
      }
    }
    reloadBots();
    return { id: r.id, bots: botsList(), state: publicState() };
  });
  // A bot drafted from a description: the default agent, read-only, in Aska's
  // own empty folder, is asked for a proposal. Nothing is written: the settings
  // show it to be reviewed, then "Create" saves it.
  let draftRun = null;
  handle('aska:bot-draft', async (description) => {
    if (typeof description !== 'string' || !description.trim() || description.length > DESCRIPTION_MAX || description.includes('\0')) {
      return { error: t('bots.draft.invalid', { max: DESCRIPTION_MAX }) };
    }
    if (draftRun) return { error: t('bots.draft.busy') };
    const agent = draftAgent();
    if (!agent || !agent.binPath) return { error: t('errors.unknownAgent') };
    let inv;
    try {
      inv = buildInvocation(agent, 'read', draftPrompt(description.trim(), getLanguage()), { model: modelFor(agent), trusted: true });
    } catch (e) {
      return { error: e.message };
    }
    let answer = '';
    draftRun = launchAgent(
      agent,
      inv.argv,
      { cwd: fsRealWorkspace(), stdin: inv.stdin, output: agent.output, timeoutMs: Math.min(cfg.timeoutSec, 300) * 1000, maxBytes: 512 * 1024 },
      (ev) => {
        if (ev.type === 'text') answer += ev.text;
      }
    );
    const res = await draftRun.done;
    draftRun = null;
    if (res.reason === 'cancel') return { cancelled: true };
    if (!res.ok && !answer.trim()) return { error: t('bots.draft.failed', { agent: agent.label, error: res.error || (res.stderrTail || '').slice(-300) || res.reason }) };
    const d = parseDraft(answer);
    return d.error ? { error: d.error } : { draft: d.draft, agent: agent.label };
  });
  handle('aska:bot-draft-cancel', () => {
    if (draftRun) draftRun.cancel();
  });
  // Deleted for good is too much for a slip: the folder goes to the trash when the system has one.
  handle('aska:bot-delete', async (id) => {
    const bot = typeof id === 'string' && Object.hasOwn(bots, id) ? bots[id] : typeof id === 'string' && Object.hasOwn(offBots, id) ? offBots[id] : null;
    if (!bot) return { error: t('errors.unknownBot') };
    if (botBusy(id)) return { error: t('bots.busy', { bot: bot.label }) };
    // ASKA_NO_TRASH: the tests never fill the trash of the machine that runs them.
    const r = await deleteBot(P.bots, id, { trash: process.env.ASKA_NO_TRASH ? null : (p) => shell.trashItem(p) });
    reloadBots();
    return r.error ? { error: r.error, bots: botsList(), state: publicState() } : { bots: botsList(), state: publicState() };
  });
  handle('aska:bot-open-folder', (id) => {
    const bot = typeof id === 'string' && Object.hasOwn(bots, id) ? bots[id] : typeof id === 'string' && Object.hasOwn(offBots, id) ? offBots[id] : null;
    if (bot) shell.openPath(bot.dir);
  });
  handle('aska:bot-avatar-clear', (id) => {
    const bot = typeof id === 'string' && Object.hasOwn(bots, id) ? bots[id] : null;
    if (!bot) return { ...publicState(), error: t('errors.unknownBot') };
    clearAvatar(bot.dir);
    reloadBots();
    return publicState();
  });
}

// The settings' Bots tab: every editable field, the personality included (it
// only leaves the main process here, when the settings ask for it).
function botsList() {
  return Object.values(bots).map((b) => {
    const a = agents[b.agent];
    return {
      id: b.id,
      label: b.label,
      description: b.description,
      color: b.ownColor ? b.color : '',
      model: typeof b.model === 'string' ? b.model : '',
      mode: b.mode,
      maxMode: b.maxMode,
      agent: b.agent,
      agentLabel: a ? a.label : b.agent,
      models: a ? [...new Set([...(a.models || []), ...(extraModels[a.id] || [])])] : [],
      modes: MODE_ORDER.filter((m) => a && a.modes[m] && m !== 'auto'),
      // Ceilings the settings offer: auto only when the config allows it.
      maxModes: MODE_ORDER.filter((m) => a && a.modes[m] && (m !== 'auto' || cfg.allowAutoMode)),
      allow: b.allow,
      remote: b.remote,
      allowSupported: !!(a && a.allowFlag),
      avatar: b.avatar,
      image: b.image,
      soul: b.soul,
      cwd: b.cwd ? tilde(b.cwd) : null,
      enabled: true,
    };
  }).concat(Object.values(offBots).map((o) => ({ id: o.id, label: o.label, description: o.description, enabled: false })));
}

// Agent of a new bot, and of the drafts: the default agent, else the first one installed.
function draftAgent() {
  const usable = Object.values(agents).filter((a) => a.binPath);
  return agents[cfg.defaultAgent] && agents[cfg.defaultAgent].binPath ? agents[cfg.defaultAgent] : usable[0] || agents.claude || null;
}

// A bot answering in a tab: it can be neither deleted nor turned off.
const botBusy = (id) => tabs.list.some((x) => x.run && x.run.botId === id);

// ---------- tasks (several bots at once, each in its worktree) ----------
// Loaded on first use only: Aska starts and runs as before for whoever never opens them.

let taskEngine = null;

function tasksModule() {
  if (taskEngine) return taskEngine;
  const git = sec.resolveBinary(['git'], { envPath: searchPath() });
  if (git.error) throw new Error(t('tasks.noGit', { error: git.error }));
  const { TaskEngine } = require('./tasks/engine');
  const { TaskStore } = require('./tasks/store');
  taskEngine = new TaskEngine({
    store: new TaskStore(P.tasks),
    gitBin: git.path,
    worktreesDir: P.worktrees,
    launch: launchSubtask,
    busy: () => tabs.running().length,
    max: MAX_RUNS,
    onUpdate: (task) => {
      if (win && !win.isDestroyed()) win.webContents.send('aska:task', publicTask(task));
    },
  });
  taskEngine.gitBin = git.path;
  return taskEngine;
}

// A subtask's agent, run like a tab's request: its bot (personality, model,
// allowed commands: granted when the task was approved), in its worktree.
// The bot of a subtask: one of ~/.aska/bots, or its temporary bot (read again from its folder).
function subtaskBot(s) {
  if (s.botDir) return require('./tasks/bots').loadTempBot(s.botDir, s.n, { agents, allowAutoMode: cfg.allowAutoMode });
  return Object.hasOwn(bots, s.botId) ? bots[s.botId] : null;
}

function launchSubtask(task, s) {
  const bot = subtaskBot(s);
  if (!bot) return { error: t('errors.unknownBot') };
  const agent = agents[bot.agent];
  if (!agent || !agent.binPath) return { error: t('errors.agentUnavailable', { agent: bot.agent, error: agent ? agent.binError : '' }) };
  // The worktree is Aska's own folder (as the scratch space): writing there needs no other approval.
  const dir = sec.checkWorkdir(s.worktree, s.mode, os.homedir(), [fs.realpathSync(s.worktree)]);
  if (dir.error) return { error: dir.error };
  const { excess, canPass } = commandFit(agent);
  const model = bot.model !== undefined ? bot.model : modelFor(agent);
  const inv = invocationFor({ agent, mode: s.mode, prompt: s.prompt, turns: [], bot, model, excess, canPass, allow: s.allow });
  let answer = '';
  const startedAt = new Date().toISOString();
  const handle = launchAgent(
    agent,
    inv.argv,
    { cwd: dir.path, stdin: inv.stdin, output: agent.output, timeoutMs: cfg.timeoutSec * 1000, maxBytes: cfg.maxOutputKb * 1024 },
    (ev) => {
      if (ev.type === 'text' && answer.length < MAX_ANSWER) answer += ev.text;
    }
  );
  return {
    cancel: () => handle.cancel(),
    done: handle.done.then((res) => {
      sec.appendAudit(P.audit, {
        ts: startedAt,
        task: task.id,
        subtask: s.n,
        agent: agent.id,
        bot: bot.id,
        mode: s.mode,
        cwd: dir.path,
        bin: agent.binPath,
        argv: inv.logArgv,
        remote: s.allow.filter(isRemote).length ? s.allow.filter(isRemote) : undefined,
        prompt: cfg.savePrompts ? s.prompt : undefined,
        result: res.reason,
        code: res.code ?? null,
        durationMs: res.durationMs,
      });
      return { ...res, answer };
    }),
  };
}

// What the window sees of a task (the bots by their public fields).
function publicTask(task) {
  return {
    ...task,
    subtasks: task.subtasks.map((s) => {
      const b = subtaskBot(s);
      const { botDir, ...rest } = s;
      return { ...rest, temporary: !!botDir, repo: tilde(s.repo), worktree: s.worktree ? tilde(s.worktree) : null, bot: b ? { id: b.id, label: b.label, color: b.color, avatar: b.avatar, image: b.image } : { id: s.botId, label: s.botLabel || s.botId } };
    }),
    root: tilde(task.root),
  };
}

function setupTaskIpc() {
  const engineOr = (fn) => {
    try {
      return fn(tasksModule());
    } catch (e) {
      return { error: e.message };
    }
  };
  handle('aska:tasks-list', () => engineOr((e) => ({ tasks: e.list().map(publicTask) })));
  handle('aska:task-create', (input) =>
    engineOr((e) => {
      const { checkTask } = require('./tasks/check');
      const draft = draftAgent();
      const c = checkTask(input, { bots, agents, allowAutoMode: cfg.allowAutoMode, gitBin: e.gitBin, defaultAgent: draft ? draft.id : undefined });
      if (c.error) return c;
      // Temporary bots: written into the task's folder once it has its id.
      const task = e.store.create(c);
      const { writeTempBot } = require('./tasks/bots');
      for (const s of task.subtasks) {
        if (!s.temp) continue;
        s.botDir = path.join(e.store.botsDir(task.id), String(s.n));
        s.botLabel = s.temp.label;
        writeTempBot(s.botDir, s.temp);
        delete s.temp;
      }
      return { task: publicTask(e.add(task)) };
    })
  );
  handle('aska:task-start', (req) => engineOr((e) => e.start(req && req.id, req && Array.isArray(req.numbers) ? req.numbers : null)));
  handle('aska:task-cancel', (req) => engineOr((e) => e.cancel(req && req.id, req && Number.isInteger(req.n) ? req.n : null)));
  handle('aska:task-cleanup', (id) => engineOr((e) => e.cleanup(id)));
  // Keeps a temporary bot: copied into ~/.aska/bots, offered with "@" from now on.
  handle('aska:task-keep-bot', (req) =>
    engineOr((e) => {
      const task = req && typeof req.id === 'string' ? e.get(req.id) : null;
      const s = task && Number.isInteger(req.n) ? task.subtasks.find((x) => x.n === req.n) : null;
      if (!s || !s.botDir) return { error: t('tasks.unknown') };
      if (s.kept) return { error: t('tasks.alreadyKept', { bot: s.kept }) };
      const taken = [...Object.values(bots), ...Object.values(offBots)].map((b) => b.label);
      const r = require('./tasks/bots').keepTempBot(s.botDir, { botsDir: P.bots, taken, agents, allowAutoMode: cfg.allowAutoMode });
      if (r.errors) return { error: Object.values(r.errors)[0] };
      s.kept = r.id;
      e.changed(task);
      reloadBots();
      return { botId: r.id, task: publicTask(task), state: publicState() };
    })
  );
}

// Bots read again after a change made from the window (their warnings were shown at startup).
function reloadBots() {
  const r = loadBots(P.bots, { agents, allowAutoMode: cfg.allowAutoMode });
  bots = r.bots;
  offBots = r.off;
  pushTabs();
}

// ---------- lifecycle ----------

const argv = process.argv.slice(1);

// "aska --help" / "--version": answer in the terminal, without opening a window.
if (wantsCliOutput(argv)) {
  printCli(argv);
  app.exit(0);
}
const wants = (flag) => argv.includes(flag);

const APP_FLAGS = ['--toggle', '--selection', '--hidden', '--reload', '--restart', '--replaced', '--quit', '--no-autostart'];

// Replaces the running instance: a helper instance sends it "--quit"
// (understood even by old versions), then we relaunch in its place.
// "--replaced" prevents any loop if the old instance refuses to close.
function replaceRunningInstance() {
  const { spawn } = require('child_process');
  const root = app.getAppPath();
  const chromiumFlags = argv.filter((a) => a.startsWith('--') && !APP_FLAGS.includes(a));
  spawn(process.execPath, [...chromiumFlags, root, '--quit'], { detached: true, stdio: 'ignore', env: process.env }).unref();
  setTimeout(() => {
    const userArgs = argv.filter((a) => APP_FLAGS.includes(a) && a !== '--restart');
    app.relaunch({ args: [...chromiumFlags, root, ...userArgs, '--replaced'] });
    app.exit(0);
  }, 2500);
}

// Windows: notifications only show if a Start menu shortcut carries the app's
// identity (AppUserModelID). Only Electron's shortcut API can write it, so
// scripts/install.ps1 calls "--install-shortcuts".
const APP_ID = 'aska';
if (process.platform === 'win32' && wants('--install-shortcuts')) {
  // Never hang: whatever happens, the process ends.
  const done = (code, out) => {
    (code ? process.stderr : process.stdout).write(out + '\n');
    app.exit(code);
  };
  setTimeout(() => done(2, 'Timed out while creating the shortcuts.'), 30000).unref();
  app.whenReady().then(() => {
    const fs = require('fs');
    loadConfig(P.config, { systemLangs: systemLangs() }); // language of the shortcut description
    const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const root = path.join(__dirname, '..', '..');
    const link = (file, args) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // "create" creates the shortcut or overwrites it ("replace" fails if it does not exist).
      const ok = shell.writeShortcutLink(file, 'create', {
        target: process.execPath,
        args: `"${root}" ${args}`,
        cwd: root,
        description: t('app.shortcutDescription'),
        icon: process.execPath,
        iconIndex: 0,
        appUserModelId: APP_ID,
      });
      if (!ok) throw new Error(`cannot write ${file}`);
      const back = shell.readShortcutLink(file);
      if (back.appUserModelId !== APP_ID) throw new Error(`identity missing from shortcut ${file}`);
      return { file, appUserModelId: back.appUserModelId, target: back.target };
    };
    const startup = path.join(programs, 'Startup', 'Aska.lnk');
    const made = [link(path.join(programs, 'Aska.lnk'), '--toggle')];
    if (wants('--no-autostart')) fs.rmSync(startup, { force: true });
    else made.push(link(startup, '--hidden'));
    done(0, JSON.stringify(made));
  }).catch((e) => done(1, `Cannot create the shortcuts: ${e.message}`));
} else if (!app.requestSingleInstanceLock()) {
  // An instance is already running: it receives our arguments ("second-instance") and toggles.
  // But if it runs other code than ours (Aska updated without being relaunched),
  // its features are stale: we replace it instead of reopening it.
  const running = runningInstance(sec.readOwnedJson, P.run);
  const stale = !running || running.build !== BUILD;
  if ((stale || wants('--restart')) && !wants('--quit') && !wants('--replaced')) replaceRunningInstance();
  else app.quit();
} else {
  app.on('second-instance', (_e, secondArgv) => {
    if (secondArgv.includes('--quit')) {
      quitting = true;
      app.quit();
    } else if (secondArgv.includes('--selection')) {
      askAboutSelection();
    } else if (secondArgv.includes('--reload')) {
      loadEverything();
      registerShortcut();
      setupTray();
    } else {
      toggleWindow();
    }
  });

  // Windows: app identity, required for notifications.
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  app.whenReady().then(() => {
    if (wants('--quit')) return app.quit();
    // macOS: Aska is a background tool, with no Dock icon or menu.
    if (process.platform === 'darwin') app.setActivationPolicy('accessory');
    // Active instance: this file identifies it (aska --help, replacement).
    try {
      sec.writePrivate(P.run, JSON.stringify({ pid: process.pid, build: BUILD, version: app.getVersion(), startedAt: new Date().toISOString() }));
    } catch { /* convenience only */ }
    // No web permission (camera, geolocation, web notifications…) is granted.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);

    loadEverything();
    registerIpc();
    setupTaskIpc();
    registerShortcut();
    createWindow();
    setupTray();
    win.webContents.once('did-finish-load', () => {
      if (wants('--selection')) askAboutSelection();
      else if (!wants('--hidden')) showWindow();
    });
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  app.on('before-quit', () => {
    quitting = true;
    for (const t of tabs ? tabs.running() : []) t.run.handle.cancel();
    if (taskEngine) taskEngine.stopAll();
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (tray) tray.destroy();
    // Only remove the file if it is still ours (a new instance may have rewritten it).
    try {
      const r = sec.readOwnedJson(P.run);
      if (r.data && r.data.pid === process.pid) require('fs').rmSync(P.run, { force: true });
    } catch { /* already removed */ }
  });
  app.on('window-all-closed', () => {}); // the app stays resident
}
