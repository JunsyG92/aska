'use strict';
// Safeguards independent of Electron: binaries, environment, folders, audit log.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { t } = require('../i18n');

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);
// On Windows, POSIX owners and permissions do not exist (fs.stat makes them up):
// these checks do not apply there. The Windows user profile (AppData…) is by
// default only accessible to its owner and to administrators.
const POSIX = process.platform !== 'win32';
// Path comparison: case-insensitive on Windows.
const norm = (p) => (POSIX ? p : p.toLowerCase());
const within = (child, parent) => norm(child) === norm(parent) || norm(child).startsWith(norm(parent).replace(/[\\/]+$/, '') + path.sep);

/** A file/folder is "safe" if it belongs to root or to the user and is not writable by others. */
function checkOwnedNotWritable(p, { allowSticky = false } = {}) {
  if (!POSIX) return null;
  const st = fs.statSync(p);
  if (st.uid !== 0 && st.uid !== uid()) return t('security.otherOwner', { path: p });
  const worldWritable = (st.mode & 0o002) !== 0;
  const sticky = (st.mode & 0o1000) !== 0;
  if (worldWritable && !(allowSticky && sticky)) return t('security.worldWritable', { path: p });
  return null;
}

/**
 * Finds an agent's binary and returns its absolute real path.
 * Rejects relative PATH entries and any binary another user could replace.
 */
// Extensions tried on Windows, in order. A name without extension is never
// used there: npm puts a shell script for Git Bash next to the ".cmd".
const WIN_EXT = ['.exe', '.cmd', '.bat', '.com'];

function resolveBinary(names, { override, envPath = process.env.PATH || '', avoid, platform = process.platform } = {}) {
  const candidates = [];
  if (override) {
    if (!path.isAbsolute(override)) return { error: t('security.binNotAbsolute', { path: override }) };
    candidates.push(override);
  } else {
    const delimiter = platform === 'win32' ? ';' : ':';
    for (const dir of envPath.split(delimiter)) {
      if (!dir || !path.isAbsolute(dir)) continue; // "." or relative path in PATH: ignored
      for (const name of names) {
        if (platform === 'win32') for (const ext of WIN_EXT) candidates.push(path.join(dir, name + ext));
        else candidates.push(path.join(dir, name));
      }
    }
    // Locations "to avoid" (fake launchers) are tried as a last resort.
    if (avoid) candidates.sort((a, b) => Number(avoid.test(a)) - Number(avoid.test(b)));
  }
  let lastError = null;
  for (const cand of candidates) {
    let real;
    try {
      real = fs.realpathSync(cand);
      const st = fs.statSync(real);
      if (!st.isFile()) continue;
      fs.accessSync(real, fs.constants.X_OK);
    } catch {
      continue;
    }
    try {
      const problem =
        checkOwnedNotWritable(real) ||
        checkOwnedNotWritable(path.dirname(real)) ||
        checkOwnedNotWritable(path.dirname(cand));
      if (problem) {
        lastError = t('security.binaryRejected', { problem });
        continue;
      }
    } catch (e) {
      lastError = e.message;
      continue;
    }
    return { path: real };
  }
  return { error: lastError || t('security.notInPath') };
}

// Variables passed to all agents. The rest of the environment (cloud tokens,
// exported passwords…) is removed.
const BASE_ENV = [
  // Windows (names are case-insensitive there: "Path", "SystemRoot"…)
  ...(POSIX ? [] : [
    'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'OS', 'TEMP', 'TMP',
    'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  ]),
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'LC_*', 'TZ', 'TMPDIR',
  'XDG_*', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
];

function matchPattern(name, pattern, caseless = !POSIX) {
  const n = caseless ? name.toUpperCase() : name;
  const p = caseless ? pattern.toUpperCase() : pattern;
  return p.endsWith('*') ? n.startsWith(p.slice(0, -1)) : n === p;
}

/** Replaces an environment variable, removing its case variants (Windows: "Path" and "PATH"). */
function setEnvVar(env, name, value) {
  for (const k of Object.keys(env)) if (k.toUpperCase() === name.toUpperCase()) delete env[k];
  env[name] = value;
  return env;
}

function buildEnv(source, agentPatterns = [], extraPatterns = []) {
  const patterns = [...BASE_ENV, ...agentPatterns, ...extraPatterns];
  const env = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === 'string' && patterns.some((p) => matchPattern(k, p))) env[k] = v;
  }
  env.NO_COLOR = '1';
  env.TERM = 'dumb';
  return env;
}

