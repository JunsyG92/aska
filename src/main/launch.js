'use strict';
// How to launch an agent's binary without ever passing the text of a request
// to a command interpreter.
//
// On Linux, the binary runs as is. On Windows, CLIs installed by npm are ".cmd"
// launchers, which Windows can only run through cmd.exe, which interprets
// %VAR%, &, |, ^… in the arguments. So the npm launcher is read to find the
// script it calls, and node.exe is run on that script directly. A ".cmd" in any
// other format is accepted only if no argument contains a character that
// cmd.exe could interpret.

const fs = require('fs');
const path = require('path');
const { t } = require('../i18n');

const WIN = process.platform === 'win32';
const SCRIPT_EXT = /\.(c|m)?js$/i;
// Arguments safe for cmd.exe: flags, model names, ids.
const CMD_SAFE_ARG = /^[A-Za-z0-9_.:/\\=,@+[\]-]*$/;

/** Looks for an executable file (by its exact name) in a list of folders. */
function findOnPath(name, envPath) {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* missing */ }
  }
  return null;
}

/**
 * npm launcher (cmd-shim): the last line looks like
 *   "%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*
 * or, for a native binary,
 *   "%dp0%\node_modules\pkg\bin\tool.exe"   %*
 */
function parseNpmShim(text, shimPath) {
  const dir = path.dirname(shimPath);
  // "%dp0%" (variable set by the launcher) or "%~dp0" (direct form).
  const m = [...text.matchAll(/"%(?:dp0%|~dp0)\\?([^"%\r\n]+)"\s+%\*/gi)].pop();
  if (!m) return null;
  const target = path.resolve(dir, m[1].replace(/[\\/]+/g, path.sep));
  if (!target.startsWith(dir + path.sep)) return null; // the launcher must only target its own folder
  return { target, viaNode: SCRIPT_EXT.test(target) || /%_prog%/i.test(text) };
}

/**
 * @returns {{ command: string, prefix: string[], viaCmd: boolean } | { error: string }}
 */
