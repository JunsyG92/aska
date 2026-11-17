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

const i18n = require('../src/i18n');

// Assertions below are written against the English texts.
i18n.setLanguage('en');

const FAKE = path.join(__dirname, 'fixtures', 'fake-agent.js');
const WIN = process.platform === 'win32';
const POSIX = !WIN;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aska-test-'));
// Minimal environment for the fake CLI (Windows needs SystemRoot to start node).
const baseEnv = (extra = {}) => ({ ...sec.buildEnv(process.env), ...extra });
const run = (opts) => {
  const events = [];
  const { argv = [], env = {}, bin, ...rest } = opts;
  // The fake CLI is run by node (a .js is not executable as is on Windows).
  const h = runAgent(
    { bin: bin || process.execPath, argv: bin ? argv : [FAKE, ...argv], cwd: os.tmpdir(), env: baseEnv(env), ...rest },
    (e) => events.push(e)
  );
  return { h, events };
};
// Executable file name: "tool" on Linux, "tool.cmd" on Windows.
const exe = (name) => (WIN ? `${name}.cmd` : name);
const textOf = (events) => events.filter((e) => e.type === 'text').map((e) => e.text).join('');

test('no built-in mode bypasses the CLI permissions', () => {
  for (const [id, a] of Object.entries(BUILTIN)) {
    for (const [mode, args] of Object.entries(a.modes)) {
      for (const arg of [...a.base, ...args]) {
        assert.ok(!/dangerously|bypassPermissions|danger-full-access|yolo/i.test(arg), `${id}/${mode}: ${arg}`);
      }
      if (mode !== 'auto') assert.ok(!args.includes('--force') && !args.includes('--allow-all-tools'), `${id}/${mode}`);
    }
  }
});

test('the prompt is never interpreted as an option or by a shell', () => {
  const { agents } = resolveAgents({});
  const evil = '--dangerously-skip-permissions; rm -rf ~ $(id) `id`';
  const c = buildInvocation(agents.claude, 'read', evil);
  assert.equal(c.stdin, evil);
  assert.ok(!c.argv.includes(evil));
  assert.deepEqual(c.argv.slice(-4), ['--permission-mode', 'plan', '--setting-sources', 'user']);
  const k = buildInvocation(agents.cursor, 'read', evil);
  assert.equal(k.argv.at(-1), ' ' + evil);
  assert.ok(!k.logArgv.join(' ').includes('rm -rf'));
  const p = buildInvocation(agents.copilot, 'edit', 'hello');
  assert.deepEqual(p.argv.slice(-2), ['-p', 'hello']);
  assert.deepEqual(buildInvocation(agents.codex, 'read', 'x').argv.at(-1), '-');
  assert.throws(() => buildInvocation(agents.cursor, 'edit', 'x'), /does not offer/);
  assert.throws(() => buildInvocation(agents.claude, 'read', '   '), /Empty/);
});

test('dangerous extraArgs rejected, custom agents accepted', () => {
  const { agents, warnings } = resolveAgents({
    claude: { extraArgs: ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--max-turns', '5'], model: 'sonnet' },
    codex: { enabled: false },
    gemini: { label: 'Gemini', bin: '/usr/bin/gemini', prompt: 'arg', promptFlag: '-p', modes: { read: ['--approval-mode', 'default'] } },
    'Bad Id': { bin: '/x', modes: { read: [] } },
  });
  assert.deepEqual(agents.claude.extraArgs, ['--max-turns', '5']);
  assert.equal(warnings.filter((w) => /rejected/.test(w)).length, 1);
  assert.ok(!agents.codex);
  assert.ok(!agents['Bad Id']);
  assert.deepEqual(buildInvocation(agents.gemini, 'read', 'yo').argv, ['--approval-mode', 'default', '-p', 'yo']);
  assert.ok(buildInvocation(agents.claude, 'read', 'x').argv.includes('sonnet'));
  assert.ok(isDangerousArg('--yolo') && !isDangerousArg('--verbose'));
});

test('filtered environment: secrets unrelated to the agent do not get through', () => {
  const env = sec.buildEnv(
    { PATH: '/bin', HOME: '/h', AWS_SECRET_ACCESS_KEY: 's', GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', LC_ALL: 'fr', MY_VAR: '1' },
    ['ANTHROPIC_*'], ['MY_VAR']
  );
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'HOME', 'LC_ALL', 'MY_VAR', 'NO_COLOR', 'PATH', 'TERM']);
});

