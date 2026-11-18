'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveAgents, buildInvocation, isDangerousArg, BUILTIN } = require('../src/main/agents');
const sec = require('../src/main/security');
const { loadConfig } = require('../src/main/config');
const { runAgent, createStreamJsonParser, clean } = require('../src/main/runner');
const { ConversationStore, buildContextPrompt } = require('../src/main/conversations');
const { trayModel, createTray, ICONS, ICON_DIR } = require('../src/main/tray');

const FAKE = path.join(__dirname, 'fixtures', 'fake-agent.js');
const WIN = process.platform === 'win32';
const POSIX = !WIN;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aska-test-'));
// Environnement minimal pour le faux CLI (Windows a besoin de SystemRoot pour démarrer node).
const baseEnv = (extra = {}) => ({ ...sec.buildEnv(process.env), ...extra });
const run = (opts) => {
  const events = [];
  const { argv = [], env = {}, bin, ...rest } = opts;
  // Le faux CLI est lancé par node (un .js n'est pas exécutable tel quel sous Windows).
  const h = runAgent(
    { bin: bin || process.execPath, argv: bin ? argv : [FAKE, ...argv], cwd: os.tmpdir(), env: baseEnv(env), ...rest },
    (e) => events.push(e)
  );
  return { h, events };
};
// Nom de fichier exécutable : « outil » sous Linux, « outil.cmd » sous Windows.
const exe = (name) => (WIN ? `${name}.cmd` : name);
const textOf = (events) => events.filter((e) => e.type === 'text').map((e) => e.text).join('');

test('aucun mode intégré ne contourne les permissions du CLI', () => {
  for (const [id, a] of Object.entries(BUILTIN)) {
    for (const [mode, args] of Object.entries(a.modes)) {
      for (const arg of [...a.base, ...args]) {
        assert.ok(!/dangerously|bypassPermissions|danger-full-access|yolo/i.test(arg), `${id}/${mode}: ${arg}`);
      }
      if (mode !== 'auto') assert.ok(!args.includes('--force') && !args.includes('--allow-all-tools'), `${id}/${mode}`);
    }
  }
});

test('le prompt n\'est jamais interprété comme une option ni par un shell', () => {
  const { agents } = resolveAgents({});
  const evil = '--dangerously-skip-permissions; rm -rf ~ $(id) `id`';
  const c = buildInvocation(agents.claude, 'read', evil);
  assert.equal(c.stdin, evil);
  assert.ok(!c.argv.includes(evil));
  assert.deepEqual(c.argv.slice(-4), ['--permission-mode', 'plan', '--setting-sources', 'user']);
  const k = buildInvocation(agents.cursor, 'read', evil);
  assert.equal(k.argv.at(-1), ' ' + evil);
  assert.ok(!k.logArgv.join(' ').includes('rm -rf'));
  const p = buildInvocation(agents.copilot, 'edit', 'salut');
  assert.deepEqual(p.argv.slice(-2), ['-p', 'salut']);
  assert.deepEqual(buildInvocation(agents.codex, 'read', 'x').argv.at(-1), '-');
  assert.throws(() => buildInvocation(agents.cursor, 'edit', 'x'), /ne propose pas/);
  assert.throws(() => buildInvocation(agents.claude, 'read', '   '), /vide/);
});

test('extraArgs dangereux refusés, agents personnalisés acceptés', () => {
  const { agents, warnings } = resolveAgents({
    claude: { extraArgs: ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--max-turns', '5'], model: 'sonnet' },
    codex: { enabled: false },
    gemini: { label: 'Gemini', bin: '/usr/bin/gemini', prompt: 'arg', promptFlag: '-p', modes: { read: ['--approval-mode', 'default'] } },
    'Bad Id': { bin: '/x', modes: { read: [] } },
  });
  assert.deepEqual(agents.claude.extraArgs, ['--max-turns', '5']);
  assert.equal(warnings.filter((w) => /refusés/.test(w)).length, 1);
  assert.ok(!agents.codex);
  assert.ok(!agents['Bad Id']);
  assert.deepEqual(buildInvocation(agents.gemini, 'read', 'yo').argv, ['--approval-mode', 'default', '-p', 'yo']);
  assert.ok(buildInvocation(agents.claude, 'read', 'x').argv.includes('sonnet'));
  assert.ok(isDangerousArg('--yolo') && !isDangerousArg('--verbose'));
});

test('environnement filtré : les secrets étrangers à l\'agent ne passent pas', () => {
  const env = sec.buildEnv(
    { PATH: '/bin', HOME: '/h', AWS_SECRET_ACCESS_KEY: 's', GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', LC_ALL: 'fr', MY_VAR: '1' },
    ['ANTHROPIC_*'], ['MY_VAR']
  );
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'HOME', 'LC_ALL', 'MY_VAR', 'NO_COLOR', 'PATH', 'TERM']);
});

test('binaire : PATH relatif ignoré, fichier modifiable par tous refusé', () => {
  const d = tmp();
  const bin = path.join(d, exe('agentx'));
  fs.writeFileSync(bin, WIN ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(sec.resolveBinary(['agentx'], { envPath: d }).path, fs.realpathSync(bin));
  assert.ok(sec.resolveBinary(['agentx'], { envPath: ['.', 'relative'].join(path.delimiter) }).error);
  assert.match(sec.resolveBinary(['x'], { override: 'relative/x' }).error, /absolu/);
  if (WIN) return; // pas de droits POSIX sous Windows
  fs.chmodSync(bin, 0o777);
  assert.match(sec.resolveBinary(['agentx'], { envPath: d }).error, /modifiable par tous/);
  fs.chmodSync(bin, 0o755);
  fs.chmodSync(d, 0o777);
  assert.match(sec.resolveBinary(['agentx'], { envPath: d }).error, /modifiable par tous/);
});

test('binaire sous Windows : extensions essayées, script sans extension ignoré', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'outil'), '#!/bin/sh\n'); // script pour Git Bash posé par npm
  assert.ok(sec.resolveBinary(['outil'], { envPath: d, platform: 'win32' }).error);
  fs.writeFileSync(path.join(d, 'outil.cmd'), '@echo off\r\n', { mode: 0o755 });
  fs.writeFileSync(path.join(d, 'outil.exe'), 'MZ', { mode: 0o755 });
  assert.equal(path.basename(sec.resolveBinary(['outil'], { envPath: d, platform: 'win32' }).path), 'outil.exe');
});

