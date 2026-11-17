'use strict';
// Comment lancer le binaire d'un agent, sans jamais passer le texte d'une
// demande à un interpréteur de commandes.
//
// Sous Linux, le binaire se lance tel quel. Sous Windows, les CLI installés par
// npm sont des lanceurs « .cmd », que Windows ne sait exécuter que via cmd.exe,
// lequel interprète %VAR%, &, |, ^… dans les arguments. On lit donc le lanceur
// npm pour retrouver le script qu'il appelle, et on lance node.exe sur ce script
// directement. Un « .cmd » d'un autre format n'est accepté que si aucun argument
// ne contient de caractère que cmd.exe pourrait interpréter.

const fs = require('fs');
const path = require('path');

const WIN = process.platform === 'win32';
const SCRIPT_EXT = /\.(c|m)?js$/i;
// Arguments sans danger pour cmd.exe : flags, noms de modèles, identifiants.
const CMD_SAFE_ARG = /^[A-Za-z0-9_.:/\\=,@+[\]-]*$/;

/** Cherche un fichier exécutable (par son nom exact) dans une liste de dossiers. */
function findOnPath(name, envPath) {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* absent */ }
  }
  return null;
}

/**
 * Lanceur npm (cmd-shim) : la dernière ligne ressemble à
 *   "%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*
 * ou, pour un binaire natif,
 *   "%dp0%\node_modules\pkg\bin\outil.exe"   %*
 */
function parseNpmShim(text, shimPath) {
  const dir = path.dirname(shimPath);
  // « %dp0% » (variable posée par le lanceur) ou « %~dp0 » (forme directe).
  const m = [...text.matchAll(/"%(?:dp0%|~dp0)\\?([^"%\r\n]+)"\s+%\*/gi)].pop();
  if (!m) return null;
  const target = path.resolve(dir, m[1].replace(/[\\/]+/g, path.sep));
  if (!target.startsWith(dir + path.sep)) return null; // le lanceur ne doit viser que son propre dossier
  return { target, viaNode: SCRIPT_EXT.test(target) || /%_prog%/i.test(text) };
}

/**
 * @returns {{ command: string, prefix: string[], viaCmd: boolean } | { error: string }}
 */
function resolveLaunch(binPath, { envPath = process.env.PATH || '', platform = process.platform } = {}) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(binPath)) {
    if (platform === 'win32' && SCRIPT_EXT.test(binPath)) {
      const node = findOnPath('node.exe', envPath);
      return node ? { command: node, prefix: [binPath], viaCmd: false } : { error: 'node.exe introuvable dans le PATH' };
    }
    return { command: binPath, prefix: [], viaCmd: false };
  }
  let text;
  try {
    text = fs.readFileSync(binPath, 'utf8');
  } catch (e) {
    return { error: `lanceur illisible (${e.message})` };
  }
  const shim = parseNpmShim(text, binPath);
  if (shim) {
    try {
      if (!fs.statSync(shim.target).isFile()) throw new Error();
    } catch {
      return { error: `le lanceur ${path.basename(binPath)} vise un fichier absent (${shim.target})` };
    }
    if (!shim.viaNode) return { command: shim.target, prefix: [], viaCmd: false };
    const local = path.join(path.dirname(binPath), 'node.exe');
    const node = fs.existsSync(local) ? local : findOnPath('node.exe', envPath);
    if (!node) return { error: 'node.exe introuvable dans le PATH' };
    return { command: node, prefix: [shim.target], viaCmd: false };
  }
  // Autre lanceur : passage par cmd.exe, réservé aux arguments sans risque.
  if (/[%^"&|<>!]/.test(binPath)) return { error: `chemin du lanceur non pris en charge : ${binPath}` };
  return { command: binPath, prefix: [], viaCmd: true };
}

/**
 * Commande finale à passer à spawn().
 * @returns {{ command: string, args: string[], verbatim: boolean }}
 */
function buildCommand(launch, argv) {
  const args = [...launch.prefix, ...argv];
  if (!launch.viaCmd) return { command: launch.command, args, verbatim: false };
  const bad = args.find((a) => !CMD_SAFE_ARG.test(a));
  if (bad !== undefined) {
    throw new Error(
      `ce CLI passe par cmd.exe, qui interpréterait l'argument « ${bad.slice(0, 40)} ». ` +
        'Indiquez son exécutable (.exe) ou son script (.js) avec "bin" dans la configuration.'
    );
  }
  const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  return { command: comspec, args: ['/d', '/s', '/c', `""${launch.command}" ${args.join(' ')}"`], verbatim: true };
}

/**
 * PATH élargi : une session graphique n'a pas toujours le PATH du terminal, on
 * ajoute donc les emplacements habituels des CLI installés par l'utilisateur.
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
      p.join(home, '.local', 'bin'), // installateur natif de Claude Code
      p.join(local, 'cursor-agent'),
      p.join(home, '.bun', 'bin'),
      p.join(local, 'Volta', 'bin'),
      p.join(get('ProgramFiles') || 'C:\\Program Files', 'nodejs'),
    ];
  } else {
    extra = ['.local/bin', 'bin', '.npm-global/bin', '.bun/bin', '.volta/bin'].map((d) => p.join(home, d));
    extra.push('/usr/local/bin');
  }
  const parts = (get('PATH') || '').split(p.delimiter).filter((d) => d && p.isAbsolute(d));
  for (const d of extra) if (!parts.includes(d)) parts.push(d);
  return parts.join(p.delimiter);
}

module.exports = { resolveLaunch, buildCommand, parseNpmShim, findOnPath, extendedPath, WIN };
