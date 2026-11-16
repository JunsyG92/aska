'use strict';
const { app, BrowserWindow, globalShortcut, ipcMain, dialog, screen, clipboard, Notification, session } = require('electron');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { paths, loadConfig } = require('./config');
const { MODES, MODE_ORDER, resolveAgents, buildInvocation } = require('./agents');
const sec = require('./security');
const { runAgent } = require('./runner');

const P = paths();
const INDEX = path.join(__dirname, '..', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX).href;
const WIN_W = 800;
const WIN_H = 620;

// Portail GlobalShortcuts : raccourci global sous Wayland quand le bureau le propose.
app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');

let win = null;
let cfg = null;
let agents = {};
let warnings = [];
let trust = null;
let cwd = null;
let current = null; // exécution en cours : { id, handle }
let runSeq = 0;
let dialogOpen = false;
let shortcutOk = false;
let quitting = false;

// Une session graphique n'a pas toujours le PATH du terminal : on ajoute les
// emplacements habituels des CLI installés par l'utilisateur.
function searchPath() {
  const home = os.homedir();
  const extra = ['.local/bin', 'bin', '.npm-global/bin', '.bun/bin', '.volta/bin'].map((d) => path.join(home, d));
  const parts = (process.env.PATH || '').split(':').filter((d) => d && path.isAbsolute(d));
  for (const d of [...extra, '/usr/local/bin']) if (!parts.includes(d)) parts.push(d);
  return parts.join(':');
}

function loadEverything() {
  const c = loadConfig(P.config);
  cfg = c.config;
  const a = resolveAgents(cfg.agents);
  agents = a.agents;
  warnings = [...c.warnings, ...a.warnings];
  for (const agent of Object.values(agents)) {
    const r = sec.resolveBinary(agent.bin, { override: agent.binOverride, envPath: searchPath() });
    agent.binPath = r.path || null;
    agent.binError = r.error || null;
  }
  trust = new sec.TrustStore(P.trust);
  sec.ensurePrivateDir(P.workspace);
  if (!cwd) {
    const st = sec.readOwnedJson(P.state);
    const saved = st.data && typeof st.data.cwd === 'string' ? st.data.cwd : null;
    cwd = saved && !sec.checkWorkdir(saved, 'read').error ? saved : P.workspace;
  }
}

function fsRealWorkspace() {
  try {
    return require('fs').realpathSync(P.workspace);
  } catch {
    return P.workspace;
  }
}

const tilde = (p) => {
  const home = os.homedir();
  if (p === P.workspace || p === fsRealWorkspace()) return 'Espace temporaire';
  return p === home ? '~' : p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
};