test('dossier de travail : écriture refusée dans ~, / et les dossiers sensibles', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'proj'));
  fs.mkdirSync(path.join(home, '.ssh'));
  assert.ok(sec.checkWorkdir(home, 'read', home).path);
  assert.match(sec.checkWorkdir(home, 'edit', home).error, /dossier personnel/);
  assert.match(sec.checkWorkdir(path.parse(home).root, 'edit', home).error, /racine/);
  const systemDir = WIN ? process.env.SystemRoot || 'C:\\Windows' : '/etc';
  assert.match(sec.checkWorkdir(systemDir, 'auto', home).error, /système/);
  if (WIN) {
    fs.mkdirSync(path.join(home, 'AppData'));
    assert.match(sec.checkWorkdir(path.join(home, 'AppData'), 'edit', home).error, /sensible/);
    // Casse indifférente sous Windows.
    assert.match(sec.checkWorkdir(home.toUpperCase(), 'edit', home).error, /dossier personnel/);
  }
  assert.match(sec.checkWorkdir(path.join(home, '.ssh'), 'edit', home).error, /sensible/);
  assert.ok(sec.checkWorkdir(path.join(home, 'proj'), 'edit', home).path);
  assert.ok(sec.checkWorkdir(path.join(home, 'nope'), 'read', home).error);
});

test('configuration : ignorée si modifiable par d\'autres, bornée sinon', () => {
  const d = tmp();
  const f = path.join(d, 'config.json');
  fs.writeFileSync(f, JSON.stringify({ allowAutoMode: true, defaultMode: 'auto', timeoutSec: 999999, shortcut: 'Super+K' }), { mode: 0o600 });
  let r = loadConfig(f);
  assert.equal(r.config.allowAutoMode, true);
  assert.equal(r.config.defaultMode, 'edit');
  assert.equal(r.config.timeoutSec, 3600);
  assert.equal(r.config.shortcut, 'Super+K');
  if (POSIX) {
    fs.chmodSync(f, 0o666);
    r = loadConfig(f);
    assert.equal(r.config.allowAutoMode, false);
    assert.match(r.warnings[0], /ignorée/);
  }
  assert.equal(loadConfig(path.join(d, 'absent.json')).config.defaultMode, 'read');
  // BOM UTF-8 (Windows PowerShell 5.1, Bloc-notes) : la configuration reste lue.
  const bom = path.join(d, 'bom.json');
  fs.writeFileSync(bom, '\uFEFF' + JSON.stringify({ allowAutoMode: true }), { mode: 0o600 });
  r = loadConfig(bom);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.allowAutoMode, true);
});

test('Claude en lecture seule : les réglages du projet (hooks) ne sont pas chargés', () => {
  const { agents } = resolveAgents({ claude: { extraArgs: ['--setting-sources', 'project', '--setting-sources=project,user'] } });
  const argv = buildInvocation(agents.claude, 'read', 'x').argv;
  assert.equal(argv[argv.indexOf('--setting-sources') + 1], 'user');
  assert.equal(argv.filter((a) => /^--setting-sources/.test(a)).length, 1);
});

test('confiance et journal : fichiers privés (0600)', () => {
  const d = tmp();
  const t = new sec.TrustStore(path.join(d, 'c', 'trusted.json'));
  const ab = path.resolve('/a/b');
  assert.equal(t.isTrusted(ab), false);
  t.add(ab);
  const t2 = new sec.TrustStore(path.join(d, 'c', 'trusted.json'));
  assert.ok(t2.isTrusted(path.join(ab, 'c')) && !t2.isTrusted(path.resolve('/a/bc')));
  if (POSIX) assert.equal(fs.statSync(path.join(d, 'c', 'trusted.json')).mode & 0o777, 0o600);
  const log = path.join(d, 's', 'history.jsonl');
  sec.appendAudit(log, { prompt: 'un' });
  sec.appendAudit(log, { prompt: 'deux' });
  if (POSIX) assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  assert.deepEqual(sec.readRecentPrompts(log), ['un', 'deux']);
});

test('parseur stream-json : deltas, outils, refus, lignes non JSON', () => {
  const ev = [];
  const p = createStreamJsonParser((e) => ev.push(e));
  p.push('{"type":"system","subtype":"init","model":"m"}\n{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Bon"}}}\n{"type":"stream_ev');
  p.push('ent","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"jour"}}}\n');
  p.push('{"type":"assistant","message":{"content":[{"type":"text","text":"Bonjour"},{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}\n');
  p.push('{"type":"assistant","parent_tool_use_id":"x","message":{"content":[{"type":"text","text":"SOUS-AGENT"}]}}\n');
  p.push('pas du json\n{"type":"result","subtype":"success","result":"Bonjour","permission_denials":[{"tool_name":"Bash"}]}');
  p.end();
  assert.equal(textOf(ev), 'Bonjourpas du json\n');
  assert.deepEqual(ev.find((e) => e.type === 'activity'), { type: 'activity', text: 'Bash · ls -la' });
  assert.deepEqual(ev.find((e) => e.type === 'denied'), { type: 'denied', count: 1, tools: ['Bash'] });
  assert.equal(ev.find((e) => e.type === 'meta').model, 'm');

  const ev2 = [];
  const q = createStreamJsonParser((e) => ev2.push(e));
  q.push('{"type":"assistant","message":{"content":[{"type":"text","text":"A"}]}}\n{"type":"tool_call","subtype":"started","tool_call":{"readToolCall":{"args":{"path":"a.js"}}}}\n{"type":"assistant","message":{"content":[{"type":"text","text":"B"}]}}\n{"type":"result","is_error":true,"result":"quota"}\n');
  assert.equal(textOf(ev2), 'A\n\nB');
  assert.equal(ev2.find((e) => e.type === 'activity').text, 'read · a.js');
  assert.equal(ev2.find((e) => e.type === 'error').text, 'quota');
  assert.equal(clean('\x1b[31mrouge\x1b[0m\r\n\x07ok'), 'rouge\nok');
});

