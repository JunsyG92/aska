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
const { Tabs } = require('./tabs');
const sec = require('./security');
const { runAgent } = require('./runner');
const { resolveLaunch, buildCommand, extendedPath } = require('./launch');
const { buildId, runningInstance } = require('./build');
const { wantsCliOutput, printCli } = require('../cli');

const P = paths();
const BUILD = buildId();
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
let cwd = null; // dossier de l'onglet actif (et des nouveaux onglets)
const MAX_RUNS = 4; // demandes simultanées au plus, tous onglets confondus
let runSeq = 0;
let dialogOpen = false;
let shortcutOk = false;
let quitting = false;
let mini = false; // panneau réduit en pastille
let pinned = null; // épinglé : reste affiché quand on clique ailleurs (null = selon la config)
let unread = 0; // réponses arrivées pendant que le chat était hors de vue
let notifier = null;
let savedPos = null; // ancrage choisi par l'utilisateur : bord gauche et bord BAS de la fenêtre
let saveTimer = null;
let store = null; // conversations enregistrées
let tabs = null; // onglets ouverts (voir tabs.js) ; chacun porte sa conversation et sa demande en cours
let savedTabs = null; // onglets enregistrés, rouverts au démarrage
const picked = {}; // modèle choisi par agent : { claude: 'opus' } (absent = défaut)
const extraModels = {}; // modèles saisis à la main, par agent
const discovered = {}; // modèles annoncés par chaque CLI : { cursor: { models, error } }

// PATH élargi aux emplacements habituels des CLI (voir launch.js).
const searchPath = () => extendedPath();

// Environnement transmis à un agent : filtré, avec le PATH élargi ci-dessus.
function agentEnv(agent) {
  return sec.setEnvVar(sec.buildEnv(process.env, agent.env, cfg.envPassthrough), 'PATH', searchPath());
}

