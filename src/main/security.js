'use strict';
// Garde-fous indépendants d'Electron : binaires, environnement, dossiers, journal.

const fs = require('fs');
const os = require('os');
const path = require('path');

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);

/** Un fichier/dossier est « sûr » s'il appartient à root ou à l'utilisateur et n'est pas modifiable par les autres. */
function checkOwnedNotWritable(p, { allowSticky = false } = {}) {
  const st = fs.statSync(p);
  if (st.uid !== 0 && st.uid !== uid()) return `${p} appartient à un autre utilisateur`;
  const worldWritable = (st.mode & 0o002) !== 0;
  const sticky = (st.mode & 0o1000) !== 0;
  if (worldWritable && !(allowSticky && sticky)) return `${p} est modifiable par tous les utilisateurs`;
  return null;
}

/**
 * Trouve le binaire d'un agent et renvoie son chemin réel absolu.
 * Refuse les entrées PATH relatives et tout binaire qu'un autre utilisateur
 * pourrait remplacer.
 */
function resolveBinary(names, { override, envPath = process.env.PATH || '' } = {}) {
  const candidates = [];
  if (override) {
    if (!path.isAbsolute(override)) return { error: `"bin" doit être un chemin absolu (${override})` };
    candidates.push(override);
  } else {
    for (const dir of envPath.split(':')) {
      if (!dir || !path.isAbsolute(dir)) continue; // « . » ou chemin relatif dans PATH : ignoré
      for (const name of names) candidates.push(path.join(dir, name));
    }
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
        lastError = `binaire refusé : ${problem}`;
        continue;
      }
    } catch (e) {
      lastError = e.message;
      continue;
    }
    return { path: real };
  }
  return { error: lastError || 'introuvable dans le PATH' };
}

// Variables transmises à tous les agents. Tout le reste de l'environnement
// (jetons cloud, mots de passe exportés…) est retiré.
const BASE_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'LC_*', 'TZ', 'TMPDIR',
  'XDG_*', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
];

function matchPattern(name, pattern) {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
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

const SYSTEM_DIRS = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/var', '/sys', '/proc', '/dev', '/run', '/root', '/snap'];

/** Valide le dossier de travail. En mode écriture, refuse les dossiers trop larges ou système. */
function checkWorkdir(dir, mode, home = os.homedir(), ownDirs = []) {
  let real;
  try {
    real = fs.realpathSync(dir);
    if (!fs.statSync(real).isDirectory()) return { error: `${dir} n'est pas un dossier` };
  } catch {
    return { error: `Dossier introuvable : ${dir}` };
  }
  if (mode !== 'read' && !ownDirs.includes(real)) {
    const realHome = (() => { try { return fs.realpathSync(home); } catch { return home; } })();
    if (real === '/') return { error: 'Écriture refusée à la racine du système' };
    if (real === realHome) {
      return { error: 'Écriture refusée dans votre dossier personnel entier : choisissez un dossier de projet (Ctrl+O)' };
    }
    const inHome = real.startsWith(realHome + path.sep);
    if (!inHome && SYSTEM_DIRS.some((d) => real === d || real.startsWith(d + path.sep))) {
      return { error: `Écriture refusée dans un dossier système (${real})` };
    }
    const rel = path.relative(realHome, real);
    if (inHome && /^\.(ssh|gnupg|config|local|aws|kube|docker)(\/|$)/.test(rel)) {
      return { error: `Écriture refusée dans un dossier sensible (~/${rel})` };
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

/** Lit un fichier JSON seulement s'il appartient à l'utilisateur et que lui seul peut l'écrire. */
function readOwnedJson(file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { missing: true };
  }
  if (st.isSymbolicLink()) st = fs.statSync(file);
  if (st.uid !== uid()) return { error: `${file} n'appartient pas à l'utilisateur courant` };
  if (st.mode & 0o022) {
    return { error: `${file} est modifiable par d'autres utilisateurs (chmod 600 requis)` };
  }
  try {
    return { data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { error: `${file} : JSON invalide (${e.message})` };
  }
}

/** Dossiers pour lesquels l'utilisateur a accordé durablement l'écriture. */
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
    for (const d of this.dirs) if (real === d || real.startsWith(d + path.sep)) return true;
    return false;
  }
  add(real) {
    this.dirs.add(real);
    writePrivate(this.file, JSON.stringify({ dirs: [...this.dirs] }, null, 2));
  }
}

const MAX_LOG = 5 * 1024 * 1024;

/** Journal d'audit JSONL (0600), une ligne par exécution. */
function appendAudit(file, entry) {
  try {
    ensurePrivateDir(path.dirname(file));
    try {
      if (fs.statSync(file).size > MAX_LOG) fs.renameSync(file, `${file}.1`);
    } catch { /* pas encore de journal */ }
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch { /* le journal ne doit jamais bloquer une exécution */ }
}

function readRecentPrompts(file, limit = 50) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-400);
    const out = [];
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        if (typeof e.prompt === 'string' && e.prompt && out[out.length - 1] !== e.prompt) out.push(e.prompt);
      } catch { /* ligne corrompue */ }
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

module.exports = {
  resolveBinary, buildEnv, checkWorkdir, readOwnedJson, writePrivate, ensurePrivateDir,
  TrustStore, appendAudit, readRecentPrompts, BASE_ENV,
};