test('binary: relative PATH ignored, world-writable file rejected', () => {
  const d = tmp();
  const bin = path.join(d, exe('agentx'));
  fs.writeFileSync(bin, WIN ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(sec.resolveBinary(['agentx'], { envPath: d }).path, fs.realpathSync(bin));
  assert.ok(sec.resolveBinary(['agentx'], { envPath: ['.', 'relative'].join(path.delimiter) }).error);
  assert.match(sec.resolveBinary(['x'], { override: 'relative/x' }).error, /absolute/);
  if (WIN) return; // no POSIX permissions on Windows
  fs.chmodSync(bin, 0o777);
  assert.match(sec.resolveBinary(['agentx'], { envPath: d }).error, /writable by all/);
  fs.chmodSync(bin, 0o755);
  fs.chmodSync(d, 0o777);
  assert.match(sec.resolveBinary(['agentx'], { envPath: d }).error, /writable by all/);
});

test('binary on Windows: extensions tried, script without extension ignored', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'tool'), '#!/bin/sh\n'); // Git Bash script placed by npm
  assert.ok(sec.resolveBinary(['tool'], { envPath: d, platform: 'win32' }).error);
  fs.writeFileSync(path.join(d, 'tool.cmd'), '@echo off\r\n', { mode: 0o755 });
  fs.writeFileSync(path.join(d, 'tool.exe'), 'MZ', { mode: 0o755 });
  assert.equal(path.basename(sec.resolveBinary(['tool'], { envPath: d, platform: 'win32' }).path), 'tool.exe');
});

test('working folder: writing refused in ~, / and sensitive folders', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'proj'));
  fs.mkdirSync(path.join(home, '.ssh'));
  assert.ok(sec.checkWorkdir(home, 'read', home).path);
  assert.match(sec.checkWorkdir(home, 'edit', home).error, /home folder/);
  assert.match(sec.checkWorkdir(path.parse(home).root, 'edit', home).error, /root/);
  const systemDir = WIN ? process.env.SystemRoot || 'C:\\Windows' : '/etc';
  assert.match(sec.checkWorkdir(systemDir, 'auto', home).error, /system/);
  if (WIN) {
    fs.mkdirSync(path.join(home, 'AppData'));
    assert.match(sec.checkWorkdir(path.join(home, 'AppData'), 'edit', home).error, /sensitive/);
    // Case-insensitive on Windows.
    assert.match(sec.checkWorkdir(home.toUpperCase(), 'edit', home).error, /home folder/);
  }
  assert.match(sec.checkWorkdir(path.join(home, '.ssh'), 'edit', home).error, /sensitive/);
  assert.ok(sec.checkWorkdir(path.join(home, 'proj'), 'edit', home).path);
  assert.ok(sec.checkWorkdir(path.join(home, 'nope'), 'read', home).error);
});

test('config: ignored if writable by others, clamped otherwise', () => {
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
    assert.match(r.warnings[0], /ignored/);
  }
  assert.equal(loadConfig(path.join(d, 'absent.json')).config.defaultMode, 'read');
  // UTF-8 BOM (Windows PowerShell 5.1, Notepad): the config is still read.
  const bom = path.join(d, 'bom.json');
  fs.writeFileSync(bom, '\uFEFF' + JSON.stringify({ allowAutoMode: true }), { mode: 0o600 });
  r = loadConfig(bom);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.allowAutoMode, true);
});

test('Claude in read-only mode: project settings (hooks) are not loaded', () => {
  const { agents } = resolveAgents({ claude: { extraArgs: ['--setting-sources', 'project', '--setting-sources=project,user'] } });
  const argv = buildInvocation(agents.claude, 'read', 'x').argv;
  assert.equal(argv[argv.indexOf('--setting-sources') + 1], 'user');
  assert.equal(argv.filter((a) => /^--setting-sources/.test(a)).length, 1);
});

test('trust and audit log: private files (0600)', () => {
  const d = tmp();
  const t = new sec.TrustStore(path.join(d, 'c', 'trusted.json'));
  const ab = path.resolve('/a/b');
  assert.equal(t.isTrusted(ab), false);
  t.add(ab);
  const t2 = new sec.TrustStore(path.join(d, 'c', 'trusted.json'));
  assert.ok(t2.isTrusted(path.join(ab, 'c')) && !t2.isTrusted(path.resolve('/a/bc')));
  if (POSIX) assert.equal(fs.statSync(path.join(d, 'c', 'trusted.json')).mode & 0o777, 0o600);
  const log = path.join(d, 's', 'history.jsonl');
  sec.appendAudit(log, { prompt: 'one' });
  sec.appendAudit(log, { prompt: 'two' });
  if (POSIX) assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  assert.deepEqual(sec.readRecentPrompts(log), ['one', 'two']);
});

