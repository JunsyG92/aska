'use strict';
// Settings panel: what the window may change in config.json. Independent of
// Electron, so it can be tested.
//
// Only the keys of MANAGED can be written from the window. The others
// (agents and their binaries, extraArgs, envPassthrough, allowAutoMode,
// maxOutputKb…) decide which programs run and with which rights: they stay
// in the file, edited by hand.

const { DEFAULTS } = require('./config');
const { ACTIONS, DEFAULT_KEYBINDINGS, parseCombo, comboId, comboText, resolveKeybindings } = require('./keys');
const { LANGUAGES, t } = require('../i18n');

const MANAGED = [
  'language', 'defaultAgent', 'defaultMode', 'timeoutSec',
  'alwaysOnTop', 'tray', 'shortcut', 'selectionShortcut',
  'notify', 'notifyPreview', 'notifySound', 'savePrompts',
  'keybindings',
];
const BOOLEANS = ['alwaysOnTop', 'tray', 'notifyPreview', 'notifySound', 'savePrompts'];
const NOTIFY = ['hidden', 'unfocused', 'never'];
const MODES = ['read', 'edit']; // never "auto" by default
const TIMEOUT = { min: 5, max: 3600 };

// Global shortcut, as an Electron accelerator: "Control+Alt+Space". At least
// Control, Alt or Super, then a letter, a digit, F1 to F24 or Space.
const ACCEL_MODIFIERS = { control: 'Control', ctrl: 'Control', alt: 'Alt', shift: 'Shift', super: 'Super', meta: 'Super' };
function normalizeAccelerator(text) {
  if (typeof text !== 'string' || text.length > 40) return null;
  const parts = text.split('+').map((p) => p.trim());
  const key = parts.pop();
  const mods = [];
  for (const p of parts) {
    const m = ACCEL_MODIFIERS[p.toLowerCase()];
    if (!m || mods.includes(m)) return null;
    mods.push(m);
  }
  if (!mods.some((m) => m !== 'Shift')) return null;
  let k = null;
  if (/^[a-z0-9]$/i.test(key)) k = key.toUpperCase();
  else if (/^f([1-9]|1\d|2[0-4])$/i.test(key)) k = key.toUpperCase();
  else if (/^space$/i.test(key)) k = 'Space';
  if (!k) return null;
  const order = ['Control', 'Alt', 'Shift', 'Super'];
  return [...order.filter((m) => mods.includes(m)), k].join('+');
}

const kbText = (list) => list.map(comboText);
const sameCombos = (a, b) => a.length === b.length && a.every((x, i) => comboId(parseCombo(x)) === comboId(parseCombo(b[i])));

/** Current values and defaults, as plain data for the window. */
function settingsView(cfg) {
  const pick = (src) => ({
    language: src.language,
    defaultAgent: src.defaultAgent,
    defaultMode: src.defaultMode === 'auto' ? 'edit' : src.defaultMode,
    timeoutSec: src.timeoutSec,
    alwaysOnTop: src.alwaysOnTop,
    tray: src.tray,
    shortcut: src.shortcut || false,
    selectionShortcut: src.selectionShortcut || false,
    notify: src.notify,
    notifyPreview: src.notifyPreview,
    notifySound: src.notifySound,
    savePrompts: src.savePrompts,
  });
  return {
    values: { ...pick(cfg), keybindings: Object.fromEntries(ACTIONS.map((a) => [a, kbText(cfg.keybindings[a] || [])])) },
    defaults: { ...pick(DEFAULTS), keybindings: Object.fromEntries(ACTIONS.map((a) => [a, [...DEFAULT_KEYBINDINGS[a]]])) },
  };
}

/**
 * Checks the values sent by the window. Unknown keys are dropped.
 * Returns { values, errors } where errors maps a field (or "keybindings.<action>")
 * to a message; nothing should be written while errors is not empty.
 */
