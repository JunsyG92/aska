'use strict';
// Sortie en ligne de commande d'Aska : « aska --help » et « aska --version ».
// Utilisable sans Electron (node src/cli.js --help), donc même quand l'app ne
// peut pas démarrer : c'est justement là qu'on en a besoin.

const fs = require('fs');
const os = require('os');
const path = require('path');
const pkg = require('../package.json');
const { paths, loadConfig } = require('./main/config');
const { resolveAgents } = require('./main/agents');
const { resolveBinary, readOwnedJson } = require('./main/security');
const { buildId, runningInstance } = require('./main/build');
const { resolveLaunch, extendedPath } = require('./main/launch');

const HELP_FLAGS = ['-h', '--help', '-?', '/?'];
const VERSION_FLAGS = ['-v', '-V', '--version'];
const wantsCliOutput = (argv) => argv.some((a) => HELP_FLAGS.includes(a) || VERSION_FLAGS.includes(a));

// Couleurs seulement dans un vrai terminal, et jamais si NO_COLOR est défini.
function styles(stream) {
  const on = stream.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  const w = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { bold: w('1'), dim: w('2'), green: w('32'), red: w('31') };
}

/** État de chaque agent : CLI trouvé (et où), ou pourquoi il ne l'est pas. */
function agentReport(cfg, env = process.env) {
  const { agents } = resolveAgents(cfg.agents);
  const envPath = extendedPath({ env });
  return Object.values(agents).map((a) => {
    const r = resolveBinary(a.bin, { override: a.binOverride, envPath, avoid: a.avoidPath });
    if (r.error) return { label: a.label, ok: false, detail: r.error, hint: a.install || null };
    const l = resolveLaunch(r.path, { envPath });
    if (l.error) return { label: a.label, ok: false, detail: l.error, hint: null };
    return { label: a.label, ok: true, detail: r.path, hint: null };
  });
}

/** Ubuntu 24.04+ : le bac à sable d'Electron est-il réglé ? (sinon Aska ne démarre pas) */
function sandboxProblem() {
  if (process.platform !== 'linux') return null;
  let restricted = '0';
  try {
    restricted = fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim();
  } catch { /* noyau sans cette restriction */ }
  if (restricted !== '1' || fs.existsSync('/etc/apparmor.d/aska')) return null;
  try {
    const st = fs.statSync(path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'chrome-sandbox'));
    if (st.uid === 0 && (st.mode & 0o4755) === 0o4755) return null;
  } catch { /* Electron absent : signalé au lancement */ }
  return "Ubuntu 24.04+ : le bac à sable d'Electron n'est pas réglé, Aska ne démarrera pas. Lancez : scripts/install.sh --sandbox-fix";
}

function instanceLine(s, instance) {
  if (!instance) return 'Aska n\'est pas lancé (aska, ou aska --hidden en arrière-plan)';
  if (instance.build && instance.build !== buildId()) {
    return s.red(`Une ancienne version tourne encore (pid ${instance.pid}) : lancez « aska --restart »`);
  }
  return `En cours d'exécution (pid ${instance.pid})`;
}

