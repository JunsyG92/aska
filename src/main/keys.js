'use strict';
// Keyboard shortcuts inside the window, configurable with "keybindings" in the
// config. Independent of Electron: the main process parses and checks them,
// the renderer only compares key events with the parsed combos it receives.
//
// A combo is written like an Electron accelerator: "Ctrl+Shift+M", "Alt+H",
// "Ctrl+PageDown". Modifiers: Ctrl (Control), Shift, Alt (Option), Meta (Cmd,
// Command, Super). The key is one printable character or a named key.

const { t } = require('../i18n');

// Configurable actions and their default shortcuts. The order is the one shown
// in "aska --help" and in the settings.
const DEFAULT_KEYBINDINGS = {
  newTab: ['Ctrl+T', 'Ctrl+N', 'Ctrl+L'],
  closeTab: ['Ctrl+W'],
  nextTab: ['Ctrl+Tab', 'Ctrl+PageDown'],
  prevTab: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'],
  history: ['Ctrl+H'],
  pickDir: ['Ctrl+O'],
  sources: ['Ctrl+D'], // documents and links of the conversation
  modelMenu: ['Ctrl+Shift+M'],
  copyAnswer: ['Ctrl+Shift+C'],
  rerun: ['Ctrl+R'], // run again in a wider mode, after denied actions
  toggleMini: ['Ctrl+M'],
  togglePin: ['Ctrl+P'],
  settings: ['Ctrl+,'],
};
const ACTIONS = Object.keys(DEFAULT_KEYBINDINGS);

// Named keys allowed besides single characters. Enter, Escape, the arrows,
// Backspace and Delete stay fixed: they drive typing and the lists.
const NAMED_KEYS = ['Tab', 'PageUp', 'PageDown', 'Home', 'End', 'Insert', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)];
const NAMED = new Map(NAMED_KEYS.map((k) => [k.toLowerCase(), k]));

const MODIFIERS = {
  ctrl: 'ctrl', control: 'ctrl',
  shift: 'shift',
  alt: 'alt', option: 'alt',
  meta: 'meta', cmd: 'meta', command: 'meta', super: 'meta',
};

/** "Ctrl+Shift+M" -> { ctrl, shift, alt, meta, key: 'm' }, or null if invalid. */
function parseCombo(text) {
  if (typeof text !== 'string' || text.length > 40) return null;
  const parts = text.split('+').map((p) => p.trim());
  if (parts.some((p) => !p)) return null; // "Ctrl++", "Ctrl+"
  const combo = { ctrl: false, shift: false, alt: false, meta: false, key: null };
  for (const [i, part] of parts.entries()) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (mod && i < parts.length - 1) {
      if (combo[mod]) return null;
      combo[mod] = true;
    } else if (i === parts.length - 1) {
      if ([...part].length === 1 && /\S/u.test(part)) combo.key = part.toLowerCase();
      else combo.key = NAMED.get(part.toLowerCase()) || null;
    } else return null;
  }
  return combo.key ? combo : null;
}

/** Canonical form, to compare two combos. */
const comboId = (c) => [c.ctrl && 'ctrl', c.alt && 'alt', c.shift && 'shift', c.meta && 'meta', c.key].filter(Boolean).join('+');

/**
 * Why a combo cannot be bound, or null. Without Ctrl, Alt or Meta it would
 * swallow typing; some combos belong to text editing or to fixed shortcuts.
 */
function reservedReason(c) {
  if (!c.ctrl && !c.alt && !c.meta) return 'needsModifier';
  const editor = (c.ctrl || c.meta) && !c.alt;
  if (editor && ['a', 'c', 'v', 'x', 'z', 'y'].includes(c.key) && !(c.key === 'c' && c.shift)) return 'editing';
  if (c.ctrl && !c.shift && !c.alt && !c.meta && /^[1-9]$/.test(c.key)) return 'tabNumbers';
  return null;
}