test('stream-json parser: deltas, tools, denials, non-JSON lines', () => {
  const ev = [];
  const p = createStreamJsonParser((e) => ev.push(e));
  p.push('{"type":"system","subtype":"init","model":"m"}\n{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}\n{"type":"stream_ev');
  p.push('ent","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}\n');
  p.push('{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"},{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}\n');
  p.push('{"type":"assistant","parent_tool_use_id":"x","message":{"content":[{"type":"text","text":"SUBAGENT"}]}}\n');
  p.push('not json\n{"type":"result","subtype":"success","result":"Hello","permission_denials":[{"tool_name":"Bash"}]}');
  p.end();
  assert.equal(textOf(ev), 'Hellonot json\n');
  assert.deepEqual(ev.find((e) => e.type === 'activity'), { type: 'activity', text: 'Bash · ls -la' });
  assert.deepEqual(ev.find((e) => e.type === 'denied'), { type: 'denied', count: 1, tools: ['Bash'] });
  assert.equal(ev.find((e) => e.type === 'meta').model, 'm');

  const ev2 = [];
  const q = createStreamJsonParser((e) => ev2.push(e));
  q.push('{"type":"assistant","message":{"content":[{"type":"text","text":"A"}]}}\n{"type":"tool_call","subtype":"started","tool_call":{"readToolCall":{"args":{"path":"a.js"}}}}\n{"type":"assistant","message":{"content":[{"type":"text","text":"B"}]}}\n{"type":"result","is_error":true,"result":"quota"}\n');
  assert.equal(textOf(ev2), 'A\n\nB');
  assert.equal(ev2.find((e) => e.type === 'activity').text, 'read · a.js');
  assert.equal(ev2.find((e) => e.type === 'error').text, 'quota');
  assert.equal(clean('\x1b[31mred\x1b[0m\r\n\x07ok'), 'red\nok');
});

test('run: stdin, literal argv, cwd and env passed as is', async () => {
  process.env.SECRET_FOR_TEST = 'must-not-get-through';
  const d = fs.realpathSync(tmp());
  const { h, events } = run({ argv: ['$(id)', '; ls'], stdin: 'hello "you"', cwd: d, env: { FAKE_MODE: 'echo' } });
  const res = await h.done;
  assert.equal(res.ok, true);
  const got = JSON.parse(textOf(events));
  assert.deepEqual(got.args, ['$(id)', '; ls']);
  assert.equal(got.stdin, 'hello "you"');
  assert.equal(WIN ? got.cwd.toLowerCase() : got.cwd, WIN ? d.toLowerCase() : d);
  assert.ok(!got.env.includes('SECRET_FOR_TEST'));
});

