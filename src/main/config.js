'use strict';
const os = require('os');
const path = require('path');
const { readOwnedJson } = require('./security');
const { MODE_ORDER, BUILTIN } = require('./agents');
const { COMMANDS } = require('../renderer/commands');
const { t, setLanguage, resolveLanguage, LANGUAGES, setKeyLabels } = require('../i18n');
const { resolveKeybindings, keyLabels } = require('./keys');

function paths(env = process.env, home = os.homedir(), platform = process.platform) {
  const abs = (v, fallback) => (v && path.isAbsolute(v) ? v : fallback);
  let configDir, stateDir, dataDir;
  if (platform === 'win32') {
    // Windows: config in %APPDATA% (roaming), state and data in %LOCALAPPDATA%.
    configDir = path.join(abs(env.APPDATA, path.join(home, 'AppData', 'Roaming')), 'aska');
    const local = path.join(abs(env.LOCALAPPDATA, path.join(home, 'AppData', 'Local')), 'aska');
    stateDir = path.join(local, 'state');
    dataDir = local;
  } else {
    configDir = path.join(abs(env.XDG_CONFIG_HOME, path.join(home, '.config')), 'aska');
    stateDir = path.join(abs(env.XDG_STATE_HOME, path.join(home, '.local', 'state')), 'aska');
    dataDir = path.join(abs(env.XDG_DATA_HOME, path.join(home, '.local', 'share')), 'aska');
  }
  return {
    configDir,
    stateDir,
    dataDir,
    config: path.join(configDir, 'config.json'),
    trust: path.join(configDir, 'trusted.json'),
    state: path.join(stateDir, 'state.json'),
    run: path.join(stateDir, 'run.json'),
    audit: path.join(stateDir, 'history.jsonl'),
    conversations: path.join(stateDir, 'conversations'),
    workspace: path.join(dataDir, 'workspace'),
  };
}

const DEFAULTS = {
  shortcut: 'Control+Alt+Space',
  selectionShortcut: 'Control+Alt+Shift+Space', // asks about the text selected elsewhere
  defaultAgent: 'claude',
  defaultMode: 'read',
  allowAutoMode: false,
  timeoutSec: 600,
  maxOutputKb: 2048,
  savePrompts: true,
  hideOnBlur: true, // clicking outside hides the chat (unless it is pinned)
  alwaysOnTop: true,
  tray: true,
  notify: 'hidden', // hidden | unfocused | never
  notifyPreview: true, // start of the answer in the notification
  notifySound: true,
  envPassthrough: [],
  language: 'auto', // auto (system language) | en | fr
  keybindings: {}, // shortcuts inside the window, by action (see keys.js)
  commands: {}, // "/" commands of the user: name -> { prompt, description, agent, mode, model }
  agents: {},
};

const COMMAND_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL_RE = /^[A-Za-z0-9][\w.:/[\]-]{0,79}$/;
const MAX_COMMAND_PROMPT = 20000;
const MAX_COMMANDS = 100;

/**
 * "/" commands of the user: a prompt sent by name ("/trad hello"), with "{input}"
 * replaced by what follows the name. Either a string (the prompt) or
 * { prompt, description?, agent?, mode?, model? }. A name taken by Aska's own
 * commands or by an agent is refused: they keep their meaning.
 * Returns { commands, warnings }.
 */
function resolveCommands(raw, agentIds = []) {
  const commands = {};
  const warnings = [];
  if (raw === undefined) return { commands, warnings };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(t('config.commands.invalidSection'));
    return { commands, warnings };
  }
  const reserved = new Set([...COMMANDS.flatMap((c) => [c.name, ...(c.aliases || [])]), ...agentIds]);
  for (const [name, value] of Object.entries(raw).slice(0, MAX_COMMANDS)) {
    if (!COMMAND_NAME_RE.test(name)) {
      warnings.push(t('config.commands.invalidName', { name }));
      continue;
    }
    if (reserved.has(name)) {
      warnings.push(t('config.commands.reserved', { name }));
      continue;
    }
    const v = typeof value === 'string' ? { prompt: value } : value;
    if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.prompt !== 'string' || !v.prompt.trim()) {
      warnings.push(t('config.commands.noPrompt', { name }));
      continue;
    }
    if (v.prompt.length > MAX_COMMAND_PROMPT || v.prompt.includes('\0')) {
      warnings.push(t('config.commands.badPrompt', { name, max: MAX_COMMAND_PROMPT }));
      continue;
    }
    const c = { name, prompt: v.prompt };
    if (typeof v.description === 'string' && v.description.trim()) c.description = v.description.trim().slice(0, 120);
    const bad = (field) => warnings.push(t('config.commands.badField', { name, field }));
    if (v.agent !== undefined) {
      if (typeof v.agent === 'string' && agentIds.includes(v.agent)) c.agent = v.agent;
      else bad('agent');
    }
    if (v.mode !== undefined) {
      if (MODE_ORDER.includes(v.mode)) c.mode = v.mode;
      else bad('mode');
    }
    if (v.model !== undefined) {
      if (v.model === null || (typeof v.model === 'string' && MODEL_RE.test(v.model))) c.model = v.model;
      else bad('model');
    }
    commands[name] = c;
  }
  return { commands, warnings };
}

