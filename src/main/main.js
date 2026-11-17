'use strict';
const { app, BrowserWindow, globalShortcut, ipcMain, dialog, screen, clipboard, Notification, session, shell } = require('electron');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { paths, loadConfig } = require('./config');
const { MODES, MODE_ORDER, resolveAgents, buildInvocation, isModel } = require('./agents');
const { ConversationStore, buildContextPrompt, MAX_ANSWER } = require('./conversations');
const { discoverModels } = require('./models');
const { shouldNotify, notificationContent, createNotifier } = require('./notify');
const sec = require('./security');
const { runAgent } = require('./runner');
const { resolveLaunch, buildCommand, extendedPath } = require('./launch');
const { buildId, runningInstance } = require('./build');
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
let warnings = [];
let trust = null;
let cwd = null;
let current = null; // run in progress: { id, handle }
let runSeq = 0;
let dialogOpen = false;
let shortcutOk = false;
let quitting = false;
let mini = false; // panel collapsed into a pill
let pinned = null; // pinned: stays visible when clicking elsewhere (null = per config)
let unread = 0; // answers that arrived while the chat was out of sight
let notifier = null;
let savedPos = null; // anchor chosen by the user: left edge and BOTTOM edge of the window
let saveTimer = null;
let store = null; // saved conversations
let conv = null; // displayed conversation
const picked = {}; // model chosen per agent: { claude: 'opus' } (missing = default)
const extraModels = {}; // models typed in by hand, per agent
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
    if (typeof d.pinned === 'boolean') pinned = d.pinned;
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
  if (!conv) conv = store.create(cwd);
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
    sec.writePrivate(P.state, JSON.stringify({ cwd, pos: savedPos, models: picked, extraModels, pinned }));
  } catch { /* state is a convenience, not a necessity */ }
}

const tilde = (p) => {
  const home = os.homedir();
  if (p === P.workspace || p === fsRealWorkspace()) return t('app.scratch');
  return p === home ? '~' : p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
};

// Model used for an agent: choice in the UI, else config, else the CLI's default.
function modelFor(a) {
  return picked[a.id] || a.model || null;
}