// Lance une commande d'agent (Windows : sans cmd.exe pour les lanceurs npm).
function launchAgent(agent, argv, opts, onEvent) {
  let cmd;
  try {
    cmd = buildCommand(agent.launch, argv);
  } catch (e) {
    return { cancel() {}, done: Promise.resolve({ ok: false, reason: 'spawn-error', error: e.message, durationMs: 0, stderrTail: '' }) };
  }
  return runAgent({ ...opts, bin: cmd.command, argv: cmd.args, verbatim: cmd.verbatim, env: agentEnv(agent) }, onEvent);
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

// Le dossier de travail suit l'onglet actif (un dossier disparu ramène à l'espace temporaire).
function syncCwd() {
  const c = tabs.active().conv.cwd;
  cwd = typeof c === 'string' && !sec.checkWorkdir(c, 'read').error ? c : P.workspace;
}

// Barre d'onglets côté interface.
function publicTabs() {
  return tabs.list.map((t) => {
    const last = t.conv.turns[t.conv.turns.length - 1];
    return {
      id: t.id,
      title: t.conv.title || (last ? last.prompt.slice(0, 60) : ''),
      color: last && agents[last.agent] ? agents[last.agent].color : null,
      running: !!t.run,
      unread: t.unread,
      active: t.id === tabs.activeId,
    };
  });
}

function pushTabs() {
  if (win && !win.isDestroyed()) win.webContents.send('aska:tabs', publicTabs());
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
    sec.writePrivate(P.state, JSON.stringify({ cwd, pos: savedPos, models: picked, extraModels, pinned, ...open }));
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

// Liste des conversations pour l'interface : couleurs d'agents et dossier lisible.
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
    running: !!tabs.active().run,
    // Demande en cours de l'onglet actif : l'interface s'y raccroche pour suivre la réponse.
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
  // macOS : visible aussi par-dessus une application en plein écran.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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

  // Clic à l'extérieur : le chat se masque, sauf s'il est épinglé ou réduit en
  // pastille (dont le rôle est justement de rester visible pendant le travail).
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

// Rouvre une conversation enregistrée dans un onglet (et son dossier de travail,
// dont dépend la reprise de session).
function openConversationById(cid) {
  if (typeof cid !== 'string' || !cid) return { error: 'Conversation introuvable' };
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
  if (!req || typeof req !== 'object') return { error: 'Requête invalide' };
  const tab = typeof req.tabId === 'string' ? tabs.get(req.tabId) : null;
  if (!tab) return { error: 'Onglet introuvable' };
  if (tab.run) return { error: 'Une demande est déjà en cours dans cet onglet' };
  if (tabs.running().length >= MAX_RUNS) return { error: `${MAX_RUNS} demandes en cours au plus : attendez qu'une se termine` };
  const conv = tab.conv;
  const { agentId, mode, prompt, trust: trustChoice } = req;
  const agent = typeof agentId === 'string' && Object.hasOwn(agents, agentId) ? agents[agentId] : null;
  if (!agent) return { error: 'Agent inconnu' };
  if (!agent.binPath) return { error: `${agent.label} : ${agent.binError}` };
  if (!MODE_ORDER.includes(mode)) return { error: 'Mode inconnu' };
  if (mode === 'auto' && !cfg.allowAutoMode) {
    return { error: 'Le mode autonome est désactivé ("allowAutoMode": true dans la configuration pour l\'activer)' };
  }
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000) return { error: 'Prompt invalide' };

  const tabCwd = typeof conv.cwd === 'string' && !sec.checkWorkdir(conv.cwd, 'read').error ? conv.cwd : P.workspace;
  const dir = sec.checkWorkdir(tabCwd, mode, os.homedir(), [fsRealWorkspace()]);
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
      if (ev.type !== 'session') send({ id, tabId: tab.id, ...ev });
    }
  );
  tab.run = { id, handle: handleRun };
  pushTabs();

  handleRun.done.then((res) => {
    tab.run = null;
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
    // Réponse arrivée hors de vue (autre onglet, ou fenêtre masquée) : l'onglet la signale.
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
    // Une fenêtre en train de se masquer (animation de sortie) compte comme masquée.
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

// Liste des modèles d'un agent : ceux annoncés par son CLI (interrogé une fois,
// puis à la demande), complétés par la liste intégrée, la config et les saisies.
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
  // Lien cliqué dans une réponse : ouvert dans le navigateur, jamais dans Aska,
  // et seulement en http(s) (pas de file:, javascript:, etc.).
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
  // ----- onglets -----
  const tabChanged = (extra = {}) => {
    syncCwd();
    saveState();
    return { ...publicState(), ...extra };
  };
  // Nouvel onglet, dans le dossier de l'onglet actif.
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
  // Fermer un onglet qui travaille demande une confirmation : sa demande sera annulée.
  handle('aska:tab-close', (req) => {
    // Sans identifiant : l'onglet actif. Un identifiant mal formé est refusé, jamais remplacé.
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
    // Une conversation ouverte dans un onglet qui travaille n'est pas supprimée.
    if (tabs.forget(cid, cwd).error) return publicList();
    store.delete(cid);
    syncCwd();
    saveState();
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
    if (tabs.active().run) return publicState();
    cwd = P.workspace;
    tabs.active().conv.cwd = cwd;
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
        if (!d.error && !tabs.active().run) {
          cwd = d.path;
          tabs.active().conv.cwd = cwd; // le dossier appartient à l'onglet
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

// « aska --help » / « --version » : réponse dans le terminal, sans ouvrir de fenêtre.
if (wantsCliOutput(argv)) {
  printCli(argv);
  app.exit(0);
}
const wants = (flag) => argv.includes(flag);

const APP_FLAGS = ['--toggle', '--hidden', '--reload', '--restart', '--replaced', '--quit', '--no-autostart'];

// Remplace l'instance en cours : une instance auxiliaire lui transmet « --quit »
// (compris même par les anciennes versions), puis on se relance à sa place.
// « --replaced » évite toute boucle si l'ancienne instance refuse de se fermer.
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

// Windows : les notifications ne s'affichent que si un raccourci du menu Démarrer
// porte l'identité de l'application (AppUserModelID). Seule l'API de raccourcis
// d'Electron sait l'écrire : scripts/install.ps1 appelle donc « --install-shortcuts ».
const APP_ID = 'aska';
if (process.platform === 'win32' && wants('--install-shortcuts')) {
  // Ne jamais rester bloqué : quoi qu'il arrive, le processus se termine.
  const done = (code, out) => {
    (code ? process.stderr : process.stdout).write(out + '\n');
    app.exit(code);
  };
  setTimeout(() => done(2, 'Délai dépassé pendant la création des raccourcis.'), 30000).unref();
  app.whenReady().then(() => {
    const fs = require('fs');
    const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const root = path.join(__dirname, '..', '..');
    const link = (file, args) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // « create » crée le raccourci ou l'écrase (« replace » échoue s'il n'existe pas).
      const ok = shell.writeShortcutLink(file, 'create', {
        target: process.execPath,
        args: `"${root}" ${args}`,
        cwd: root,
        description: 'Demander une action à un agent IA (Claude, Codex, Copilot, Cursor)',
        icon: process.execPath,
        iconIndex: 0,
        appUserModelId: APP_ID,
      });
      if (!ok) throw new Error(`impossible d'écrire ${file}`);
      const back = shell.readShortcutLink(file);
      if (back.appUserModelId !== APP_ID) throw new Error(`identité absente du raccourci ${file}`);
      return { file, appUserModelId: back.appUserModelId, target: back.target };
    };
    const startup = path.join(programs, 'Startup', 'Aska.lnk');
    const made = [link(path.join(programs, 'Aska.lnk'), '--toggle')];
    if (wants('--no-autostart')) fs.rmSync(startup, { force: true });
    else made.push(link(startup, '--hidden'));
    done(0, JSON.stringify(made));
  }).catch((e) => done(1, `Création des raccourcis impossible : ${e.message}`));
} else if (!app.requestSingleInstanceLock()) {
  // Une instance tourne déjà : elle reçoit nos arguments (« second-instance ») et bascule.
  // Mais si elle exécute un autre code que le nôtre (Aska mis à jour sans avoir été
  // relancé), ses fonctions sont périmées : on la remplace plutôt que de la rouvrir.
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

  // Windows : identité de l'application, nécessaire aux notifications.
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  app.whenReady().then(() => {
    if (wants('--quit')) return app.quit();
    // macOS : Aska est un outil d'arrière-plan, sans icône dans le Dock ni menu.
    if (process.platform === 'darwin') app.setActivationPolicy('accessory');
    // Instance active : ce fichier permet de la reconnaître (aska --help, remplacement).
    try {
      sec.writePrivate(P.run, JSON.stringify({ pid: process.pid, build: BUILD, version: app.getVersion(), startedAt: new Date().toISOString() }));
    } catch { /* confort seulement */ }
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
    for (const t of tabs ? tabs.running() : []) t.run.handle.cancel();
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    // On ne retire le fichier que s'il est encore le nôtre (une nouvelle instance a pu le réécrire).
    try {
      const r = sec.readOwnedJson(P.run);
      if (r.data && r.data.pid === process.pid) require('fs').rmSync(P.run, { force: true });
    } catch { /* déjà supprimé */ }
  });
  app.on('window-all-closed', () => {}); // l'app reste résidente
}
