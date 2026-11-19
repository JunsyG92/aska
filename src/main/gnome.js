'use strict';
// Global shortcut on GNOME. Under Wayland an application cannot grab a global
// shortcut, so Aska uses a GNOME custom shortcut ("Aska" -> aska --toggle), the
// same entry as "scripts/install.sh --gnome-shortcut". The settings panel reads
// and writes it here, through gsettings: no shell, fixed arguments.
// Independent of Electron; `run(args)` is injected for the tests.

const SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const KEY = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/aska/';
const ENTRY = `${SCHEMA}.custom-keybinding:${KEY}`;

/**
 * The system gsettings (root-owned, not writable by others), first. Another
 * one in the PATH (Homebrew, Nix…) comes with its own GLib, often without the
 * dconf module GNOME uses: it then silently writes to a private file
 * (~/.config/glib-2.0/settings/keyfile) that GNOME never reads.
 */
function systemGsettings({ candidates = ['/usr/bin/gsettings', '/bin/gsettings'], stat = require('fs').statSync } = {}) {
  return candidates.find((p) => {
    try {
      const st = stat(p);
      return st.isFile() && st.uid === 0 && !(st.mode & 0o022);
    } catch {
      return false;
    }
  }) || null;
}

/** GNOME session on Linux (Ubuntu reports "ubuntu:GNOME"). */
const isGnomeSession = (env = process.env, platform = process.platform) =>
  platform === 'linux' && /(^|:)gnome($|:)/i.test(env.XDG_CURRENT_DESKTOP || '');

// Electron accelerator <-> GNOME binding.
const TO_GNOME = { Control: '<Control>', Alt: '<Alt>', Shift: '<Shift>', Super: '<Super>' };
function toGnome(accel) {
  if (!accel) return '';
  const parts = accel.split('+');
  const key = parts.pop();
  const k = key === 'Space' ? 'space' : /^F\d+$/.test(key) ? key : key.toLowerCase();
  return parts.map((m) => TO_GNOME[m] || '').join('') + k;
}
const FROM_GNOME = { control: 'Control', primary: 'Control', ctrl: 'Control', alt: 'Alt', shift: 'Shift', super: 'Super' };
function fromGnome(binding) {
  if (!binding) return false;
  const mods = [];
  const rest = binding.replace(/<(\w+)>/g, (_m, name) => {
    const m = FROM_GNOME[name.toLowerCase()];
    if (m && !mods.includes(m)) mods.push(m);
    return '';
  });
  if (!rest) return false;
  const key = rest.toLowerCase() === 'space' ? 'Space' : /^f\d+$/i.test(rest) ? rest.toUpperCase() : rest.length === 1 ? rest.toUpperCase() : rest;
  return [...['Control', 'Alt', 'Shift', 'Super'].filter((m) => mods.includes(m)), key].join('+');
}

// gsettings prints GVariant text: "'value'", "['/a/', '/b/']", "@as []".
const unquote = (s) => {
  const m = /^'(.*)'$/s.exec(String(s).trim());
  return m ? m[1].replace(/\\(.)/g, '$1') : String(s).trim();
};
const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const parseList = (s) => [...String(s).matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
const formatList = (list) => `[${list.map(quote).join(', ')}]`;

/** Current Aska entry: { binding: accelerator or false, command } (binding false if absent). */
async function readShortcut(run) {
  const list = parseList(await run(['get', SCHEMA, 'custom-keybindings']));
  if (!list.includes(KEY)) return { binding: false, command: '' };
  return {
    binding: fromGnome(unquote(await run(['get', ENTRY, 'binding']))),
    command: unquote(await run(['get', ENTRY, 'command'])),
  };
}

/**
 * Sets the Aska entry: added to the list of custom shortcuts if missing,
 * without touching the other entries. The command of an existing entry is
 * kept; `command` is used for a new one. `accel` false empties the binding.
 */
async function writeShortcut(run, accel, command) {
  const list = parseList(await run(['get', SCHEMA, 'custom-keybindings']));
  let cmd = '';
  if (list.includes(KEY)) cmd = unquote(await run(['get', ENTRY, 'command']));
  else await run(['set', SCHEMA, 'custom-keybindings', formatList([...list, KEY])]);
  await run(['set', ENTRY, 'name', quote('Aska')]);
  await run(['set', ENTRY, 'command', quote(cmd || command)]);
  await run(['set', ENTRY, 'binding', quote(toGnome(accel))]);
}

/** Command for a new entry: the "aska" launcher if installed, else Electron directly. */
function toggleCommand({ env = process.env, home = require('os').homedir(), exists = require('fs').existsSync, execPath = process.execPath, appPath = '' } = {}) {
  const path = require('path');
  const q = (p) => (/[\s"'\\]/.test(p) ? `"${p.replace(/(["\\$`])/g, '\\$1')}"` : p);
  const launcher = path.join(env.XDG_BIN_HOME && path.isAbsolute(env.XDG_BIN_HOME) ? env.XDG_BIN_HOME : path.join(home, '.local', 'bin'), 'aska');
  if (exists(launcher)) return `${q(launcher)} --toggle`;
  return `${q(execPath)} ${q(appPath)} --toggle`;
}

module.exports = { SCHEMA, KEY, systemGsettings, isGnomeSession, toGnome, fromGnome, parseList, readShortcut, writeShortcut, toggleCommand };