function publicTurn(t) {
  const a = agents[t.agent];
  return {
    agentId: t.agent,
    label: t.label || t.agent,
    color: a ? a.color : '#888888',
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
    agents: list,
    modes: Object.fromEntries(MODE_ORDER.map((m) => [m, { label: MODES[m].label, hint: MODES[m].hint }])),
    defaultAgent: cfg.defaultAgent,
    defaultMode: cfg.defaultMode,
    allowAutoMode: cfg.allowAutoMode,
    cwd: tilde(cwd),
    cwdIsScratch: cwd === P.workspace,
    shortcut: shortcutOk ? cfg.shortcut : null,
    warnings,
    history: cfg.savePrompts ? sec.readRecentPrompts(P.audit) : [],
    running: !!current,
    conversation: { id: conv.id, title: conv.title, turns: conv.turns.map(publicTurn) },
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
  win.setVisibleOnAllWorkspaces(true);
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

// Reopens a saved conversation (and its working folder).
function openConversationById(cid) {
  if (current || !cid || conv.id === cid) return;
  const c = store.load(cid);
  if (!c) return;
  conv = c;
  // Restore the conversation's folder: session resume depends on it.
  if (typeof c.cwd === 'string' && !sec.checkWorkdir(c.cwd, 'read').error) {
    cwd = c.cwd;
    saveState();
  }
}

function toggleWindow() {
  if (win && win.isVisible() && win.isFocused() && !mini) hideWindow();
  else showWindow();
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  shortcutOk = false;
  if (!cfg.shortcut) return;
  try {
    shortcutOk = globalShortcut.register(cfg.shortcut, toggleWindow);
  } catch {
    shortcutOk = false;
  }
  if (!shortcutOk) {
    warnings.push(t('app.shortcutUnavailable', { shortcut: cfg.shortcut }));
  }
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
  if (current) return { error: t('errors.busy') };
  if (!req || typeof req !== 'object') return { error: t('errors.invalidRequest') };
  const { agentId, mode, prompt, trust: trustChoice } = req;
  const agent = typeof agentId === 'string' && Object.hasOwn(agents, agentId) ? agents[agentId] : null;
  if (!agent) return { error: t('errors.unknownAgent') };
  if (!agent.binPath) return { error: t('errors.agentUnavailable', { agent: agent.label, error: agent.binError }) };
  if (!MODE_ORDER.includes(mode)) return { error: t('errors.unknownMode') };
  if (mode === 'auto' && !cfg.allowAutoMode) {
    return { error: t('errors.autoDisabled') };
  }
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000) return { error: t('errors.invalidPrompt') };

  const dir = sec.checkWorkdir(cwd, mode, os.homedir(), [fsRealWorkspace()]);
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

  // Follow-up in a conversation: native resume if the CLI already has the whole
  // thread in its session (same agent, same folder), otherwise the context is fed back in.
  const sess = conv.sessions[agent.id];
  const resume = agent.resumeFlag && sess && sess.cwd === dir.path && sess.upTo === conv.turns.length ? sess.id : null;
  const fullPrompt = resume ? prompt : buildContextPrompt(conv.turns, prompt);
  const model = modelFor(agent);

  let inv;
  try {
    inv = buildInvocation(agent, mode, fullPrompt, { model, resume, trusted: true });
  } catch (e) {
    return { error: e.message };
  }

  const thread = conv;
  const turn = { agent: agent.id, label: agent.label, model, mode, prompt, answer: '', status: 'running', ts: new Date().toISOString() };
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
      else if (ev.type === 'meta' && ev.model) turn.model = ev.model;
      else if (ev.type === 'error') streamError = ev.text;
      else if (ev.type === 'denied') denied = ev;
      if (ev.type !== 'session') send({ id, ...ev });
    }
  );
  current = { id, handle: handleRun };

  handleRun.done.then((res) => {
    current = null;
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
        text: t('notices.denied', { count: denied.count, mode: MODES[mode].label, tools: denied.tools.join(', ') }),
      };
    }
    // The CLI session only "covers" the thread if this turn succeeded.
    if (ok && sessionId && agent.resumeFlag) thread.sessions[agent.id] = { id: sessionId, cwd: dir.path, upTo: thread.turns.length };
    else if (!ok) delete thread.sessions[agent.id];
    store.save(thread);
    sec.appendAudit(P.audit, {
      ts: startedAt,
      agent: agent.id,
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
    send({
      id,
      type: 'end',
      turn: publicTurn(turn),
      title: thread.title,
    });
    // A window that is hiding (exit animation) counts as hidden.
    const seen = { visible: !!win && win.isVisible() && !hideTimer, focused: !!win && win.isFocused(), mini, status: turn.status };
    if (shouldNotify(cfg.notify, seen)) {
      const content = notificationContent({
        agentLabel: agent.label,
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
    discovered[a.id] = await discoverModels(a.id, (args) => {
      let text = '';
      const h = launchAgent(
        a,
        args,
        { cwd: fsRealWorkspace(), stdin: '', output: 'text', timeoutMs: 12000, maxBytes: 512 * 1024 },
        (ev) => { if (ev.type === 'text') text += ev.text; }
      );
      return h.done.then((r) => ({ ok: r.ok, text }));
    }, process.env);
  }
  const found = discovered[a.id] || { models: [], error: null };
  const byId = new Map();
  for (const id of a.models || []) byId.set(id, { id, label: null });
  for (const m of found.models) byId.set(m.id, { ...byId.get(m.id), ...m });
  for (const id of extraModels[a.id] || []) if (!byId.has(id)) byId.set(id, { id, label: null });
  const current = modelFor(a);
  if (current && !byId.has(current)) byId.set(current, { id: current, label: null });
  return { models: [...byId.values()], current, error: found.error, fromCli: found.models.length > 0 };
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
  handle('aska:cancel', () => {
    if (current) current.handle.cancel();
    return true;
  });
  handle('aska:hide', () => hideWindow());
  handle('aska:set-pinned', (v) => {
    pinned = v === true;
    saveState();
    return pinned;
  });
  handle('aska:conv-new', () => {
    if (!current) conv = store.create(cwd);
    return publicState();
  });
  handle('aska:conv-list', () => publicList());
  handle('aska:conv-open', (cid) => {
    if (typeof cid === 'string') openConversationById(cid);
    return publicState();
  });
  handle('aska:conv-delete', (cid) => {
    if (current && conv.id === cid) return publicList();
    store.delete(cid);
    if (conv.id === cid) conv = store.create(cwd);
    return publicList();
  });
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
    cwd = P.workspace;
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
        if (!d.error) {
          cwd = d.path;
          saveState();
        }
      }
    } finally {
      dialogOpen = false;
      if (win) win.focus();
    }
    return publicState();
  });
}

// ---------- lifecycle ----------

const argv = process.argv.slice(1);

// "aska --help" / "--version": answer in the terminal, without opening a window.
if (wantsCliOutput(argv)) {
  printCli(argv);
  app.exit(0);
}
const wants = (flag) => argv.includes(flag);

const APP_FLAGS = ['--toggle', '--hidden', '--reload', '--restart', '--replaced', '--quit', '--no-autostart'];

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
    } else if (secondArgv.includes('--reload')) {
      loadEverything();
      registerShortcut();
    } else {
      toggleWindow();
    }
  });

  // Windows: app identity, required for notifications.
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  app.whenReady().then(() => {
    if (wants('--quit')) return app.quit();
    // Active instance: this file identifies it (aska --help, replacement).
    try {
      sec.writePrivate(P.run, JSON.stringify({ pid: process.pid, build: BUILD, version: app.getVersion(), startedAt: new Date().toISOString() }));
    } catch { /* convenience only */ }
    // No web permission (camera, geolocation, web notifications…) is granted.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);

    loadEverything();
    registerIpc();
    registerShortcut();
    createWindow();
    win.webContents.once('did-finish-load', () => {
      if (!wants('--hidden')) showWindow();
    });
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  app.on('before-quit', () => {
    quitting = true;
    if (current) current.handle.cancel();
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    // Only remove the file if it is still ours (a new instance may have rewritten it).
    try {
      const r = sec.readOwnedJson(P.run);
      if (r.data && r.data.pid === process.pid) require('fs').rmSync(P.run, { force: true });
    } catch { /* already removed */ }
  });
  app.on('window-all-closed', () => {}); // the app stays resident
}