function helpText(stream = process.stdout, env = process.env) {
  const s = styles(stream);
  const P = paths(env, os.homedir());
  const { config: cfg, warnings } = loadConfig(P.config);
  const win = process.platform === 'win32';
  const shortcut = cfg.shortcut ? cfg.shortcut.replace(/Control/g, 'Ctrl').replace('Space', 'Espace') : 'aucun';
  // Épinglé : choix fait dans l'interface (état enregistré), sinon selon « hideOnBlur ».
  const st = readOwnedJson(P.state).data || {};
  const pinned = typeof st.pinned === 'boolean' ? st.pinned : !cfg.hideOnBlur;
  const instance = runningInstance(readOwnedJson, P.run);
  const row = (k, v) => `  ${s.bold(k.padEnd(20))} ${v}`;

  const lines = [
    `${s.bold('Aska')} ${pkg.version} — un raccourci, un champ, et vos agents IA en CLI.`,
    '',
    `${s.bold('Usage')} : aska [option]`,
    '',
    s.bold('Options'),
    row('--toggle', 'Affiche ou masque la fenêtre, et démarre Aska si besoin (par défaut)'),
    row('--hidden', 'Démarre en arrière-plan, sans afficher la fenêtre'),
    row('--reload', 'Relit la configuration (agents, raccourci, modèles…)'),
    row('--restart', 'Redémarre Aska (à lancer après une mise à jour)'),
    row('--quit', 'Quitte Aska (annule la demande en cours)'),
    row('-h, --help', 'Affiche cette aide'),
    row('-v, --version', 'Affiche la version'),
  ];

  lines.push(
    '',
    s.bold('Dans la fenêtre'),
    row(shortcut, 'Raccourci global : afficher / masquer'),
    row('Entrée', 'Envoyer  ·  Maj+Entrée : nouvelle ligne'),
    row('Tab  /  Maj+Tab', 'Agent suivant  /  mode de permission suivant'),
    row('Ctrl+Maj+M', 'Choisir le modèle'),
    row('Ctrl+N  /  Ctrl+H', 'Nouvelle conversation  /  historique'),
    row('Ctrl+O', 'Dossier de travail'),
    row('Ctrl+M', 'Réduire en pastille'),
    row('Ctrl+P', 'Épingler / désépingler (un chat épinglé ne se masque pas au clic extérieur)'),
    row('Ctrl+Maj+C', 'Copier la dernière réponse'),
    row('Échap', 'Annuler la demande en cours, sinon masquer'),
    '',
    s.bold('État'),
    row('Clic extérieur', pinned ? "Ne masque pas le chat : il est épinglé (Ctrl+P pour désépingler)" : 'Masque le chat (Ctrl+P pour l\'épingler)'),
    row('Instance', instanceLine(s, instance)),
    '',
    s.bold('Notifications'),
    row('Quand ?', {
      hidden: 'Quand une réponse arrive alors que le chat est masqué ou réduit',
      unfocused: 'Quand une réponse arrive et que vous travaillez dans une autre fenêtre',
      never: 'Désactivées ("notify" dans la configuration)',
    }[cfg.notify]),
    '',
    s.bold('Modes de permission'),
    row('Lecture seule', "L'agent lit et répond, sans rien modifier (par défaut)"),
    row('Édition', "Modifie les fichiers du dossier, après votre accord"),
    row('Autonome', cfg.allowAutoMode ? 'Modifie et lance des commandes (activé)' : 'Désactivé ("allowAutoMode": true pour l\'activer)'),
    '',
    s.bold('Agents'),
  );
  for (const a of agentReport(cfg, env)) {
    const mark = a.ok ? s.green('✓') : s.red('✗');
    lines.push(`  ${mark} ${s.bold(a.label.padEnd(9))} ${a.ok ? a.detail : s.dim(a.detail)}`);
    if (!a.ok && a.hint) lines.push(`    ${s.dim('installer : ' + (win && /\| ?bash/.test(a.hint) ? 'voir https://cursor.com/cli' : a.hint))}`);
  }
  lines.push(
    '',
    s.bold('Fichiers'),
    row('Configuration', P.config),
    row('Conversations', P.conversations),
    row('Journal', P.audit),
  );
  const sandbox = sandboxProblem();
  if (sandbox) warnings.push(sandbox);
  if (warnings.length) lines.push('', s.bold('Attention'), ...warnings.map((w) => `  ${s.red('!')} ${w}`));
  lines.push('', s.dim('Documentation complète : README.md'), '');
  return lines.join('\n');
}

function printCli(argv, stream = process.stdout) {
  if (argv.some((a) => HELP_FLAGS.includes(a))) stream.write(helpText(stream));
  else stream.write(`aska ${pkg.version}\n`);
}

module.exports = { wantsCliOutput, printCli, helpText, agentReport };

if (require.main === module) {
  const argv = process.argv.slice(2);
  printCli(argv.length ? argv : ['--help']);
}