/**
 * Shortcuts from the "keybindings" config value: each action given replaces
 * its defaults ([] or false removes them). A combo given for an action is
 * taken away from the action that had it by default; between two configured
 * actions, the first one keeps it.
 * Returns { bindings: { action: [combo] }, warnings: [string], problems: [{ action, message }] }
 * (problems: the same warnings, tied to their action, for the settings panel).
 */
function resolveKeybindings(user) {
  const warnings = [];
  const problems = [];
  const warn = (action, message) => {
    warnings.push(message);
    problems.push({ action, message });
  };
  const configured = {};
  if (user !== undefined && (user === null || typeof user !== 'object' || Array.isArray(user))) {
    warn(null, t('keys.invalidSection'));
    user = {};
  }
  for (const [action, value] of Object.entries(user || {})) {
    if (!ACTIONS.includes(action)) {
      warn(null, t('keys.unknownAction', { action }));
      continue;
    }
    const list = value === false ? [] : typeof value === 'string' ? [value] : value;
    if (!Array.isArray(list)) {
      warn(action, t('keys.invalidValue', { action }));
      continue;
    }
    const combos = [];
    for (const text of list) {
      const combo = parseCombo(text);
      if (!combo) warn(action, t('keys.invalidCombo', { action, combo: String(text) }));
      else if (reservedReason(combo)) warn(action, t(`keys.reserved.${reservedReason(combo)}`, { action, combo: text }));
      else combos.push(combo);
    }
    // Nothing usable: the defaults stay rather than leaving the action without a key by mistake.
    if (combos.length || !list.length) configured[action] = combos;
  }

  const owner = new Map(); // comboId -> action
  const bindings = {};
  for (const action of Object.keys(configured)) {
    bindings[action] = [];
    for (const c of configured[action]) {
      const id = comboId(c);
      if (owner.has(id)) {
        warn(action, t('keys.conflict', { combo: formatCombo(c), action, other: owner.get(id) }));
        continue;
      }
      owner.set(id, action);
      bindings[action].push(c);
    }
  }
  for (const action of ACTIONS) {
    if (Object.hasOwn(configured, action)) continue;
    bindings[action] = DEFAULT_KEYBINDINGS[action].map(parseCombo).filter((c) => !owner.has(comboId(c)));
    for (const c of bindings[action]) owner.set(comboId(c), action);
  }
  // Same order as ACTIONS, whatever the order of the config.
  return { bindings: Object.fromEntries(ACTIONS.map((a) => [a, bindings[a]])), warnings, problems };
}

/** Readable combo in the current language: "Ctrl+Shift+M" / "Ctrl+Maj+M". */
function formatCombo(c) {
  const name = (k) => t(`keys.names.${k}`);
  const key = c.key.length === 1 ? c.key.toUpperCase() : NAMED_KEYS.includes(c.key) && /^F\d/.test(c.key) ? c.key : name(c.key);
  return [c.ctrl && name('Ctrl'), c.alt && name('Alt'), c.shift && name('Shift'), c.meta && name('Meta'), key].filter(Boolean).join('+');
}

/** Canonical text, as written in the config: "Ctrl+Shift+M", "Ctrl+PageDown". */
function comboText(c) {
  const key = c.key.length === 1 ? c.key.toUpperCase() : c.key;
  return [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', c.meta && 'Meta', key].filter(Boolean).join('+');
}

/** Label of each action: its first shortcut, or "no shortcut". */
function keyLabels(bindings) {
  return Object.fromEntries(ACTIONS.map((a) => [a, bindings[a] && bindings[a].length ? formatCombo(bindings[a][0]) : t('keys.unassigned')]));
}

module.exports = { ACTIONS, DEFAULT_KEYBINDINGS, NAMED_KEYS, parseCombo, comboId, comboText, reservedReason, resolveKeybindings, formatCombo, keyLabels };