test('exécution : stdin, argv littéral, cwd et env transmis tels quels', async () => {
  process.env.SECRET_DE_TEST = 'ne-doit-pas-passer';
  const d = fs.realpathSync(tmp());
  const { h, events } = run({ argv: ['$(id)', '; ls'], stdin: 'salut "toi"', cwd: d, env: { FAKE_MODE: 'echo' } });
  const res = await h.done;
  assert.equal(res.ok, true);
  const got = JSON.parse(textOf(events));
  assert.deepEqual(got.args, ['$(id)', '; ls']);
  assert.equal(got.stdin, 'salut "toi"');
  assert.equal(WIN ? got.cwd.toLowerCase() : got.cwd, WIN ? d.toLowerCase() : d);
  assert.ok(!got.env.includes('SECRET_DE_TEST'));
});

test('exécution : flux stream-json de bout en bout', async () => {
  const { h, events } = run({ output: 'stream-json', stdin: 'deny', env: { FAKE_MODE: 'stream', FAKE_DELAY: '1' } });
  const res = await h.done;
  assert.equal(res.ok, true);
  assert.match(textOf(events), /^## Résumé[\s\S]*const ok = true;\n```\n$/);
  assert.equal(events.find((e) => e.type === 'denied').count, 2);
});

test('exécution : échec remonté avec stderr nettoyé', async () => {
  const { h } = run({ env: { FAKE_MODE: 'fail' } });
  const res = await h.done;
  assert.equal(res.ok, false);
  assert.equal(res.code, 3);
  assert.equal(res.stderrTail, 'auth error: not logged in');
});

test('exécution : délai dépassé → SIGKILL même si SIGTERM est ignoré', async () => {
  const { h } = run({ timeoutMs: 300, env: { FAKE_MODE: 'hang' } });
  const res = await h.done;
  assert.equal(res.reason, 'timeout');
  assert.equal(res.ok, false);
});

test('exécution : annulation et plafond de sortie', async () => {
  const a = run({ env: { FAKE_MODE: 'hang' } });
  setTimeout(() => a.h.cancel(), 200);
  assert.equal((await a.h.done).reason, 'cancel');
  const b = run({ maxBytes: 200000, env: { FAKE_MODE: 'flood' } });
  assert.equal((await b.h.done).reason, 'overflow');
});

test('exécution : binaire inexistant', async () => {
  const { h } = run({ bin: path.resolve('/nonexistent/agent') });
  const res = await h.done;
  assert.equal(res.reason, 'spawn-error');
});

test('modèle et reprise de session : validés avant d\'atteindre la ligne de commande', () => {
  const { agents } = resolveAgents({ codex: { models: ['gpt-x', '--bad', 'o3'] } });
  const inv = buildInvocation(agents.claude, 'read', 'x', { model: 'opus', resume: 'sess-0001-abcd' });
  assert.deepEqual(inv.argv.slice(-4), ['--model', 'opus', '--resume', 'sess-0001-abcd']);
  assert.ok(!buildInvocation(agents.claude, 'read', 'x', { model: null }).argv.includes('--model'));
  assert.throws(() => buildInvocation(agents.claude, 'read', 'x', { model: '--dangerously-skip-permissions' }), /modèle invalide/);
  assert.throws(() => buildInvocation(agents.claude, 'read', 'x', { resume: '--yolo' }), /session invalide/);
  assert.ok(!buildInvocation(agents.codex, 'read', 'x', { resume: 'sess-0001-abcd' }).argv.includes('sess-0001-abcd'));
  assert.deepEqual(agents.codex.models, ['gpt-x', 'o3']);
  assert.deepEqual(agents.claude.models, ['opus', 'sonnet', 'haiku']);
});

test('contexte réinjecté : tours précédents, budget respecté', () => {
  assert.equal(buildContextPrompt([], 'salut'), 'salut');
  const turns = [
    { agent: 'claude', label: 'Claude', prompt: 'Q1', answer: 'R1' },
    { agent: 'codex', label: 'Codex', prompt: 'Q2', answer: '' },
  ];
  const p = buildContextPrompt(turns, 'Q3');
  assert.match(p, /<historique>\n\[Utilisateur\]\nQ1\n\n\[Assistant — Claude\]\nR1\n\n\[Utilisateur\]\nQ2[\s\S]*interrompue[\s\S]*<\/historique>[\s\S]*Nouvelle demande de l'utilisateur :\nQ3$/);
  const big = Array.from({ length: 30 }, (_, i) => ({ agent: 'a', prompt: `Q${i}`, answer: 'x'.repeat(3000) }));
  const q = buildContextPrompt(big, 'fin', 10000);
  assert.ok(q.length < 11000 && q.includes('Q29') && !q.includes('Q0\n'));
});

test('conversations : enregistrement privé, liste, réouverture, suppression', () => {
  const d = path.join(tmp(), 'conv');
  const store = new ConversationStore(d, { max: 2 });
  const c = store.create('/proj');
  store.save(c);
  assert.deepEqual(store.list(), []); // rien tant qu'il n'y a pas de tour
  c.turns.push({ agent: 'claude', label: 'Claude', prompt: 'Explique  le\nmodule ' + 'x'.repeat(100), answer: 'ok', status: 'running' });
  store.save(c);
  if (POSIX) assert.equal(fs.statSync(path.join(d, c.id + '.json')).mode & 0o777, 0o600);
  const [item] = store.list();
  assert.equal(item.turns, 1);
  // Aperçu : texte de la dernière réponse, sans syntaxe Markdown ni tableau.
  const pv = store.create('/p');
  pv.turns.push({ agent: 'a', prompt: 'q', answer: '## Titre\n\nUn **texte** avec `code`.\n\n| A | B |\n| :-- | --: |\n| 1 | 2 |\n\n```js\nx()\n```\nFin.' });
  store.save(pv);
  assert.equal(store.list().find((c) => c.id === pv.id).preview, 'Titre Un texte avec code. Fin.');
  store.delete(pv.id);
  assert.ok(item.title.startsWith('Explique le module') && item.title.length <= 70);
  const back = store.load(c.id);
  assert.equal(back.turns[0].status, 'error');
  assert.equal(store.load('../../etc/passwd'), null);
  assert.throws(() => store.file('../x'), /invalide/);
  for (let i = 0; i < 3; i++) {
    const n = store.create('/p');
    n.turns.push({ agent: 'codex', prompt: 'p' + i, answer: '' });
    store.save(n);
  }
  assert.equal(store.list().length, 2); // purge des plus anciennes
  const id = store.list()[0].id;
  store.delete(id);
  assert.ok(!store.list().some((x) => x.id === id));
  const off = new ConversationStore(path.join(d, 'off'), { persist: false });
  const o = off.create('/p');
  o.turns.push({ agent: 'a', prompt: 'p', answer: '' });
  off.save(o);
  assert.deepEqual(off.list(), []);
});

test('Cursor : --trust ajouté seulement une fois la confiance établie, jamais via extraArgs', () => {
  const { agents, warnings } = resolveAgents({ cursor: { extraArgs: ['--trust'] } });
  assert.deepEqual(agents.cursor.extraArgs, []);
  assert.equal(warnings.length, 1);
  assert.ok(!buildInvocation(agents.cursor, 'read', 'x').argv.includes('--trust'));
  assert.deepEqual(buildInvocation(agents.cursor, 'read', 'x', { trusted: true }).argv, ['-p', '--output-format', 'stream-json', '--mode', 'ask', '--trust', 'x']);
  assert.ok(!buildInvocation(agents.claude, 'read', 'x', { trusted: true }).argv.includes('--trust'));
});

test('binaire : un lanceur factice (VS Code) ne passe qu\'en dernier recours', () => {
  const d = tmp();
  const shim = path.join(d, 'github.copilot-chat');
  const real = path.join(d, 'real');
  for (const dir of [shim, real]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, exe('copilot')), '#!/bin/sh\n', { mode: 0o755 });
  }
  const avoid = BUILTIN.copilot.avoidPath;
  const both = [shim, real].join(path.delimiter);
  assert.equal(sec.resolveBinary(['copilot'], { envPath: both, avoid }).path, fs.realpathSync(path.join(real, exe('copilot'))));
  assert.equal(sec.resolveBinary(['copilot'], { envPath: shim, avoid }).path, fs.realpathSync(path.join(shim, exe('copilot'))));
});