function publicState() {
  const list = Object.values(agents).map((a) => ({
    id: a.id,
    label: a.label,
    color: a.color,
    available: !!a.binPath,
    error: a.binError,
    install: a.install || null,
    modes: MODE_ORDER.filter((m) => a.modes[m] && (m !== 'auto' || cfg.allowAutoMode)),
  }));
  return {
    agents: list,
    modes: MODES,
    defaultAgent: cfg.defaultAgent,
    defaultMode: cfg.defaultMode,
    allowAutoMode: cfg.allowAutoMode,
    cwd: tilde(cwd),
    cwdIsScratch: cwd === P.workspace,
    shortcut: shortcutOk ? cfg.shortcut : null,
    warnings,
    history: cfg.savePrompts ? sec.readRecentPrompts(P.audit) : [],
    running: !!current,
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
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
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
  win.setAlwaysOnTop(true, 'pop-up-menu');

  // L'interface ne charge que son fichier local : ni navigation, ni fenêtre, ni webview.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-redirect', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('blur', () => {
    if (cfg.hideOnBlur && !dialogOpen && !win.webContents.isDevToolsOpened()) hideWindow();
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
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  win.setBounds({
    x: Math.round(x + (width - WIN_W) / 2),
    y: Math.round(y + Math.max(40, height * 0.16)),
    width: WIN_W,
    height: WIN_H,
  });
  win.show();
  win.focus();
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

function toggleWindow() {
  if (win && win.isVisible() && win.isFocused()) hideWindow();
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
    warnings.push(`Raccourci ${cfg.shortcut} indisponible : associez la commande « aska --toggle » dans les raccourcis de votre bureau`);
  }
}

// ---------- IPC (chaque appel vérifie son émetteur et ses arguments) ----------

function fromOurUi(event) {
  return !!win && event.sender === win.webContents && event.senderFrame && event.senderFrame.url === INDEX_URL;
}

function handle(channel, fn) {
  ipcMain.handle(channel, (event, arg) => {
    if (!fromOurUi(event)) throw new Error('émetteur refusé');
    return fn(arg);
  });
}

function send(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('aska:run-event', payload);
}

function startRun(req) {
  if (current) return { error: 'Une demande est déjà en cours' };
  if (!req || typeof req !== 'object') return { error: 'Requête invalide' };
  const { agentId, mode, prompt, trust: trustChoice } = req;
  const agent = typeof agentId === 'string' && Object.hasOwn(agents, agentId) ? agents[agentId] : null;
  if (!agent) return { error: 'Agent inconnu' };
  if (!agent.binPath) return { error: `${agent.label} : ${agent.binError}` };
  if (!MODE_ORDER.includes(mode)) return { error: 'Mode inconnu' };
  if (mode === 'auto' && !cfg.allowAutoMode) {
    return { error: 'Le mode autonome est désactivé ("allowAutoMode": true dans la configuration pour l\'activer)' };
  }
  if (typeof prompt !== 'string' || prompt.length > 100000) return { error: 'Prompt invalide' };

  const dir = sec.checkWorkdir(cwd, mode, os.homedir(), [fsRealWorkspace()]);
  if (dir.error) return { error: dir.error };

  // Écrire dans un dossier demande l'accord explicite de l'utilisateur.
  if (mode !== 'read' && !trust.isTrusted(dir.path)) {
    if (trustChoice === 'always') trust.add(dir.path);
    else if (trustChoice !== 'once') return { needsTrust: true, cwd: tilde(dir.path), agent: agent.label, mode };
  }

  let inv;
  try {
    inv = buildInvocation(agent, mode, prompt);
  } catch (e) {
    return { error: e.message };
  }

  const id = ++runSeq;
  const startedAt = new Date().toISOString();
  const handleRun = runAgent(
    {
      bin: agent.binPath,
      argv: inv.argv,
      cwd: dir.path,
      env: { ...sec.buildEnv(process.env, agent.env, cfg.envPassthrough), PATH: searchPath() },
      stdin: inv.stdin,
      output: agent.output,
      timeoutMs: cfg.timeoutSec * 1000,
      maxBytes: cfg.maxOutputKb * 1024,
    },
    (ev) => send({ id, ...ev })
  );
  current = { id, handle: handleRun };

  handleRun.done.then((res) => {
    current = null;
    sec.appendAudit(P.audit, {
      ts: startedAt,
      agent: agent.id,
      mode,
      cwd: dir.path,
      bin: agent.binPath,
      argv: inv.logArgv,
      prompt: cfg.savePrompts ? prompt : undefined,
      result: res.reason,
      code: res.code ?? null,
      durationMs: res.durationMs,
    });
    send({
      id,
      type: 'end',
      ok: res.ok,
      reason: res.reason,
      code: res.code ?? null,
      error: res.error || null,
      stderr: res.ok ? '' : (res.stderrTail || '').slice(-1500),
      durationMs: res.durationMs,
      timeoutSec: cfg.timeoutSec,
    });
    if (win && !win.isVisible() && res.reason !== 'cancel' && Notification.isSupported()) {
      const n = new Notification({
        title: res.ok ? `${agent.label} a terminé` : `${agent.label} : échec`,
        body: prompt.slice(0, 120),
        silent: true,
      });
      n.on('click', showWindow);
      n.show();
    }
  });
  return { ok: true, id };
}

function registerIpc() {
  handle('aska:state', () => publicState());
  handle('aska:run', startRun);
  handle('aska:cancel', () => {
    if (current) current.handle.cancel();
    return true;
  });
  handle('aska:hide', () => hideWindow());
  handle('aska:copy', (text) => {
    if (typeof text === 'string' && text.length < 5_000_000) clipboard.writeText(text);
    return true;
  });
  handle('aska:reset-dir', () => {
    cwd = P.workspace;
    sec.writePrivate(P.state, JSON.stringify({ cwd }));
    return publicState();
  });
  handle('aska:pick-dir', async () => {
    dialogOpen = true;
    try {
      const r = await dialog.showOpenDialog(win, {
        title: 'Dossier de travail de l’agent',
        defaultPath: cwd === P.workspace ? os.homedir() : cwd,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (!r.canceled && r.filePaths[0]) {
        const d = sec.checkWorkdir(r.filePaths[0], 'read');
        if (!d.error) {
          cwd = d.path;
          sec.writePrivate(P.state, JSON.stringify({ cwd }));
        }
      }
    } finally {
      dialogOpen = false;
      if (win) win.focus();
    }
    return publicState();
  });
}

// ---------- cycle de vie ----------

const argv = process.argv.slice(1);
const wants = (flag) => argv.includes(flag);

if (!app.requestSingleInstanceLock()) {
  // Une instance tourne déjà : elle reçoit nos arguments (« second-instance ») et bascule.
  app.quit();
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

  app.whenReady().then(() => {
    if (wants('--quit')) return app.quit();
    // Aucune permission web (caméra, géoloc, notifications web…) n'est accordée.
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
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {}); // l'app reste résidente
}