test('run: end-to-end stream-json flow', async () => {
  const { h, events } = run({ output: 'stream-json', stdin: 'deny', env: { FAKE_MODE: 'stream', FAKE_DELAY: '1' } });
  const res = await h.done;
  assert.equal(res.ok, true);
  assert.match(textOf(events), /^## Summary[\s\S]*const ok = true;\n```\n$/);
  assert.equal(events.find((e) => e.type === 'denied').count, 2);
});

test('run: failure reported with cleaned stderr', async () => {
  const { h } = run({ env: { FAKE_MODE: 'fail' } });
  const res = await h.done;
  assert.equal(res.ok, false);
  assert.equal(res.code, 3);
  assert.equal(res.stderrTail, 'auth error: not logged in');
});

test('run: timeout → SIGKILL even if SIGTERM is ignored', async () => {
  const { h } = run({ timeoutMs: 300, env: { FAKE_MODE: 'hang' } });
  const res = await h.done;
  assert.equal(res.reason, 'timeout');
  assert.equal(res.ok, false);
});

test('run: cancellation and output cap', async () => {
  const a = run({ env: { FAKE_MODE: 'hang' } });
  setTimeout(() => a.h.cancel(), 200);
  assert.equal((await a.h.done).reason, 'cancel');
  const b = run({ maxBytes: 200000, env: { FAKE_MODE: 'flood' } });
  assert.equal((await b.h.done).reason, 'overflow');
});

test('run: missing binary', async () => {
  const { h } = run({ bin: path.resolve('/nonexistent/agent') });
  const res = await h.done;
  assert.equal(res.reason, 'spawn-error');
});

test('model and session resume: validated before reaching the command line', () => {
  const { agents } = resolveAgents({ codex: { models: ['gpt-x', '--bad', 'o3'] } });
  const inv = buildInvocation(agents.claude, 'read', 'x', { model: 'opus', resume: 'sess-0001-abcd' });
  assert.deepEqual(inv.argv.slice(-4), ['--model', 'opus', '--resume', 'sess-0001-abcd']);
  assert.ok(!buildInvocation(agents.claude, 'read', 'x', { model: null }).argv.includes('--model'));
  assert.throws(() => buildInvocation(agents.claude, 'read', 'x', { model: '--dangerously-skip-permissions' }), /Invalid model/);
  assert.throws(() => buildInvocation(agents.claude, 'read', 'x', { resume: '--yolo' }), /Invalid session/);
  assert.ok(!buildInvocation(agents.codex, 'read', 'x', { resume: 'sess-0001-abcd' }).argv.includes('sess-0001-abcd'));
  assert.deepEqual(agents.codex.models, ['gpt-x', 'o3']);
  assert.deepEqual(agents.claude.models, ['opus', 'sonnet', 'haiku']);
});

test('context fed back in: previous turns, budget respected', () => {
  assert.equal(buildContextPrompt([], 'hello'), 'hello');
  const turns = [
    { agent: 'claude', label: 'Claude', prompt: 'Q1', answer: 'R1' },
    { agent: 'codex', label: 'Codex', prompt: 'Q2', answer: '' },
  ];
  const p = buildContextPrompt(turns, 'Q3');
  assert.match(p, /<history>\n\[User\]\nQ1\n\n\[Assistant: Claude\]\nR1\n\n\[User\]\nQ2[\s\S]*interrupted[\s\S]*<\/history>[\s\S]*New request from the user:\nQ3$/);
  const big = Array.from({ length: 30 }, (_, i) => ({ agent: 'a', prompt: `Q${i}`, answer: 'x'.repeat(3000) }));
  const q = buildContextPrompt(big, 'end', 10000);
  assert.ok(q.length < 11000 && q.includes('Q29') && !q.includes('Q0\n'));
});

test('conversations: private storage, list, reopen, delete', () => {
  const d = path.join(tmp(), 'conv');
  const store = new ConversationStore(d, { max: 2 });
  const c = store.create('/proj');
  store.save(c);
  assert.deepEqual(store.list(), []); // nothing until there is a turn
  c.turns.push({ agent: 'claude', label: 'Claude', prompt: 'Explain  the\nmodule ' + 'x'.repeat(100), answer: 'ok', status: 'running' });
  store.save(c);
  if (POSIX) assert.equal(fs.statSync(path.join(d, c.id + '.json')).mode & 0o777, 0o600);
  const [item] = store.list();
  assert.equal(item.turns, 1);
  // Preview: text of the last answer, without Markdown syntax or tables.
  const pv = store.create('/p');
  pv.turns.push({ agent: 'a', prompt: 'q', answer: '## Title\n\nA **text** with `code`.\n\n| A | B |\n| :-- | --: |\n| 1 | 2 |\n\n```js\nx()\n```\nEnd.' });
  store.save(pv);
  assert.equal(store.list().find((c) => c.id === pv.id).preview, 'Title A text with code. End.');
  store.delete(pv.id);
  assert.ok(item.title.startsWith('Explain the module') && item.title.length <= 70);
  const back = store.load(c.id);
  assert.equal(back.turns[0].status, 'error');
  assert.equal(store.load('../../etc/passwd'), null);
  assert.throws(() => store.file('../x'), /Invalid/);
  for (let i = 0; i < 3; i++) {
    const n = store.create('/p');
    n.turns.push({ agent: 'codex', prompt: 'p' + i, answer: '' });
    store.save(n);
  }
  assert.equal(store.list().length, 2); // oldest ones pruned
  const id = store.list()[0].id;
  store.delete(id);
  assert.ok(!store.list().some((x) => x.id === id));
  const off = new ConversationStore(path.join(d, 'off'), { persist: false });
  const o = off.create('/p');
  o.turns.push({ agent: 'a', prompt: 'p', answer: '' });
  off.save(o);
  assert.deepEqual(off.list(), []);
});

test('Cursor: --trust added only once trust is established, never via extraArgs', () => {
  const { agents, warnings } = resolveAgents({ cursor: { extraArgs: ['--trust'] } });
  assert.deepEqual(agents.cursor.extraArgs, []);
  assert.equal(warnings.length, 1);
  assert.ok(!buildInvocation(agents.cursor, 'read', 'x').argv.includes('--trust'));
  assert.deepEqual(buildInvocation(agents.cursor, 'read', 'x', { trusted: true }).argv, ['-p', '--output-format', 'stream-json', '--mode', 'ask', '--trust', 'x']);
  assert.ok(!buildInvocation(agents.claude, 'read', 'x', { trusted: true }).argv.includes('--trust'));
});

test('binary: a fake launcher (VS Code) is only used as a last resort', () => {
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

test('model discovery: each CLI format, invalid entries dropped', async () => {
  const { parseModelLines, parseHelpOption, parseCodexCache, discoverModels } = require('../src/main/models');
  assert.deepEqual(
    parseModelLines('Available models\n\nauto - Auto (current)\n\x1b[1mgpt-5.2-codex\x1b[0m - GPT-5.2 Codex\n--evil - Bad\nTip: use --model <id>\n'),
    [{ id: 'auto', label: 'Auto' }, { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' }]
  );
  const help = `Options:\n  --fallback-model <m>  (e.g. 'nope')\n  -m, --model <model>   Set the model (choices: "claude-sonnet-4.5",\n                        "gpt-5", "--bad")\n  --no-color            Disable 'color'\n`;
  assert.deepEqual(parseHelpOption(help).map((m) => m.id), ['claude-sonnet-4.5', 'gpt-5']);
  assert.deepEqual(parseHelpOption('nothing here'), []);
  assert.deepEqual(
    parseCodexCache({ models: [{ slug: 'gpt-5.2-codex', display_name: 'GPT-5.2 Codex', visibility: 'list' }, { slug: 'internal', visibility: 'hide' }, { slug: '-x' }, null] }),
    [{ id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' }]
  );
  const viaCli = await discoverModels('cursor', async (args) => ({ ok: true, text: args[0] === '--list-models' ? 'a-1 - Model A\n' : '' }));
  assert.deepEqual(viaCli, { models: [{ id: 'a-1', label: 'Model A' }], error: null });
  assert.match((await discoverModels('cursor', async () => ({ ok: false, text: 'not logged in' }))).error, /model list/);
  const home = tmp();
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'o-test' }] }), { mode: 0o600 });
  assert.deepEqual((await discoverModels('codex', null, { CODEX_HOME: home })).models, [{ id: 'o-test', label: null }]);
  assert.deepEqual((await discoverModels('codex', null, { CODEX_HOME: path.join(home, 'absent') })).models, []);
  assert.deepEqual(await discoverModels('unknown', null), { models: [], error: null });
});

// ---------- Windows: npm launchers (.cmd) ----------

const { resolveLaunch, buildCommand, parseNpmShim } = require('../src/main/launch');

// Exact content of a launcher generated by npm (cmd-shim).
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

test('Windows: an npm launcher is run via node.exe, without cmd.exe', () => {
  const d = tmp();
  const pkg = path.join(d, 'node_modules', '@scope', 'tool');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'cli.js'), '');
  fs.writeFileSync(path.join(d, 'tool.cmd'), npmShim('node_modules\\@scope\\tool\\cli.js'));
  const nodeDir = tmp();
  fs.writeFileSync(path.join(nodeDir, 'node.exe'), 'MZ');
  const l = resolveLaunch(path.join(d, 'tool.cmd'), { envPath: nodeDir, platform: 'win32' });
  assert.equal(l.command, path.join(nodeDir, 'node.exe'));
  assert.deepEqual(l.prefix, [path.join(pkg, 'cli.js')]);
  assert.equal(l.viaCmd, false);
  // The prompt stays an ordinary argument: no interpreter sees it.
  const c = buildCommand(l, ['-p', '%PATH% & calc ^ "x"']);
  assert.deepEqual(c, { command: l.command, args: [path.join(pkg, 'cli.js'), '-p', '%PATH% & calc ^ "x"'], verbatim: false });
  // node.exe next to the launcher: takes precedence.
  fs.writeFileSync(path.join(d, 'node.exe'), 'MZ');
  assert.equal(resolveLaunch(path.join(d, 'tool.cmd'), { envPath: nodeDir, platform: 'win32' }).command, path.join(d, 'node.exe'));
});