test('découverte des modèles : formats de chaque CLI, entrées invalides écartées', async () => {
  const { parseModelLines, parseHelpOption, parseCodexCache, discoverModels } = require('../src/main/models');
  assert.deepEqual(
    parseModelLines('Available models\n\nauto - Auto (current)\n\x1b[1mgpt-5.2-codex\x1b[0m - GPT-5.2 Codex\n--evil - Bad\nTip: use --model <id>\n'),
    [{ id: 'auto', label: 'Auto' }, { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' }]
  );
  const help = `Options:\n  --fallback-model <m>  (e.g. 'nope')\n  -m, --model <model>   Set the model (choices: "claude-sonnet-4.5",\n                        "gpt-5", "--bad")\n  --no-color            Disable 'color'\n`;
  assert.deepEqual(parseHelpOption(help).map((m) => m.id), ['claude-sonnet-4.5', 'gpt-5']);
  assert.deepEqual(parseHelpOption('rien ici'), []);
  assert.deepEqual(
    parseCodexCache({ models: [{ slug: 'gpt-5.2-codex', display_name: 'GPT-5.2 Codex', visibility: 'list' }, { slug: 'interne', visibility: 'hide' }, { slug: '-x' }, null] }),
    [{ id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' }]
  );
  const viaCli = await discoverModels('cursor', async (args) => ({ ok: true, text: args[0] === '--list-models' ? 'a-1 - Modèle A\n' : '' }));
  assert.deepEqual(viaCli, { models: [{ id: 'a-1', label: 'Modèle A' }], error: null });
  assert.match((await discoverModels('cursor', async () => ({ ok: false, text: 'not logged in' }))).error, /liste de modèles/);
  const home = tmp();
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'o-test' }] }), { mode: 0o600 });
  assert.deepEqual((await discoverModels('codex', null, { CODEX_HOME: home })).models, [{ id: 'o-test', label: null }]);
  assert.deepEqual((await discoverModels('codex', null, { CODEX_HOME: path.join(home, 'absent') })).models, []);
  assert.deepEqual(await discoverModels('inconnu', null), { models: [], error: null });
});

// ---------- Windows : lanceurs npm (.cmd) ----------

const { resolveLaunch, buildCommand, parseNpmShim } = require('../src/main/launch');

// Contenu exact d'un lanceur généré par npm (cmd-shim).
const npmShim = (target) => [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
  '',
].join('\r\n');

test('Windows : un lanceur npm est lancé via node.exe, sans cmd.exe', () => {
  const d = tmp();
  const pkg = path.join(d, 'node_modules', '@scope', 'outil');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'cli.js'), '');
  fs.writeFileSync(path.join(d, 'outil.cmd'), npmShim('node_modules\\@scope\\outil\\cli.js'));
  const nodeDir = tmp();
  fs.writeFileSync(path.join(nodeDir, 'node.exe'), 'MZ');
  const l = resolveLaunch(path.join(d, 'outil.cmd'), { envPath: nodeDir, platform: 'win32' });
  assert.equal(l.command, path.join(nodeDir, 'node.exe'));
  assert.deepEqual(l.prefix, [path.join(pkg, 'cli.js')]);
  assert.equal(l.viaCmd, false);
  // Le prompt reste un argument ordinaire : aucun interpréteur ne le voit.
  const c = buildCommand(l, ['-p', '%PATH% & calc ^ "x"']);
  assert.deepEqual(c, { command: l.command, args: [path.join(pkg, 'cli.js'), '-p', '%PATH% & calc ^ "x"'], verbatim: false });
  // node.exe posé à côté du lanceur : prioritaire.
  fs.writeFileSync(path.join(d, 'node.exe'), 'MZ');
  assert.equal(resolveLaunch(path.join(d, 'outil.cmd'), { envPath: nodeDir, platform: 'win32' }).command, path.join(d, 'node.exe'));
});

test('Windows : lanceur npm vers un binaire natif, cible absente, cible hors du dossier', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'node_modules', 'x', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(d, 'node_modules', 'x', 'bin', 'x.exe'), 'MZ');
  fs.writeFileSync(path.join(d, 'x.cmd'), '@ECHO off\r\n"%~dp0\\node_modules\\x\\bin\\x.exe"   %*\r\n');
  assert.deepEqual(resolveLaunch(path.join(d, 'x.cmd'), { platform: 'win32' }), {
    command: path.join(d, 'node_modules', 'x', 'bin', 'x.exe'), prefix: [], viaCmd: false,
  });
  fs.writeFileSync(path.join(d, 'absent.cmd'), npmShim('node_modules\\absent\\cli.js'));
  assert.match(resolveLaunch(path.join(d, 'absent.cmd'), { platform: 'win32' }).error, /fichier absent/);
  assert.equal(parseNpmShim('"%dp0%\\..\\..\\Windows\\evil.exe" %*', path.join(d, 'y.cmd')), null);
});