function resolveLaunch(binPath, { envPath = process.env.PATH || '', platform = process.platform } = {}) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(binPath)) {
    if (platform === 'win32' && SCRIPT_EXT.test(binPath)) {
      const node = findOnPath('node.exe', envPath);
      return node ? { command: node, prefix: [binPath], viaCmd: false } : { error: t('launch.nodeNotFound') };
    }
    return { command: binPath, prefix: [], viaCmd: false };
  }
  let text;
  try {
    text = fs.readFileSync(binPath, 'utf8');
  } catch (e) {
    return { error: t('launch.unreadable', { error: e.message }) };
  }
  const shim = parseNpmShim(text, binPath);
  if (shim) {
    try {
      if (!fs.statSync(shim.target).isFile()) throw new Error();
    } catch {
      return { error: t('launch.missingTarget', { launcher: path.basename(binPath), target: shim.target }) };
    }
    if (!shim.viaNode) return { command: shim.target, prefix: [], viaCmd: false };
    const local = path.join(path.dirname(binPath), 'node.exe');
    const node = fs.existsSync(local) ? local : findOnPath('node.exe', envPath);
    if (!node) return { error: t('launch.nodeNotFound') };
    return { command: node, prefix: [shim.target], viaCmd: false };
  }
  // Other launcher: goes through cmd.exe, only for safe arguments.
  if (/[%^"&|<>!]/.test(binPath)) return { error: t('launch.unsupportedPath', { path: binPath }) };
  return { command: binPath, prefix: [], viaCmd: true };
}

/**
 * Final command to pass to spawn().
 * @returns {{ command: string, args: string[], verbatim: boolean }}
 */
function buildCommand(launch, argv) {
  const args = [...launch.prefix, ...argv];
  if (!launch.viaCmd) return { command: launch.command, args, verbatim: false };
  const bad = args.find((a) => !CMD_SAFE_ARG.test(a));
  if (bad !== undefined) {
    throw new Error(t('launch.cmdInterpret', { arg: bad.slice(0, 40) }));
  }
  const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  return { command: comspec, args: ['/d', '/s', '/c', `""${launch.command}" ${args.join(' ')}"`], verbatim: true };
}

// ---------- command-line length ----------
// Each system limits what a program can receive (measured on 2026-11-25):
// - Windows: the whole command line once quoted (CreateProcess), 32,767 UTF-16
//   units with the final NUL; through cmd.exe, 8,191.
// - Linux: each argument 128 KiB in bytes, NUL included (MAX_ARG_STRLEN), and all
//   arguments plus the environment a quarter of the stack (usually 2 MiB).
// - macOS: arguments plus environment, 1 MiB (ARG_MAX).
// A prompt passed as an argument (Copilot, Cursor) can reach these limits.

const WIN_MAX = 32767;
const CMD_MAX = 8191;
const LINUX_ARG_MAX = 128 * 1024;
const TOTAL_MAX = 1024 * 1024; // macOS; also kept as a safe total on Linux

/** Length of an argument once quoted by libuv (quote_cmd_arg) for CreateProcess. */
function quotedLength(arg) {
  if (!arg.length) return 2; // ""
  if (!/[ \t"]/.test(arg)) return arg.length;
  if (!/["\\]/.test(arg)) return arg.length + 2;
  // Each " is escaped, and so are the backslashes right before a " or the closing quote.
  let n = arg.length + 2;
  let beforeQuote = true; // read from the end: the closing quote comes first
  for (let i = arg.length - 1; i >= 0; i--) {
    const c = arg[i];
    if (c === '"') {
      n++;
      beforeQuote = true;
    } else if (c === '\\' && beforeQuote) n++;
    else beforeQuote = false;
  }
  return n;
}

const bytes = (s) => Buffer.byteLength(s, 'utf8') + 1; // with the final NUL

/**
 * How far a command goes beyond the system limit (0: it can be started).
 * Unit: UTF-16 units on Windows, bytes elsewhere. `env` counts on macOS and Linux.
 */
function commandLineExcess(command, args, { platform = process.platform, verbatim = false, env = null } = {}) {
  if (platform === 'win32') {
    if (verbatim) return Math.max(0, [command, ...args].join(' ').length + 1 - CMD_MAX);
    const len = [command, ...args].reduce((n, a) => n + quotedLength(a) + 1, 0); // spaces, then the NUL
    return Math.max(0, len - WIN_MAX);
  }
  let excess = 0;
  let total = bytes(command);
  for (const a of args) {
    const b = bytes(a);
    total += b + 8; // + the pointer to it
    if (platform === 'linux') excess = Math.max(excess, b - LINUX_ARG_MAX);
  }
  for (const [k, v] of Object.entries(env || {})) total += bytes(`${k}=${v}`) + 8;
  return Math.max(excess, total - TOTAL_MAX);
}

/**
 * Extended PATH: a graphical session does not always have the terminal's PATH,
 * so the usual locations of user-installed CLIs are added.
 */
function extendedPath({ env = process.env, home = require('os').homedir(), platform = process.platform } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const get = (name) => {
    const k = Object.keys(env).find((x) => x.toUpperCase() === name.toUpperCase());
    return k ? env[k] : undefined;
  };
  let extra;
  if (platform === 'win32') {
    const appData = get('APPDATA') || p.join(home, 'AppData', 'Roaming');
    const local = get('LOCALAPPDATA') || p.join(home, 'AppData', 'Local');
    extra = [
      p.join(appData, 'npm'), // npm i -g
      p.join(home, '.local', 'bin'), // Claude Code native installer
      p.join(local, 'cursor-agent'),
      p.join(home, '.bun', 'bin'),
      p.join(local, 'Volta', 'bin'),
      p.join(get('ProgramFiles') || 'C:\\Program Files', 'nodejs'),
    ];
  } else {
    extra = ['.local/bin', 'bin', '.npm-global/bin', '.bun/bin', '.volta/bin'].map((d) => p.join(home, d));
    extra.push('/usr/local/bin');
    if (platform === 'darwin') extra.push('/opt/homebrew/bin'); // Homebrew on Apple Silicon
  }
  const parts = (get('PATH') || '').split(p.delimiter).filter((d) => d && p.isAbsolute(d));
  for (const d of extra) if (!parts.includes(d)) parts.push(d);
  return parts.join(p.delimiter);
}

module.exports = { resolveLaunch, buildCommand, parseNpmShim, findOnPath, extendedPath, quotedLength, commandLineExcess, WIN };
