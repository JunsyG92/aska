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
// macOS: /etc and /var are links to /private/… (the real path is compared).
const DARWIN_DIRS = ['/private/etc', '/private/var/db', '/private/var/root', '/System', '/Library', '/Applications'];

function posixSystemDirs(platform = process.platform) {
  return platform === 'darwin' ? [...SYSTEM_DIRS, ...DARWIN_DIRS] : SYSTEM_DIRS;
}

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
    const system = POSIX ? posixSystemDirs() : windowsSystemDirs();
    if (!inHome && system.some((d) => within(real, d))) {
      return { error: t('security.systemRefused', { path: real }) };
    }
    const first = inHome ? path.relative(realHome, real).split(path.sep)[0] : '';
    // .aska: the bots' settings and personalities (a bot must not rewrite its own maxMode).
    // ~/Library (macOS): keychains, preferences and the data of every app.
    if (inHome && /^(\.(ssh|gnupg|config|local|aws|azure|kube|docker|aska)|appdata|library)$/i.test(first)) {
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

// ---------- POSIX ACLs ----------
// Some systems (domain-joined machines, home folders managed by a policy) put
// an ACL on every file that names its owner with rwx. The ACL mask then shows up
// as the group bits (mode 670), although nobody else can write. These helpers
// read the real ACL, so that only a file someone else can actually write is refused.

/**
 * From the output of "getfacl --omit-header --numeric": can a user other than
 * ownerUid write the file? null if the output cannot be read.
 */
function aclWritableByOthers(text, ownerUid) {
  const entries = String(text)
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((l) => l.split(':'))
    .filter((p) => p.length === 3 && /^[r-][w-][x-]$/.test(p[2]));
  if (!entries.some(([tag]) => tag === 'user') || !entries.some(([tag]) => tag === 'other')) return null;
  const mask = entries.find(([tag]) => tag === 'mask');
  const effectiveW = (perm) => perm[1] === 'w' && (!mask || mask[2][1] === 'w');
  for (const [tag, qualifier, perm] of entries) {
    if (tag === 'user' && qualifier !== '' && Number(qualifier) !== ownerUid && effectiveW(perm)) return true;
    if (tag === 'group' && effectiveW(perm)) return true; // owning group or named group
    if (tag === 'other' && perm[1] === 'w') return true;
  }
  return false;
}

// getfacl from the system only (root-owned, not writable by others), never from the PATH.
const GETFACL = ['/usr/bin/getfacl', '/bin/getfacl'].find((p) => {
  try {
    const st = fs.statSync(p);
    return st.uid === 0 && !(st.mode & 0o022);
  } catch {
    return false;
  }
});

/** Linux, file open on fd: does its ACL let someone else write it? true when unknown. */
function othersCanWriteAcl(fd, ownerUid) {
  if (process.platform !== 'linux' || !GETFACL) return true;
  // Through the open descriptor: the file checked is the file read.
  const r = require('child_process').spawnSync(GETFACL, ['--omit-header', '--numeric', '--absolute-names', `/proc/${process.pid}/fd/${fd}`], { encoding: 'utf8', timeout: 3000 });
  if (r.status !== 0 || r.error) return true;
  const w = aclWritableByOthers(r.stdout, ownerUid);
  return w === null ? true : w;
}

/**
 * Reads a text file only if it belongs to the user and only they can write it.
 * { text } | { missing: true } | { error }. The UTF-8 BOM is stripped (Windows
 * PowerShell 5.1 and Notepad add one); a file over maxBytes is refused.
 */
function readOwnedText(file, maxBytes = Infinity) {
  const r = readOwnedFile(file, maxBytes);
  return r.data ? { text: r.data.toString('utf8').replace(/^\uFEFF/, '') } : r;
}

/** Same checks as readOwnedText, for a binary file: { data: Buffer } | { missing } | { error }. */
function readOwnedFile(file, maxBytes = Infinity) {
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
    if (!st.isFile()) return { error: t('security.notAFile', { file }) };
    if (POSIX && st.uid !== uid()) return { error: t('security.fileNotOwned', { file }) };
    // Group or other write bit: refused, unless the real ACL shows that only the owner can write.
    if (POSIX && st.mode & 0o022 && othersCanWriteAcl(fd, st.uid)) {
      return { error: t('security.fileWritable', { file }) };
    }
    if (st.size > maxBytes) return { error: t('security.fileTooBig', { file, max: Math.round(maxBytes / 1024) }) };
    return { data: fs.readFileSync(fd) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Reads a JSON file only if it belongs to the user and only they can write it. */
function readOwnedJson(file) {
  const r = readOwnedText(file);
  if (r.text === undefined) return r;
  try {
    return { data: JSON.parse(r.text) };
  } catch (e) {
    return { error: t('security.invalidJson', { file, error: e.message }) };
  }
}

/** Folders the user has permanently allowed writing to. */
class TrustStore {
  constructor(file) {
    this.file = file;
    this.dirs = new Set();
    // Remote actions allowed "always for this folder": folder -> bot id -> commands.
    this.remote = new Map();
    const r = readOwnedJson(file);
    if (r.data && Array.isArray(r.data.dirs)) {
      for (const d of r.data.dirs) if (typeof d === 'string' && path.isAbsolute(d)) this.dirs.add(d);
    }
    const rem = r.data && r.data.remote;
    if (rem && typeof rem === 'object' && !Array.isArray(rem)) {
      for (const [d, bots] of Object.entries(rem)) {
        if (!path.isAbsolute(d) || !bots || typeof bots !== 'object') continue;
        const byBot = new Map();
        for (const [id, cmds] of Object.entries(bots)) {
          if (/^[a-z][a-z0-9_-]{0,31}$/.test(id) && Array.isArray(cmds)) byBot.set(id, new Set(cmds.filter((c) => typeof c === 'string')));
        }
        this.remote.set(d, byBot);
      }
    }
  }
  isTrusted(real) {
    for (const d of this.dirs) if (within(real, d)) return true;
    return false;
  }
  add(real) {
    this.dirs.add(real);
    this.save();
  }
  /** Were all these remote commands allowed for this bot in this folder (or a parent)? */
  isRemoteTrusted(real, botId, cmds) {
    const granted = new Set();
    for (const [d, byBot] of this.remote) if (within(real, d) && byBot.has(botId)) for (const c of byBot.get(botId)) granted.add(c);
    return cmds.every((c) => granted.has(c));
  }
  addRemote(real, botId, cmds) {
    if (!this.remote.has(real)) this.remote.set(real, new Map());
    const byBot = this.remote.get(real);
    byBot.set(botId, new Set([...(byBot.get(botId) || []), ...cmds]));
    this.save();
  }
  save() {
    const remote = Object.fromEntries([...this.remote].map(([d, byBot]) => [d, Object.fromEntries([...byBot].map(([id, cmds]) => [id, [...cmds]]))]));
    writePrivate(this.file, JSON.stringify({ dirs: [...this.dirs], ...(this.remote.size ? { remote } : {}) }, null, 2));
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
  resolveBinary, buildEnv, checkWorkdir, readOwnedJson, readOwnedText, readOwnedFile, writePrivate, ensurePrivateDir, aclWritableByOthers,
  TrustStore, appendAudit, readRecentPrompts, BASE_ENV, setEnvVar, within, posixSystemDirs,
};