/**
 * Loads the config. Since it decides which programs are run, a file writable
 * by another user is ignored (defaults + warning).
 * With systemLangs, also sets the UI language ("language" option, else the
 * system language) before any warning is written, so warnings use it.
 */
function loadConfig(file, { systemLangs = null } = {}) {
  const warnings = [];
  const cfg = { ...DEFAULTS };
  const useLanguage = (pref) => {
    if (systemLangs) setLanguage(resolveLanguage(pref, systemLangs));
  };
  useLanguage('auto');
  // Shortcuts are resolved last, in the final language: their labels fill {key:…} in the strings.
  const done = (user) => {
    const k = resolveKeybindings(user);
    cfg.keybindings = k.bindings;
    warnings.push(...k.warnings);
    setKeyLabels(keyLabels(k.bindings));
    return { config: cfg, warnings };
  };
  const r = readOwnedJson(file);
  if (r.error) {
    warnings.push(t('config.ignored', { error: r.error }));
    return done(undefined);
  }
  if (r.missing || !r.data || typeof r.data !== 'object') return done(undefined);
  const u = r.data;

  if (u.language === 'auto' || LANGUAGES.includes(u.language)) cfg.language = u.language;
  useLanguage(cfg.language);

  if (typeof u.shortcut === 'string' && /^[\w+ ]{1,40}$/.test(u.shortcut)) cfg.shortcut = u.shortcut;
  else if (u.shortcut === false) cfg.shortcut = null;
  if (typeof u.selectionShortcut === 'string' && /^[\w+ ]{1,40}$/.test(u.selectionShortcut)) cfg.selectionShortcut = u.selectionShortcut;
  else if (u.selectionShortcut === false) cfg.selectionShortcut = null;
  if (typeof u.defaultAgent === 'string') cfg.defaultAgent = u.defaultAgent;
  if (MODE_ORDER.includes(u.defaultMode)) {
    // Never start directly in autonomous mode.
    cfg.defaultMode = u.defaultMode === 'auto' ? 'edit' : u.defaultMode;
    if (u.defaultMode === 'auto') warnings.push(t('config.autoRejected'));
  }
  if (u.allowAutoMode === true) cfg.allowAutoMode = true;
  if (Number.isFinite(u.timeoutSec)) cfg.timeoutSec = Math.min(Math.max(u.timeoutSec, 5), 3600);
  if (Number.isFinite(u.maxOutputKb)) cfg.maxOutputKb = Math.min(Math.max(u.maxOutputKb, 16), 16384);
  if (typeof u.savePrompts === 'boolean') cfg.savePrompts = u.savePrompts;
  if (typeof u.hideOnBlur === 'boolean') cfg.hideOnBlur = u.hideOnBlur;
  if (typeof u.alwaysOnTop === 'boolean') cfg.alwaysOnTop = u.alwaysOnTop;
  if (typeof u.tray === 'boolean') cfg.tray = u.tray;
  if (['hidden', 'unfocused', 'never'].includes(u.notify)) cfg.notify = u.notify;
  else if (u.notify === false) cfg.notify = 'never';
  if (typeof u.notifyPreview === 'boolean') cfg.notifyPreview = u.notifyPreview;
  if (typeof u.notifySound === 'boolean') cfg.notifySound = u.notifySound;
  if (Array.isArray(u.envPassthrough)) {
    cfg.envPassthrough = u.envPassthrough.filter((s) => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*\*?$/.test(s));
  }
  if (u.agents && typeof u.agents === 'object' && !Array.isArray(u.agents)) cfg.agents = u.agents;
  const cmds = resolveCommands(u.commands, [...new Set([...Object.keys(BUILTIN), ...Object.keys(cfg.agents)])]);
  cfg.commands = cmds.commands;
  warnings.push(...cmds.warnings);
  return done(u.keybindings);
}

module.exports = { paths, loadConfig, resolveCommands, DEFAULTS };
