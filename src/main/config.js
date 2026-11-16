'use strict';
const os = require('os');
const path = require('path');
const { readOwnedJson } = require('./security');
const { MODE_ORDER } = require('./agents');

function paths(env = process.env, home = os.homedir()) {
  const abs = (v, fallback) => (v && path.isAbsolute(v) ? v : fallback);
  const configDir = path.join(abs(env.XDG_CONFIG_HOME, path.join(home, '.config')), 'aska');
  const stateDir = path.join(abs(env.XDG_STATE_HOME, path.join(home, '.local', 'state')), 'aska');
  const dataDir = path.join(abs(env.XDG_DATA_HOME, path.join(home, '.local', 'share')), 'aska');
  return {
    configDir,
    stateDir,
    dataDir,
    config: path.join(configDir, 'config.json'),
    trust: path.join(configDir, 'trusted.json'),
    state: path.join(stateDir, 'state.json'),
    audit: path.join(stateDir, 'history.jsonl'),
    workspace: path.join(dataDir, 'workspace'),
  };
}

const DEFAULTS = {
  shortcut: 'Control+Alt+Space',
  defaultAgent: 'claude',
  defaultMode: 'read',
  allowAutoMode: false,
  timeoutSec: 600,
  maxOutputKb: 2048,
  savePrompts: true,
  hideOnBlur: true,
  envPassthrough: [],
  agents: {},
};

/**
 * Charge la configuration. Comme elle décide des programmes lancés, un fichier
 * modifiable par un autre utilisateur est ignoré (valeurs par défaut + alerte).
 */
function loadConfig(file) {
  const warnings = [];
  const cfg = { ...DEFAULTS };
  const r = readOwnedJson(file);
  if (r.error) {
    warnings.push(`Configuration ignorée : ${r.error}`);
    return { config: cfg, warnings };
  }
  if (r.missing || !r.data || typeof r.data !== 'object') return { config: cfg, warnings };
  const u = r.data;

  if (typeof u.shortcut === 'string' && /^[\w+ ]{1,40}$/.test(u.shortcut)) cfg.shortcut = u.shortcut;
  else if (u.shortcut === false) cfg.shortcut = null;
  if (typeof u.defaultAgent === 'string') cfg.defaultAgent = u.defaultAgent;
  if (MODE_ORDER.includes(u.defaultMode)) {
    // On ne démarre jamais directement en mode autonome.
    cfg.defaultMode = u.defaultMode === 'auto' ? 'edit' : u.defaultMode;
    if (u.defaultMode === 'auto') warnings.push('defaultMode "auto" refusé : remplacé par "edit"');
  }
  if (u.allowAutoMode === true) cfg.allowAutoMode = true;
  if (Number.isFinite(u.timeoutSec)) cfg.timeoutSec = Math.min(Math.max(u.timeoutSec, 5), 3600);
  if (Number.isFinite(u.maxOutputKb)) cfg.maxOutputKb = Math.min(Math.max(u.maxOutputKb, 16), 16384);
  if (typeof u.savePrompts === 'boolean') cfg.savePrompts = u.savePrompts;
  if (typeof u.hideOnBlur === 'boolean') cfg.hideOnBlur = u.hideOnBlur;
  if (Array.isArray(u.envPassthrough)) {
    cfg.envPassthrough = u.envPassthrough.filter((s) => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*\*?$/.test(s));
  }
  if (u.agents && typeof u.agents === 'object' && !Array.isArray(u.agents)) cfg.agents = u.agents;
  return { config: cfg, warnings };
}

module.exports = { paths, loadConfig, DEFAULTS };
