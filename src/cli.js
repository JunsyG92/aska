'use strict';
// Aska's command-line output: "aska --help" and "aska --version".
// Usable without Electron (node src/cli.js --help), so even when the app
// cannot start: which is exactly when it is needed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const pkg = require('../package.json');
const { paths, loadConfig } = require('./main/config');
const { resolveAgents, MODES } = require('./main/agents');
const { resolveBinary, readOwnedJson } = require('./main/security');
const { buildId, runningInstance } = require('./main/build');
const { resolveLaunch, extendedPath } = require('./main/launch');
const { keyLabels } = require('./main/keys');
const { loadBots } = require('./main/bots');
const { t, systemLanguages } = require('./i18n');

const HELP_FLAGS = ['-h', '--help', '-?', '/?'];
const VERSION_FLAGS = ['-v', '-V', '--version'];
const wantsCliOutput = (argv) => argv.some((a) => HELP_FLAGS.includes(a) || VERSION_FLAGS.includes(a));

// Colors only in a real terminal, and never if NO_COLOR is set.
function styles(stream) {
  const on = stream.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  const w = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { bold: w('1'), dim: w('2'), green: w('32'), red: w('31') };
}

/** Status of each agent: CLI found (and where), or why it is not. */
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

/** Ubuntu 24.04+: is Electron's sandbox set up? (otherwise Aska does not start) */
function sandboxProblem() {
  if (process.platform !== 'linux') return null;
  let restricted = '0';
  try {
    restricted = fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim();
  } catch { /* kernel without this restriction */ }
  if (restricted !== '1' || fs.existsSync('/etc/apparmor.d/aska')) return null;
  try {
    const st = fs.statSync(path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'chrome-sandbox'));
    if (st.uid === 0 && (st.mode & 0o4755) === 0o4755) return null;
  } catch { /* Electron missing: reported at launch */ }
  return t('cli.sandbox');
}

/**
 * The tasks not finished yet (Tasks view), most recent first, read without
 * changing anything: a task "running" while Aska is not is shown as stopped.
 * status: running | waiting (a wave to review) | ready | stopped.
 */
function openTasks(dir, running, max = 5) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^[a-f0-9]{12}\.json$/.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const task = readOwnedJson(path.join(dir, n)).data;
    if (!task || typeof task.goal !== 'string' || !Array.isArray(task.subtasks)) continue;
    const status = task.proposal ? 'waiting' : task.status === 'running' ? (running ? 'running' : 'stopped') : task.status;
    if (!['running', 'waiting', 'ready', 'stopped'].includes(status)) continue;
    out.push({
      status,
      goal: task.goal.replace(/\s+/g, ' ').slice(0, 60),
      done: task.subtasks.filter((s) => s.status === 'done').length,
      total: task.subtasks.length,
      root: String(task.root || ''),
      updatedAt: String(task.updatedAt || ''),
    });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, max);
}

function instanceLine(s, instance) {
  if (!instance) return t('cli.notRunning');
  if (instance.build && instance.build !== buildId()) return s.red(t('cli.staleInstance', { pid: instance.pid }));
  return t('cli.running', { pid: instance.pid });
}

