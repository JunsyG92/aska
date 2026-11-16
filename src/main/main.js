'use strict';
const { app, BrowserWindow, globalShortcut, ipcMain, dialog, screen, clipboard, Notification, session } = require('electron');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { paths, loadConfig } = require('./config');
const { MODES, MODE_ORDER, resolveAgents, buildInvocation, isModel } = require('./agents');
const { ConversationStore, buildContextPrompt, MAX_ANSWER } = require('./conversations');
const sec = require('./security');
const { runAgent } = require('./runner');

const P = paths();
const INDEX = path.join(__dirname, '..', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX).href;
const WIN_W = 748; // taille initiale ; la fenêtre épouse ensuite le panneau
const WIN_H = 110;

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
let mini = false; // panneau réduit en pastille
let savedPos = null; // ancrage choisi par l'utilisateur : bord gauche et bord BAS de la fenêtre
let saveTimer = null;
let store = null; // conversations enregistrées
let conv = null; // conversation affichée
let picked = {}; // modèle choisi par agent : { claude: 'opus' } (absent = défaut)
let extraModels = {}; // modèles saisis à la main, par agent

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
    const r = sec.resolveBinary(agent.bin, { override: agent.binOverride, envPath: searchPath(), avoid: agent.avoidPath });
    agent.binPath = r.path || null;
    agent.binError = r.error || null;
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
    const pos = st.data && st.data.pos;
    if (pos && Number.isInteger(pos.x) && Number.isInteger(pos.bottom)) savedPos = { x: pos.x, bottom: pos.bottom };
    cwd = saved && !sec.checkWorkdir(saved, 'read').error ? saved : P.workspace;
  }
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
    sec.writePrivate(P.state, JSON.stringify({ cwd, pos: savedPos, models: picked, extraModels }));
  } catch { /* l'état est un confort, pas une nécessité */ }
}

const tilde = (p) => {
  const home = os.homedir();
  if (p === P.workspace || p === fsRealWorkspace()) return 'Espace temporaire';
  return p === home ? '~' : p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
};

// Modèle utilisé pour un agent : choix dans l'interface, sinon config, sinon défaut du CLI.
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
    conversation: { id: conv.id, title: conv.title, turns: conv.turns.map(publicTurn) },
    historyEnabled: cfg.savePrompts,
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
  // La position choisie en déplaçant la fenêtre est conservée.
  win.on('moved', () => {
    const b = win.getBounds();
    savedPos = { x: b.x, bottom: b.y + b.height };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 400);
  });

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
  if (!win.isVisible()) {
    const [w, h] = win.getSize();
    let pos = null;
    if (savedPos) {
      // On ne réutilise la position mémorisée que si elle est encore sur un écran.
      const top = savedPos.bottom - h;
      const wa = screen.getDisplayMatching({ x: savedPos.x, y: top, width: w, height: h }).workArea;
      const inside = savedPos.x + 80 > wa.x && savedPos.x < wa.x + wa.width - 80 && top >= wa.y && savedPos.bottom <= wa.y + wa.height + 40;
      if (inside) pos = { x: savedPos.x, y: top };
    }
    if (!pos) {
      // Par défaut : centré, la saisie vers les deux tiers de l'écran ; le fil grandit vers le haut.
      const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      pos = { x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + wa.height * 0.68) - h };
    }
    win.setPosition(pos.x, pos.y);
  }
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
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000) return { error: 'Prompt invalide' };

  const dir = sec.checkWorkdir(cwd, mode, os.homedir(), [fsRealWorkspace()]);
  if (dir.error) return { error: dir.error };

  // Écrire dans un dossier demande l'accord explicite de l'utilisateur.
  // Certains CLI (Cursor) exigent en plus qu'on se porte garant du contenu du
  // dossier, même en lecture : même accord, sauf dans le dossier vide d'Aska.
  const contentTrust = !!agent.trustFlag && dir.path !== fsRealWorkspace();
  if ((mode !== 'read' || contentTrust) && !trust.isTrusted(dir.path)) {
    if (trustChoice === 'always') trust.add(dir.path);
    else if (trustChoice !== 'once') {
      return { needsTrust: true, cwd: tilde(dir.path), agent: agent.label, mode, reason: mode !== 'read' ? 'write' : 'content' };
    }
  }

  // Suite de conversation : reprise native si le CLI a déjà tout le fil en
  // session (même agent, même dossier), sinon le contexte est réinjecté.
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
            timeout: `Arrêté : délai de ${cfg.timeoutSec} s dépassé`,
            overflow: 'Arrêté : sortie trop volumineuse',
            'spawn-error': `Lancement impossible : ${res.error}`,
          }[res.reason] || streamError || `Le CLI s'est terminé avec le code ${res.code}`,
          (res.stderrTail || '').slice(-1500),
        ].filter(Boolean).join('\n\n'),
      };
    } else if (ok && denied) {
      turn.notice = {
        kind: 'warn',
        text: `${denied.count} action(s) refusée(s) par le mode « ${MODES[mode].label} » (${denied.tools.join(', ')}). Maj+Tab pour changer de mode, puis relancez.`,
      };
    }
    // La session du CLI ne « couvre » le fil que si ce tour a réussi.
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
    if (win && !win.isVisible() && res.reason !== 'cancel' && Notification.isSupported()) {
      const n = new Notification({
        title: ok ? `${agent.label} a terminé` : `${agent.label} : échec`,
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
  handle('aska:conv-new', () => {
    if (!current) conv = store.create(cwd);
    return publicState();
  });
  handle('aska:conv-list', () => store.list());
  handle('aska:conv-open', (cid) => {
    if (current) return publicState();
    const c = store.load(cid);
    if (c) {
      conv = c;
      // On retrouve le dossier de la conversation : la reprise de session en dépend.
      if (typeof c.cwd === 'string' && !sec.checkWorkdir(c.cwd, 'read').error) {
        cwd = c.cwd;
        saveState();
      }
    }
    return publicState();
  });
  handle('aska:conv-delete', (cid) => {
    if (current && conv.id === cid) return store.list();
    store.delete(cid);
    if (conv.id === cid) conv = store.create(cwd);
    return store.list();
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
  });
  // La fenêtre épouse le panneau : aucune zone transparente ne bloque les clics autour.
  handle('aska:resize', (size) => {
    if (!size || !Number.isFinite(size.w) || !Number.isFinite(size.h)) return;
    const w = Math.round(Math.min(Math.max(size.w, 120), 900));
    const h = Math.round(Math.min(Math.max(size.h, 40), 800));
    const b = win.getBounds();
    if (b.width === w && b.height === h) return;
    // Le bord bas reste en place : la zone de saisie ne bouge pas quand le fil s'allonge.
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
        title: 'Dossier de travail de l’agent',
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