test('Windows : un autre .cmd passe par cmd.exe seulement avec des arguments sans risque', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'autre.cmd'), '@echo off\r\nC:\\outil\\outil.exe %*\r\n');
  const l = resolveLaunch(path.join(d, 'autre.cmd'), { platform: 'win32' });
  assert.equal(l.viaCmd, true);
  const ok = buildCommand(l, ['exec', '--sandbox', 'read-only', '--model', 'gpt-5.2', '-']);
  assert.equal(ok.verbatim, true);
  assert.deepEqual(ok.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(ok.args[3], `""${path.join(d, 'autre.cmd')}" exec --sandbox read-only --model gpt-5.2 -"`);
  for (const bad of ['salut & calc', '%USERPROFILE%', 'a"b', 'x|y', 'avec espace', 'a^b', '!x!']) {
    assert.throws(() => buildCommand(l, ['-p', bad]), /cmd\.exe/);
  }
  // Sous Linux, rien de tout cela : le binaire est lancé tel quel.
  assert.deepEqual(resolveLaunch('/usr/bin/outil', { platform: 'linux' }), { command: '/usr/bin/outil', prefix: [], viaCmd: false });
});

test('icône de la barre système : état, info-bulle et menu', () => {
  const idle = trayModel({ running: 0, visible: false });
  assert.equal(idle.icon, 'idle');
  assert.equal(idle.tooltip, 'Aska');
  const item = (m, id) => m.items.find((it) => it.id === id);
  assert.equal(item(idle, 'toggle').label, 'Afficher Aska');
  assert.equal(item(idle, 'new').enabled, true);
  assert.equal(item(idle, 'cancel').enabled, false);
  assert.equal(item(idle, 'quit').enabled, true);

  const busy = trayModel({ running: 1, agentLabels: ['Claude'], visible: true });
  assert.equal(busy.icon, 'running');
  assert.equal(busy.tooltip, 'Aska : Claude en cours…');
  assert.equal(item(busy, 'toggle').label, 'Masquer Aska');
  // Une nouvelle conversation s'ouvre dans un onglet : possible pendant une exécution.
  assert.equal(item(busy, 'new').enabled, true);
  assert.equal(item(busy, 'cancel').enabled, true);
  assert.equal(item(busy, 'cancel').label, 'Annuler l’exécution');

  // Plusieurs onglets au travail : décompte et agents sans doublon.
  const many = trayModel({ running: 3, agentLabels: ['Claude', 'Codex', 'Claude'], visible: false });
  assert.equal(many.tooltip, 'Aska : 3 demandes en cours (Claude, Codex)');
  assert.equal(item(many, 'cancel').label, 'Annuler les 3 exécutions');

  // Les icônes déclarées existent, en taille normale et haute densité.
  for (const f of Object.values(ICONS)) {
    assert.ok(fs.existsSync(path.join(ICON_DIR, f)), f);
    assert.ok(fs.existsSync(path.join(ICON_DIR, f.replace('.png', '@2x.png'))), f);
  }
});