function validateSettings(patch, { agentIds = [] } = {}) {
  const values = {};
  const errors = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { values, errors: { _: t('settings.errors.invalid') } };
  const has = (k) => Object.hasOwn(patch, k);

  if (has('language')) {
    if (patch.language === 'auto' || LANGUAGES.includes(patch.language)) values.language = patch.language;
    else errors.language = t('settings.errors.invalid');
  }
  if (has('defaultAgent')) {
    if (agentIds.includes(patch.defaultAgent)) values.defaultAgent = patch.defaultAgent;
    else errors.defaultAgent = t('settings.errors.unknownAgent');
  }
  if (has('defaultMode')) {
    if (MODES.includes(patch.defaultMode)) values.defaultMode = patch.defaultMode;
    else errors.defaultMode = t('settings.errors.invalid');
  }
  if (has('timeoutSec')) {
    const n = patch.timeoutSec;
    if (Number.isInteger(n) && n >= TIMEOUT.min && n <= TIMEOUT.max) values.timeoutSec = n;
    else errors.timeoutSec = t('settings.errors.timeout', TIMEOUT);
  }
  for (const k of BOOLEANS) {
    if (!has(k)) continue;
    if (typeof patch[k] === 'boolean') values[k] = patch[k];
    else errors[k] = t('settings.errors.invalid');
  }
  if (has('notify')) {
    if (NOTIFY.includes(patch.notify)) values.notify = patch.notify;
    else errors.notify = t('settings.errors.invalid');
  }
  for (const k of ['shortcut', 'selectionShortcut']) {
    if (!has(k)) continue;
    if (patch[k] === false || patch[k] === null || patch[k] === '') values[k] = false;
    else {
      const a = normalizeAccelerator(patch[k]);
      if (a) values[k] = a;
      else errors[k] = t('settings.errors.globalShortcut');
    }
  }
  // The two global shortcuts must differ (the panel sends both when one changes).
  if (values.selectionShortcut && values.selectionShortcut === values.shortcut) errors.selectionShortcut = t('settings.errors.sameShortcut');
  if (has('keybindings')) {
    const kb = patch.keybindings;
    if (!kb || typeof kb !== 'object' || Array.isArray(kb)) errors.keybindings = t('settings.errors.invalid');
    else {
      const given = {};
      for (const [action, list] of Object.entries(kb)) {
        if (!ACTIONS.includes(action)) continue;
        if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) {
          errors[`keybindings.${action}`] = t('settings.errors.invalid');
          continue;
        }
        given[action] = list;
      }
      const r = resolveKeybindings(given);
      for (const p of r.problems) {
        const k = p.action ? `keybindings.${p.action}` : 'keybindings';
        errors[k] = errors[k] ? `${errors[k]}\n${p.message}` : p.message;
      }
      values.keybindings = Object.fromEntries(Object.entries(given).map(([a, list]) => [a, list.map((x) => comboText(parseCombo(x) || { key: x }))]));
    }
  }
  return { values, errors };
}

/**
 * New content of config.json: the existing file with the managed keys
 * updated. A value equal to its default is removed (the file only keeps what
 * differs), and everything else (agents…) is kept as is.
 */
function mergeConfig(raw, values) {
  const out = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  for (const [k, v] of Object.entries(values)) {
    if (!MANAGED.includes(k)) continue;
    if (k === 'keybindings') {
      const kb = out.keybindings && typeof out.keybindings === 'object' && !Array.isArray(out.keybindings) ? { ...out.keybindings } : {};
      for (const [action, list] of Object.entries(v)) {
        if (sameCombos(list, DEFAULT_KEYBINDINGS[action])) delete kb[action];
        else kb[action] = list.length ? list : false;
      }
      if (Object.keys(kb).length) out.keybindings = kb;
      else delete out.keybindings;
      continue;
    }
    const def = k === 'shortcut' ? DEFAULTS.shortcut : DEFAULTS[k];
    if (v === def) delete out[k];
    else out[k] = v;
  }
  return out;
}

module.exports = { MANAGED, settingsView, validateSettings, mergeConfig, normalizeAccelerator };