test('Windows: npm launcher to a native binary, missing target, target outside the folder', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'node_modules', 'x', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(d, 'node_modules', 'x', 'bin', 'x.exe'), 'MZ');
  fs.writeFileSync(path.join(d, 'x.cmd'), '@ECHO off\r\n"%~dp0\\node_modules\\x\\bin\\x.exe"   %*\r\n');
  assert.deepEqual(resolveLaunch(path.join(d, 'x.cmd'), { platform: 'win32' }), {
    command: path.join(d, 'node_modules', 'x', 'bin', 'x.exe'), prefix: [], viaCmd: false,
  });
  fs.writeFileSync(path.join(d, 'absent.cmd'), npmShim('node_modules\\absent\\cli.js'));
  assert.match(resolveLaunch(path.join(d, 'absent.cmd'), { platform: 'win32' }).error, /missing file/);
  assert.equal(parseNpmShim('"%dp0%\\..\\..\\Windows\\evil.exe" %*', path.join(d, 'y.cmd')), null);
});

test('Windows: another .cmd goes through cmd.exe only with safe arguments', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'other.cmd'), '@echo off\r\nC:\\tool\\tool.exe %*\r\n');
  const l = resolveLaunch(path.join(d, 'other.cmd'), { platform: 'win32' });
  assert.equal(l.viaCmd, true);
  const ok = buildCommand(l, ['exec', '--sandbox', 'read-only', '--model', 'gpt-5.2', '-']);
  assert.equal(ok.verbatim, true);
  assert.deepEqual(ok.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(ok.args[3], `""${path.join(d, 'other.cmd')}" exec --sandbox read-only --model gpt-5.2 -"`);
  for (const bad of ['hello & calc', '%USERPROFILE%', 'a"b', 'x|y', 'with space', 'a^b', '!x!']) {
    assert.throws(() => buildCommand(l, ['-p', bad]), /cmd\.exe/);
  }
  // On Linux, none of this: the binary is run as is.
  assert.deepEqual(resolveLaunch('/usr/bin/tool', { platform: 'linux' }), { command: '/usr/bin/tool', prefix: [], viaCmd: false });
});