test('icône de la barre système : menu relié aux actions, mis à jour seulement si besoin', () => {
  const log = [];
  class FakeTray {
    constructor(img) { this.img = img; this.handlers = {}; this.destroyed = false; log.push(['new', img]); }
    on(ev, fn) { this.handlers[ev] = fn; }
    setImage(img) { this.img = img; }
    setToolTip(t) { this.tip = t; }
    setContextMenu(m) { this.menu = m; log.push(['menu']); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  let tray;
  const electron = {
    Tray: class extends FakeTray { constructor(i) { super(i); tray = this; } },
    Menu: { buildFromTemplate: (t) => t },
    nativeImage: { createFromPath: (p) => path.basename(p) },
  };
  const called = [];
  const actions = Object.fromEntries(['toggle', 'new', 'cancel', 'quit'].map((k) => [k, () => called.push(k)]));
  const t = createTray(electron, actions);

  t.update({ running: 0, visible: false });
  assert.equal(tray.img, 'tray.png');
  assert.equal(tray.tip, 'Aska');
  const menus = () => log.filter((l) => l[0] === 'menu').length;
  assert.equal(menus(), 1);
  t.update({ running: 0, visible: false });
  assert.equal(menus(), 1, 'état inchangé : menu non reconstruit');

  t.update({ running: 1, agentLabels: ['Codex'], visible: false });
  assert.equal(tray.img, 'tray-running.png');
  assert.equal(tray.tip, 'Aska : Codex en cours…');
  assert.equal(menus(), 2);

  // Chaque entrée appelle son action ; le clic sur l'icône affiche ou masque.
  for (const it of tray.menu) if (it.click) it.click();
  tray.handlers.click();
  assert.deepEqual(called, ['toggle', 'new', 'cancel', 'quit', 'toggle']);

  t.destroy();
  t.destroy();
  assert.equal(tray.destroyed, true);
});

test('configuration : icône de la barre système activée par défaut, désactivable', () => {
  const d = tmp();
  const f = path.join(d, 'config.json');
  assert.equal(loadConfig(path.join(d, 'absent.json')).config.tray, true);
  fs.writeFileSync(f, JSON.stringify({ tray: false }), { mode: 0o600 });
  assert.equal(loadConfig(f).config.tray, false);
  fs.writeFileSync(f, JSON.stringify({ tray: 'non' }), { mode: 0o600 });
  assert.equal(loadConfig(f).config.tray, true);
});

test('aska --help : options, raccourcis, agents détectés et fichiers ; --version', () => {
  const { execFileSync } = require('child_process');
  const home = tmp();
  const bin = tmp();
  fs.writeFileSync(path.join(bin, exe('claude')), WIN ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
  const env = WIN
    ? { ...baseEnv(), USERPROFILE: home, APPDATA: path.join(home, 'R'), LOCALAPPDATA: path.join(home, 'L'), PATH: bin, NO_COLOR: '1' }
    : { ...baseEnv(), HOME: home, PATH: bin, NO_COLOR: '1' };
  for (const k of Object.keys(env)) if (/^XDG_/.test(k)) delete env[k];
  const cli = path.join(__dirname, '..', 'src', 'cli.js');
  const out = execFileSync(process.execPath, [cli, '--help'], { env, encoding: 'utf8' });
  for (const expected of ['Usage : aska [option]', '--toggle', '--hidden', '--reload', '--quit', 'Ctrl+Alt+Espace', 'Lecture seule', 'Fichiers']) {
    assert.ok(out.includes(expected), `« ${expected} » absent de l'aide`);
  }
  assert.match(out, new RegExp(`✓ Claude\\s+${fs.realpathSync(path.join(bin, exe('claude'))).replace(/[\\.]/g, '\\$&')}`));
  assert.match(out, /✗ Codex\s+introuvable dans le PATH\n\s+installer : npm i -g @openai\/codex/);
  assert.ok(!/\x1b\[/.test(out), 'pas de couleurs hors terminal');
  assert.match(execFileSync(process.execPath, [cli, '--version'], { env, encoding: 'utf8' }), /^aska \d+\.\d+\.\d+\n$/);
});

// ---------- notifications ----------

const { shouldNotify, notificationContent, createNotifier } = require('../src/main/notify');

test('notifications : seulement quand le chat est hors de vue, jamais pour une annulation', () => {
  const at = (o) => ({ visible: true, focused: true, mini: false, status: 'ok', ...o });
  assert.equal(shouldNotify('hidden', at({})), false);
  assert.equal(shouldNotify('hidden', at({ focused: false })), false);
  assert.equal(shouldNotify('hidden', at({ visible: false })), true);
  assert.equal(shouldNotify('hidden', at({ mini: true })), true);
  assert.equal(shouldNotify('hidden', at({ visible: false, status: 'error' })), true);
  assert.equal(shouldNotify('hidden', at({ visible: false, status: 'cancel' })), false);
  assert.equal(shouldNotify('unfocused', at({ focused: false })), true);
  assert.equal(shouldNotify('unfocused', at({})), false);
  assert.equal(shouldNotify('never', at({ visible: false })), false);
});

test('notifications : contenu lisible, sans Markdown, et masquable', () => {
  const ok = notificationContent({ agentLabel: 'Claude', status: 'ok', answer: '## Bilan\n\nTout est **vert**, voir `ci.yml`.', title: 'État de la CI' });
  assert.deepEqual(ok, { title: 'Claude a répondu', body: 'Bilan Tout est vert, voir ci.yml.' });
  const long = notificationContent({ agentLabel: 'Codex', status: 'ok', answer: 'x'.repeat(500) });
  assert.equal(long.body.length, 180);
  const hiddenContent = notificationContent({ agentLabel: 'Claude', status: 'ok', answer: 'secret', title: 'Mot de passe', preview: false });
  assert.deepEqual(hiddenContent, { title: 'Claude a répondu', body: '« Mot de passe »' });
  const err = notificationContent({ agentLabel: 'Copilot', status: 'error', notice: { kind: 'error', text: "Le CLI s'est terminé avec le code 3\n\nauth error" }, title: 't' });
  assert.deepEqual(err, { title: 'Copilot : échec', body: "Le CLI s'est terminé avec le code 3" });
  const denied = notificationContent({ agentLabel: 'Claude', status: 'ok', answer: 'Fait.', notice: { kind: 'warn', text: '2 action(s) refusée(s) par le mode' } });
  assert.equal(denied.body, '2 actions refusées · Fait.');
});

test('notifications : une par conversation, clic vers la bonne conversation, journal de test', () => {
  const shown = [];
  class FakeNotification {
    static isSupported() { return true; }
    constructor(o) { this.o = o; this.handlers = {}; this.closed = false; }
    on(ev, fn) { this.handlers[ev] = fn; }
    show() { shown.push(this); }
    close() { this.closed = true; if (this.handlers.close) this.handlers.close(); }
  }
  const clicked = [];
  const log = path.join(tmp(), 'n.jsonl');
  const notify = createNotifier({ Notification: FakeNotification, onClick: (id) => clicked.push(id), logFile: log, sound: false });
  notify({ conversationId: 'a', title: 'T1', body: 'B1' });
  notify({ conversationId: 'a', title: 'T2', body: 'B2' });
  notify({ conversationId: 'b', title: 'T3', body: 'B3' });
  assert.equal(shown.length, 3);
  assert.equal(shown[0].closed, true, 'la notification précédente de la même conversation est remplacée');
  assert.equal(shown[1].closed, false);
  assert.equal(shown[1].o.silent, true);
  shown[2].handlers.click();
  assert.deepEqual(clicked, ['b']);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).title), ['T1', 'T2', 'T3']);
  // Sans prise en charge système : rien n'est affiché, mais rien ne casse.
  FakeNotification.isSupported = () => false;
  assert.equal(notify({ conversationId: 'c', title: 'x', body: 'y' }), false);
});

test('configuration : masquage au clic extérieur et notifications', () => {
  const d = tmp();
  const f = path.join(d, 'config.json');
  let c = loadConfig(path.join(d, 'absent.json')).config;
  assert.equal(c.hideOnBlur, true);
  assert.equal(c.notify, 'hidden');
  fs.writeFileSync(f, JSON.stringify({ hideOnBlur: false, notify: 'unfocused', notifyPreview: false, notifySound: false }), { mode: 0o600 });
  c = loadConfig(f).config;
  assert.deepEqual([c.hideOnBlur, c.notify, c.notifyPreview, c.notifySound], [false, 'unfocused', false, false]);
  fs.writeFileSync(f, JSON.stringify({ notify: false }), { mode: 0o600 });
  assert.equal(loadConfig(f).config.notify, 'never');
  fs.writeFileSync(f, JSON.stringify({ notify: 'toujours' }), { mode: 0o600 });
  assert.equal(loadConfig(f).config.notify, 'hidden');
});

// ---------- instances ----------

const { buildId, runningInstance } = require('../src/main/build');

test('identifiant de code : stable, sensible au contenu, remplaçable pour les tests', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'a.js'), 'un');
  fs.writeFileSync(path.join(d, 'sub', 'b.js'), 'deux');
  const a = buildId(d, {});
  assert.equal(a, buildId(d, {}));
  assert.match(a, /^[0-9a-f]{12}$/);
  fs.writeFileSync(path.join(d, 'sub', 'b.js'), 'deux modifié');
  assert.notEqual(buildId(d, {}), a);
  assert.equal(buildId(d, { ASKA_BUILD_ID: 'test-1' }), 'test-1');
  assert.equal(buildId(path.join(d, 'absent'), {}).length, 12); // sources illisibles : jamais bloquant
});