function windowsSystemDirs(env = process.env) {
  const pick = (name, fallback) => {
    const k = Object.keys(env).find((x) => x.toUpperCase() === name.toUpperCase());
    return k && path.isAbsolute(env[k]) ? env[k] : fallback;
  };
  return [
    pick('SystemRoot', 'C:\\Windows'),
    pick('ProgramFiles', 'C:\\Program Files'),
    pick('ProgramFiles(x86)', 'C:\\Program Files (x86)'),
    pick('ProgramData', 'C:\\ProgramData'),
  ];
}

const SYSTEM_DIRS = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/var', '/sys', '/proc', '/dev', '/run', '/root', '/snap'];

/** Validates the working folder. In write modes, rejects folders that are too broad or system folders. */
function checkWorkdir(dir, mode, home = os.homedir(), ownDirs = []) {
  let real;
  try {
    real = fs.realpathSync(dir);
    if (!fs.statSync(real).isDirectory()) return { error: t('security.notAFolder', { dir }) };
  } catch {
    return { error: t('security.folderNotFound', { dir }) };
  }
  if (mode !== 'read' && !ownDirs.some((d) => norm(d) === norm(real))) {
    const realHome = (() => { try { return fs.realpathSync(home); } catch { return home; } })();
    if (path.parse(real).root === real) return { error: t('security.rootRefused') };
    if (norm(real) === norm(realHome)) {
      return { error: t('security.homeRefused') };
    }
    const inHome = within(real, realHome);
    const system = POSIX ? SYSTEM_DIRS : windowsSystemDirs();
    if (!inHome && system.some((d) => within(real, d))) {
      return { error: t('security.systemRefused', { path: real }) };
    }
    const first = inHome ? path.relative(realHome, real).split(path.sep)[0] : '';
    if (inHome && /^(\.(ssh|gnupg|config|local|aws|azure|kube|docker)|appdata)$/i.test(first)) {
      return { error: t('security.sensitiveRefused', { path: `~${path.sep}${path.relative(realHome, real)}` }) };
    }
  }
  return { path: real };
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writePrivate(file, data) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Reads a JSON file only if it belongs to the user and only they can write it. */
function readOwnedJson(file) {
  // The checks and the read go through the same descriptor: the file cannot be
  // swapped between the two (symbolic links are followed, as before).
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { missing: true };
  }
  try {
    const st = fs.fstatSync(fd);
    if (POSIX && st.uid !== uid()) return { error: t('security.fileNotOwned', { file }) };
    if (POSIX && st.mode & 0o022) {
      return { error: t('security.fileWritable', { file }) };
    }
    try {
      // UTF-8 BOM stripped: Windows PowerShell 5.1 and Notepad add one.
      return { data: JSON.parse(fs.readFileSync(fd, 'utf8').replace(/^\uFEFF/, '')) };
    } catch (e) {
      return { error: t('security.invalidJson', { file, error: e.message }) };
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Folders the user has permanently allowed writing to. */
class TrustStore {
  constructor(file) {
    this.file = file;
    this.dirs = new Set();
    const r = readOwnedJson(file);
    if (r.data && Array.isArray(r.data.dirs)) {
      for (const d of r.data.dirs) if (typeof d === 'string' && path.isAbsolute(d)) this.dirs.add(d);
    }
  }
  isTrusted(real) {
    for (const d of this.dirs) if (within(real, d)) return true;
    return false;
  }
  add(real) {
    this.dirs.add(real);
    writePrivate(this.file, JSON.stringify({ dirs: [...this.dirs] }, null, 2));
  }
}

const MAX_LOG = 5 * 1024 * 1024;

/** JSONL audit log (0600), one line per run. */
function appendAudit(file, entry) {
  try {
    ensurePrivateDir(path.dirname(file));
    try {
      if (fs.statSync(file).size > MAX_LOG) fs.renameSync(file, `${file}.1`);
    } catch { /* no audit log yet */ }
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch { /* the audit log must never block a run */ }
}

function readRecentPrompts(file, limit = 50) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-400);
    const out = [];
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        if (typeof e.prompt === 'string' && e.prompt && out[out.length - 1] !== e.prompt) out.push(e.prompt);
      } catch { /* corrupted line */ }
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

module.exports = {
  resolveBinary, buildEnv, checkWorkdir, readOwnedJson, writePrivate, ensurePrivateDir,
  TrustStore, appendAudit, readRecentPrompts, BASE_ENV, setEnvVar, within,
};