test('aska --help: options, shortcuts, detected agents and files; --version', () => {
  const { execFileSync } = require('child_process');
  const home = tmp();
  const bin = tmp();
  fs.writeFileSync(path.join(bin, exe('claude')), WIN ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
  const env = WIN
    ? { ...baseEnv(), USERPROFILE: home, APPDATA: path.join(home, 'R'), LOCALAPPDATA: path.join(home, 'L'), PATH: bin, NO_COLOR: '1' }
    : { ...baseEnv(), HOME: home, PATH: bin, NO_COLOR: '1' };
  env.LC_ALL = 'en_US.UTF-8'; // the help follows the system language
  for (const k of Object.keys(env)) if (/^XDG_/.test(k)) delete env[k];
  const cli = path.join(__dirname, '..', 'src', 'cli.js');
  const out = execFileSync(process.execPath, [cli, '--help'], { env, encoding: 'utf8' });
  for (const expected of ['Usage: aska [option]', '--toggle', '--hidden', '--reload', '--quit', 'Ctrl+Alt+Space', 'Read-only', 'Files']) {
    assert.ok(out.includes(expected), `"${expected}" missing from the help`);
  }
  assert.match(out, new RegExp(`✓ Claude\\s+${fs.realpathSync(path.join(bin, exe('claude'))).replace(/[\\.]/g, '\\$&')}`));
  assert.match(out, /✗ Codex\s+not found in PATH\n\s+install: npm i -g @openai\/codex/);
  assert.ok(!/\x1b\[/.test(out), 'no colors outside a terminal');
  assert.match(execFileSync(process.execPath, [cli, '--version'], { env, encoding: 'utf8' }), /^aska \d+\.\d+\.\d+\n$/);
  const fr = execFileSync(process.execPath, [cli, '--help'], { env: { ...env, LC_ALL: 'fr_FR.UTF-8' }, encoding: 'utf8' });
  for (const expected of ['Usage : aska [option]', 'Ctrl+Alt+Espace', 'Lecture seule', 'Fichiers', 'introuvable dans le PATH']) {
    assert.ok(fr.includes(expected), `"${expected}" missing from the French help`);
  }
  assert.ok(!fr.includes('—'), 'no em dash in the help');
});

// ---------- notifications ----------

const { shouldNotify, notificationContent, createNotifier } = require('../src/main/notify');

test('notifications: only when the chat is out of sight, never for a cancellation', () => {
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

test('notifications: readable content, no Markdown, and can be hidden', () => {
  const ok = notificationContent({ agentLabel: 'Claude', status: 'ok', answer: '## Report\n\nEverything is **green**, see `ci.yml`.', title: 'CI status' });
  assert.deepEqual(ok, { title: 'Claude replied', body: 'Report Everything is green, see ci.yml.' });
  const long = notificationContent({ agentLabel: 'Codex', status: 'ok', answer: 'x'.repeat(500) });
  assert.equal(long.body.length, 180);
  const hiddenContent = notificationContent({ agentLabel: 'Claude', status: 'ok', answer: 'secret', title: 'Password', preview: false });
  assert.deepEqual(hiddenContent, { title: 'Claude replied', body: '"Password"' });
  const err = notificationContent({ agentLabel: 'Copilot', status: 'error', notice: { kind: 'error', text: 'The CLI exited with code 3\n\nauth error' }, title: 't' });
  assert.deepEqual(err, { title: 'Copilot: failed', body: 'The CLI exited with code 3' });
  const denied = notificationContent({ agentLabel: 'Claude', status: 'ok', answer: 'Done.', notice: { kind: 'warn', text: '2 action(s) denied by the mode' } });
  assert.equal(denied.body, '2 actions denied · Done.');
});

test('notifications: one per conversation, click opens the right conversation, test log', () => {
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
  assert.equal(shown[0].closed, true, 'the previous notification of the same conversation is replaced');
  assert.equal(shown[1].closed, false);
  assert.equal(shown[1].o.silent, true);
  shown[2].handlers.click();
  assert.deepEqual(clicked, ['b']);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).title), ['T1', 'T2', 'T3']);
  // Without system support: nothing is shown, but nothing breaks.
  FakeNotification.isSupported = () => false;
  assert.equal(notify({ conversationId: 'c', title: 'x', body: 'y' }), false);
});

test('config: hide on outside click and notifications', () => {
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
  fs.writeFileSync(f, JSON.stringify({ notify: 'always' }), { mode: 0o600 });
  assert.equal(loadConfig(f).config.notify, 'hidden');
});

// ---------- instances ----------

const { buildId, runningInstance } = require('../src/main/build');

test('build id: stable, content-sensitive, overridable for tests', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'a.js'), 'one');
  fs.writeFileSync(path.join(d, 'sub', 'b.js'), 'two');
  const a = buildId(d, {});
  assert.equal(a, buildId(d, {}));
  assert.match(a, /^[0-9a-f]{12}$/);
  fs.writeFileSync(path.join(d, 'sub', 'b.js'), 'two changed');
  assert.notEqual(buildId(d, {}), a);
  assert.equal(buildId(d, { ASKA_BUILD_ID: 'test-1' }), 'test-1');
  assert.equal(buildId(path.join(d, 'absent'), {}).length, 12); // unreadable sources: never blocking
});