test('instance active : lue depuis run.json, ignorée si son processus a disparu', () => {
  const d = tmp();
  const f = path.join(d, 'run.json');
  const read = sec.readOwnedJson;
  assert.equal(runningInstance(read, f), null);
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, build: 'abc' }), { mode: 0o600 });
  assert.deepEqual(runningInstance(read, f), { pid: process.pid, build: 'abc' });
  fs.writeFileSync(f, JSON.stringify({ pid: 2 ** 22 + 12345, build: 'abc' }), { mode: 0o600 });
  assert.equal(runningInstance(read, f), null);
  fs.writeFileSync(f, JSON.stringify({ pid: 'x' }), { mode: 0o600 });
  assert.equal(runningInstance(read, f), null);
});

test('aska --help : comportement du clic extérieur et état de l\'instance', () => {
  const { execFileSync } = require('child_process');
  const home = tmp();
  const env = WIN
    ? { ...baseEnv(), USERPROFILE: home, APPDATA: path.join(home, 'R'), LOCALAPPDATA: path.join(home, 'L'), NO_COLOR: '1' }
    : { ...baseEnv(), HOME: home, NO_COLOR: '1' };
  for (const k of Object.keys(env)) if (/^XDG_/.test(k)) delete env[k];
  const cli = path.join(__dirname, '..', 'src', 'cli.js');
  const help = () => execFileSync(process.execPath, [cli, '--help'], { env, encoding: 'utf8' });
  const P = require('../src/main/config').paths(env, home);
  let out = help();
  assert.match(out, /Clic extérieur\s+Masque le chat/);
  assert.match(out, /Instance\s+Aska n'est pas lancé/);
  assert.match(out, /--restart/);
  // Ancienne configuration avec hideOnBlur:false : le chat n'est pas masqué, et l'aide le dit.
  fs.mkdirSync(P.configDir, { recursive: true });
  fs.writeFileSync(P.config, JSON.stringify({ hideOnBlur: false }), { mode: 0o600 });
  assert.match(help(), /Clic extérieur\s+Ne masque pas le chat : il est épinglé/);
  // L'épingle choisie dans l'interface l'emporte sur la configuration.
  fs.mkdirSync(P.stateDir, { recursive: true });
  fs.writeFileSync(P.state, JSON.stringify({ pinned: false }), { mode: 0o600 });
  assert.match(help(), /Clic extérieur\s+Masque le chat/);
  // Une instance d'un autre code est signalée.
  fs.writeFileSync(P.run, JSON.stringify({ pid: process.pid, build: 'ancien' }), { mode: 0o600 });
  out = help();
  assert.match(out, /Une ancienne version tourne encore .* « aska --restart »/);
  fs.writeFileSync(P.run, JSON.stringify({ pid: process.pid, build: buildId() }), { mode: 0o600 });
  assert.match(help(), /Instance\s+En cours d'exécution/);
});

// ---------- onglets ----------

const { Tabs } = require('../src/main/tabs');

function tabsFixture() {
  const store = new ConversationStore(path.join(tmp(), 'conv'));
  const saved = (title, cwd = '/p') => {
    const c = store.create(cwd);
    c.turns.push({ agent: 'claude', label: 'Claude', prompt: title, answer: 'ok', status: 'ok' });
    store.save(c);
    return c.id;
  };
  return { store, saved, tabs: new Tabs(store, { max: 3 }) };
}

test('onglets : création, réutilisation de l\'onglet vide, limite', () => {
  const { tabs } = tabsFixture();
  tabs.restore([], null, '/p');
  assert.equal(tabs.list.length, 1);
  const first = tabs.active();
  // L'onglet actif est encore vide : « nouvel onglet » le réutilise.
  assert.equal(tabs.create('/p').tab, first);
  first.conv.turns.push({ agent: 'claude', prompt: 'q', answer: '' });
  const second = tabs.create('/p').tab;
  assert.notEqual(second, first);
  assert.equal(tabs.activeId, second.id);
  second.conv.turns.push({ agent: 'codex', prompt: 'q2', answer: '' });
  tabs.create('/q').tab.conv.turns.push({ agent: 'codex', prompt: 'q3', answer: '' });
  assert.match(tabs.create('/p').error, /3 onglets au plus/);
  assert.equal(tabs.cycle(1).id, first.id); // en boucle
  assert.equal(tabs.cycle(-1).id, tabs.list[2].id);
});

test('onglets : ouvrir une conversation enregistrée, sans doublon', () => {
  const { tabs, saved } = tabsFixture();
  const a = saved('Sujet A');
  const b = saved('Sujet B');
  tabs.restore([], null, '/p');
  const emptyId = tabs.activeId;
  // L'onglet vide est remplacé par la conversation ouverte.
  tabs.open(a);
  assert.deepEqual(tabs.list.map((t) => t.id), [a]);
  assert.ok(!tabs.get(emptyId));
  tabs.open(b);
  assert.deepEqual(tabs.list.map((t) => t.id), [a, b]);
  // Déjà ouverte : simplement activée.
  tabs.open(a);
  assert.equal(tabs.list.length, 2);
  assert.equal(tabs.activeId, a);
  assert.match(tabs.open('0123456789abcdef').error, /introuvable/);
});

test('onglets : fermer un onglet qui travaille demande confirmation et annule sa demande', () => {
  const { tabs, saved } = tabsFixture();
  const a = saved('A');
  const b = saved('B');
  tabs.restore([a, b], a, '/p');
  let cancelled = 0;
  tabs.get(a).run = { id: 1, handle: { cancel: () => { cancelled += 1; } } };
  assert.deepEqual(tabs.close(a), { needsConfirm: true });
  assert.equal(tabs.list.length, 2);
  assert.equal(cancelled, 0);
  assert.deepEqual(tabs.close(a, { force: true }), { ok: true });
  assert.equal(cancelled, 1);
  assert.equal(tabs.activeId, b, 'l\'onglet voisin devient actif');
  // Fermer le dernier onglet en rouvre un vide : il en reste toujours un.
  tabs.close(b);
  assert.equal(tabs.list.length, 1);
  assert.equal(tabs.active().conv.turns.length, 0);
  // Supprimer de l'historique une conversation qui travaille est refusé.
  tabs.open(a);
  tabs.get(a).run = { id: 2, handle: { cancel() {} } };
  assert.match(tabs.forget(a).error, /en cours/);
});

test('onglets : enregistrés puis rouverts, réponses non lues effacées à l\'activation', () => {
  const { store, tabs, saved } = tabsFixture();
  const a = saved('A');
  const b = saved('B');
  tabs.restore([a, b], b, '/p');
  tabs.create('/p'); // onglet vide : non enregistré
  assert.deepEqual(tabs.serialize(), { tabs: [a, b], activeTab: b });
  tabs.get(a).unread = true;
  tabs.activate(a);
  assert.equal(tabs.get(a).unread, false);
  // Rouverture : conversation supprimée ignorée, identifiants invalides ignorés.
  store.delete(b);
  const again = new Tabs(store);
  again.restore([a, b, 42, a], b, '/p');
  assert.deepEqual(again.list.map((t) => t.id), [a]);
  assert.equal(again.activeId, a);
});

// ---------- Copilot : commandes shell de lecture ----------

test('Copilot : liste fermée de commandes de lecture, jamais tout le shell ni une commande qui écrit', () => {
  const { agents } = resolveAgents({});
  for (const mode of ['read', 'edit']) {
    const argv = buildInvocation(agents.copilot, mode, 'x').argv;
    // « --deny-tool shell » l'emporterait sur toute autorisation : Copilot ne pourrait plus rien lire.
    assert.ok(!argv.some((a, i) => a === 'shell' && argv[i - 1] === '--deny-tool'), mode);
    assert.ok(!argv.includes('--allow-all-tools'), mode);
    const allowed = argv.filter((a, i) => argv[i - 1] === '--allow-tool' && a.startsWith('shell('));
    assert.ok(allowed.includes('shell(cat)') && allowed.includes('shell(git status)'), mode);
    for (const risky of ['find', 'sed', 'sort', 'rg', 'tree', 'rm', 'git push', 'git branch', 'git checkout', 'git reset']) {
      assert.ok(!allowed.includes(`shell(${risky})`), `${mode} : ${risky}`);
    }
    // Pas de commande « joker » du type git:* qui ouvrirait tout git.
    assert.ok(!allowed.some((a) => a.includes(':*') || a === 'shell'), mode);
  }
  const read = buildInvocation(agents.copilot, 'read', 'x').argv;
  assert.ok(read.includes('write') && read[read.indexOf('write') - 1] === '--deny-tool', 'lecture seule : écriture refusée');
  assert.ok(!read.includes('shell(git log)'), 'git log --output écrit un fichier : pas en lecture seule');
  assert.ok(buildInvocation(agents.copilot, 'edit', 'x').argv.includes('shell(git log)'));
});

// ---------- Ollama ----------

const { createOllamaParser } = require('../src/main/runner');
const { parseOllamaList } = require('../src/main/models');
const { nvmBins } = require('../src/main/launch');

test('Ollama : modèle en position, obligatoire, lecture seule uniquement', () => {
  const { agents } = resolveAgents({});
  const o = agents.ollama;
  assert.deepEqual(Object.keys(o.modes), ['read']);
  const inv = buildInvocation(o, 'read', 'Bonjour', { model: 'llama3.2:latest' });
  assert.deepEqual(inv.argv, ['run', 'llama3.2:latest']);
  assert.equal(inv.stdin, 'Bonjour');
  assert.throws(() => buildInvocation(o, 'read', 'x', { model: null }), /Choisissez d'abord un modèle Ollama/);
  assert.throws(() => buildInvocation(o, 'edit', 'x', { model: 'm' }), /ne propose pas/);
  assert.throws(() => buildInvocation(o, 'read', 'x', { model: '--insecure' }), /modèle invalide/);
});

test('Ollama : le bloc de réflexion devient une activité, la réponse reste du texte', () => {
  const run = (chunks) => {
    const ev = [];
    const p = createOllamaParser((e) => ev.push(e));
    for (const c of chunks) p.push(c);
    p.end();
    return { text: ev.filter((e) => e.type === 'text').map((e) => e.text).join(''), acts: ev.filter((e) => e.type === 'activity').map((e) => e.text) };
  };
  // Modèle qui réfléchit, bloc découpé n'importe où.
  let r = run(['Think', 'ing...\nJe dois comparer 9.9 et 9.11', '.\n...done thi', 'nking.\n\n9.9 est plus grand.\n']);
  assert.equal(r.text, '9.9 est plus grand.\n');
  assert.deepEqual(r.acts, ['Réflexion…']);
  // Modèle sans réflexion : tout est réponse, y compris un début qui ressemble.
  r = run(['Thin', 'k positive !']);
  assert.equal(r.text, 'Think positive !');
  assert.deepEqual(r.acts, []);
  r = run(['Bonjour ', 'le monde']);
  assert.equal(r.text, 'Bonjour le monde');
});

test('Ollama : liste des modèles installés', () => {
  const out = 'NAME                ID              SIZE      MODIFIED\nllama3.2:latest     a80c4f17acd5    2.0 GB    3 weeks ago\nqwen3:8b            500a1f067a9f    5.2 GB    2 days ago\n';
  assert.deepEqual(parseOllamaList(out), [
    { id: 'llama3.2:latest', label: 'llama3.2 · 2.0 GB' },
    { id: 'qwen3:8b', label: 'qwen3:8b · 5.2 GB' },
  ]);
  assert.deepEqual(parseOllamaList('Error: could not connect to ollama app, is it running?\n'), []);
  assert.deepEqual(parseOllamaList('NAME    ID    SIZE    MODIFIED\n'), []);
});

test('PATH élargi : versions de Node installées par nvm, la plus récente d\'abord', () => {
  const d = tmp();
  for (const v of ['v18.20.4', 'v22.22.0', 'v22.3.1', 'pas-une-version']) fs.mkdirSync(path.join(d, v, 'bin'), { recursive: true });
  assert.deepEqual(nvmBins(d).map((p) => path.basename(path.dirname(p))), ['v22.22.0', 'v22.3.1', 'v18.20.4']);
  assert.deepEqual(nvmBins(path.join(d, 'absent')), []);
});