function helpText(stream = process.stdout, env = process.env) {
  const s = styles(stream);
  const P = paths(env, os.homedir());
  // Also sets the help language ("language" in the config, else the system's).
  const { config: cfg, warnings } = loadConfig(P.config, { systemLangs: systemLanguages(env) });
  const win = process.platform === 'win32';
  const accel = (a) => (a ? a.replace(/Control/g, 'Ctrl').replace('Shift', t('keys.names.Shift')).replace('Space', t('cli.space')) : t('cli.none'));
  const shortcut = accel(cfg.shortcut);
  const selShortcut = accel(cfg.selectionShortcut);
  // Pinned: choice made in the UI (saved state), else from "hideOnBlur".
  const st = readOwnedJson(P.state).data || {};
  const pinned = typeof st.pinned === 'boolean' ? st.pinned : !cfg.hideOnBlur;
  const instance = runningInstance(readOwnedJson, P.run);
  const row = (k, v) => `  ${s.bold(k.padEnd(20))} ${v}`;
  const key = keyLabels(cfg.keybindings); // shortcuts as configured ("keybindings")

  const lines = [
    t('cli.header', { name: s.bold('Aska'), version: pkg.version }),
    '',
    t('cli.usage', { label: s.bold('Usage') }),
    '',
    s.bold(t('cli.options')),
    row('--toggle', t('cli.toggle')),
    row('--selection', t('cli.selection')),
    row('--hidden', t('cli.hidden')),
    row('--reload', t('cli.reload')),
    row('--restart', t('cli.restart')),
    row('--quit', t('cli.quit')),
    row('-h, --help', t('cli.help')),
    row('-v, --version', t('cli.version')),
  ];

  lines.push(
    '',
    s.bold(t('cli.inWindow')),
    row(shortcut, t('cli.globalShortcut')),
    row(selShortcut, t('cli.selectionShortcut')),
    row(t('cli.keys.enter'), t('cli.send')),
    row(t('cli.keys.tab'), t('cli.nextAgentMode')),
    row(t('cli.keys.model'), t('cli.pickModel')),
    row(`${key.newTab}  /  ${key.closeTab}`, t('cli.tabs')),
    row(`${key.nextTab}, Ctrl+1…9`, t('cli.switchTab')),
    row(key.history, t('cli.history')),
    row(key.pickDir, t('cli.workingFolder')),
    row(key.toggleMini, t('cli.collapse')),
    row(key.togglePin, t('cli.pin')),
    row(t('cli.keys.copy'), t('cli.copyLast')),
    row(key.rerun, t('cli.rerun')),
    row(key.tasks, t('cli.tasks')),
    row(key.settings, t('cli.settings')),
    row('/', t('cli.slash')),
    row(t('cli.keys.esc'), t('cli.escape')),
  );
  // "/" commands of the config, with what they send.
  const own = Object.values(cfg.commands || {});
  if (own.length) {
    lines.push('', s.bold(t('cli.userCommands')));
    for (const c of own) {
      const what = c.description || c.prompt.trim().split('\n')[0].slice(0, 60);
      const extra = [c.agent, c.mode && MODES[c.mode].label, c.model].filter(Boolean).join(' · ');
      lines.push(row('/' + c.name, extra ? `${what}  ${s.dim(extra)}` : what));
    }
  }
  lines.push(
    '',
    s.bold(t('cli.status')),
    row(t('cli.outsideClick'), t(pinned ? 'cli.outsideClickPinned' : 'cli.outsideClickHides')),
    row(t('cli.instance'), instanceLine(s, instance)),
    '',
    s.bold(t('cli.notifications')),
    row(t('cli.when'), t(`cli.notify.${cfg.notify}`)),
    '',
    s.bold(t('cli.permissionModes')),
    row(MODES.read.label, t('cli.modeRead')),
    row(MODES.edit.label, t('cli.modeEdit')),
    row(MODES.auto.label, t(cfg.allowAutoMode ? 'cli.modeAutoOn' : 'cli.modeAutoOff')),
    '',
    s.bold(t('cli.agents')),
  );
  for (const a of agentReport(cfg, env)) {
    const mark = a.ok ? s.green('✓') : s.red('✗');
    lines.push(`  ${mark} ${s.bold(a.label.padEnd(9))} ${a.ok ? a.detail : s.dim(a.detail)}`);
    if (!a.ok && a.hint) lines.push(`    ${s.dim(t('cli.install', { hint: win && /\| ?bash/.test(a.hint) ? t('cli.seeCursor') : a.hint }))}`);
  }
  // Bots (~/.aska/bots), checked as at startup: their problems join the warnings.
  const b = loadBots(P.bots, { agents: resolveAgents(cfg.agents).agents, allowAutoMode: cfg.allowAutoMode });
  warnings.push(...b.warnings);
  const bots = Object.values(b.bots);
  if (bots.length) {
    lines.push('', s.bold(t('cli.bots')));
    for (const x of bots) lines.push(row('@' + x.id, `${x.label}  ${s.dim([x.agent, MODES[x.mode].label, x.model].filter(Boolean).join(' · '))}`));
  }
  // Tasks not finished yet (read only: the files stay as they are).
  const open = openTasks(P.tasks, !!instance);
  if (open.length) {
    lines.push('', s.bold(t('cli.openTasks.title')));
    for (const x of open) {
      const facts = t('cli.openTasks.facts', { done: x.done, total: x.total, root: x.root.replace(os.homedir(), '~') });
      lines.push(`  ${s.bold(t(`cli.openTasks.status.${x.status}`).padEnd(14))} ${x.goal}  ${s.dim(facts)}`);
    }
  }
  lines.push(
    '',
    s.bold(t('cli.files')),
    row(t('cli.config'), P.config),
    row(t('cli.botsFolder'), P.bots),
    row(t('cli.tasksFolder'), P.tasks),
    row(t('cli.conversations'), P.conversations),
    row(t('cli.audit'), P.audit),
  );
  const sandbox = sandboxProblem();
  if (sandbox) warnings.push(sandbox);
  if (warnings.length) lines.push('', s.bold(t('cli.warning')), ...warnings.map((w) => `  ${s.red('!')} ${w}`));
  lines.push('', s.dim(t('cli.docs')), '');
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