test('running instance: read from run.json, ignored if its process is gone', () => {
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

test('aska --help: outside click behavior and instance status', () => {
  const { execFileSync } = require('child_process');
  const home = tmp();
  const env = WIN
    ? { ...baseEnv(), USERPROFILE: home, APPDATA: path.join(home, 'R'), LOCALAPPDATA: path.join(home, 'L'), NO_COLOR: '1' }
    : { ...baseEnv(), HOME: home, NO_COLOR: '1' };
  for (const k of Object.keys(env)) if (/^(XDG_|LC_|LANGUAGE$)/.test(k)) delete env[k];
  env.LANG = 'en_US.UTF-8';
  const cli = path.join(__dirname, '..', 'src', 'cli.js');
  const help = () => execFileSync(process.execPath, [cli, '--help'], { env, encoding: 'utf8' });
  const P = require('../src/main/config').paths(env, home);
  let out = help();
  assert.match(out, /Outside click\s+Hides the chat/);
  assert.match(out, /Instance\s+Aska is not running/);
  assert.match(out, /--restart/);
  // Old config with hideOnBlur:false: the chat is not hidden, and the help says so.
  fs.mkdirSync(P.configDir, { recursive: true });
  fs.writeFileSync(P.config, JSON.stringify({ hideOnBlur: false }), { mode: 0o600 });
  assert.match(help(), /Outside click\s+Does not hide the chat: it is pinned/);
  // The pin chosen in the UI wins over the config.
  fs.mkdirSync(P.stateDir, { recursive: true });
  fs.writeFileSync(P.state, JSON.stringify({ pinned: false }), { mode: 0o600 });
  assert.match(help(), /Outside click\s+Hides the chat/);
  // An instance running other code is reported.
  fs.writeFileSync(P.run, JSON.stringify({ pid: process.pid, build: 'old' }), { mode: 0o600 });
  out = help();
  assert.match(out, /An old version is still running .* "aska --restart"/);
  fs.writeFileSync(P.run, JSON.stringify({ pid: process.pid, build: buildId() }), { mode: 0o600 });
  assert.match(help(), /Instance\s+Running/);
});

// ---------- translations ----------

test('i18n: language from the config, else the system', () => {
  const { resolveLanguage, systemLanguages } = i18n;
  const sys = (env) => systemLanguages(env);
  assert.equal(resolveLanguage('auto', sys({ LANG: 'fr_FR.UTF-8' })), 'fr');
  assert.equal(resolveLanguage('auto', sys({ LANG: 'en_US.UTF-8' })), 'en');
  assert.equal(resolveLanguage('auto', ['de_DE.UTF-8']), 'en');
  assert.equal(resolveLanguage('auto', ['C', 'POSIX', 'C.UTF-8', 'fr_CA']), 'fr');
  assert.equal(resolveLanguage('auto', []), 'en');
  assert.equal(resolveLanguage('en', ['fr-FR']), 'en');
  assert.equal(resolveLanguage('fr', ['en-US']), 'fr');
  assert.equal(resolveLanguage('xx', ['fr-FR']), 'fr');
  // LC_ALL wins over LANG; "C" is skipped; LANGUAGE is a colon list.
  assert.deepEqual(sys({ LC_ALL: 'fr_FR.UTF-8', LANG: 'en_US.UTF-8' }).slice(0, 2), ['fr_FR.UTF-8', 'en_US.UTF-8']);
  assert.equal(sys({ LC_ALL: 'C', LANG: 'fr_FR.UTF-8' })[0], 'fr_FR.UTF-8');
  assert.deepEqual(sys({ LANG: 'C.UTF-8', LANGUAGE: 'fr:en' }).slice(0, 2), ['fr', 'en']);
  // Config: "language" decides, and warnings come out in that language.
  const d = tmp();
  const f = path.join(d, 'config.json');
  fs.writeFileSync(f, JSON.stringify({ language: 'fr', defaultMode: 'auto' }), { mode: 0o600 });
  try {
    const c = loadConfig(f, { systemLangs: ['en-US'] });
    assert.equal(c.config.language, 'fr');
    assert.equal(i18n.getLanguage(), 'fr');
    assert.match(c.warnings[0], /refusé/);
    fs.writeFileSync(f, JSON.stringify({ language: 'klingon' }), { mode: 0o600 });
    assert.equal(loadConfig(f, { systemLangs: ['fr_FR'] }).config.language, 'auto');
    assert.equal(i18n.getLanguage(), 'fr');
    loadConfig(f, { systemLangs: ['en_US'] });
    assert.equal(i18n.getLanguage(), 'en');
  } finally {
    i18n.setLanguage('en');
  }
});

test('i18n: interpolation, plurals and fallbacks', () => {
  const { t } = i18n;
  try {
    i18n.setLanguage('fr');
    assert.equal(t('ui.history.count', { count: 0 }), '0 conversation', 'French: 0 is singular');
    assert.equal(t('ui.history.count', { count: 2 }), '2 conversations');
    assert.equal(t('errors.unknownAgent'), 'Agent inconnu');
    i18n.setLanguage('en');
    assert.equal(t('ui.history.count', { count: 0 }), '0 conversations', 'English: 0 is plural');
    assert.equal(t('ui.history.count', { count: 1 }), '1 conversation');
    assert.equal(t('notify.replied', { agent: 'Claude' }), 'Claude replied');
    assert.equal(t('notify.replied', { agent: '{agent}' }), '{agent} replied', 'values are not interpolated again');
    assert.equal(t('no.such.key'), 'no.such.key');
    assert.equal(i18n.uiStrings().history.today, 'Today');
    assert.equal(i18n.setLanguage('xx'), 'en');
  } finally {
    i18n.setLanguage('en');
  }
});

test('i18n: every language has the same keys and placeholders, and no em dash', () => {
  const flat = (o, prefix = '', out = {}) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') flat(v, prefix + k + '.', out);
      else out[prefix + k] = v;
    }
    return out;
  };
  const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const en = flat(i18n.DICTS.en);
  for (const lang of i18n.LANGUAGES) {
    const other = flat(i18n.DICTS[lang]);
    assert.deepEqual(Object.keys(other).sort(), Object.keys(en).sort(), `${lang}: same keys as en`);
    for (const [k, v] of Object.entries(other)) {
      assert.equal(typeof v, 'string', `${lang}.${k} is a string`);
      assert.deepEqual(placeholders(v), placeholders(en[k]), `${lang}.${k}: same placeholders`);
      assert.ok(!v.includes('\u2014'), `${lang}.${k}: no em dash`);
    }
  }
});
