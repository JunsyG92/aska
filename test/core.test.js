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

test('conversations: list summaries cached, refreshed when a file changes', () => {
  const d = path.join(tmp(), 'conv-cache');
  const store = new ConversationStore(d);
  const c = store.create('/p');
  c.turns.push({ agent: 'claude', label: 'Claude', prompt: 'first', answer: 'one' });
  store.save(c);
  assert.equal(store.list()[0].preview, 'one');
  // A save through the store updates the summary without rereading the file.
  c.turns.push({ agent: 'codex', label: 'Codex', prompt: 'second', answer: 'two' });
  store.save(c);
  const [item] = store.list();
  assert.equal(item.turns, 2);
  assert.deepEqual(item.agentIds, ['claude', 'codex']);
  // A file changed outside the store (other instance, manual edit) is reread.
  const file = path.join(d, c.id + '.json');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  disk.turns[1].answer = 'changed outside';
  fs.writeFileSync(file, JSON.stringify(disk));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.equal(store.list()[0].preview, 'changed outside');
  // A file deleted outside the store disappears from the list.
  fs.unlinkSync(file);
  assert.deepEqual(store.list(), []);
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

const { resolveLaunch, buildCommand, parseNpmShim, extendedPath } = require('../src/main/launch');

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

test('system tray icon: state, tooltip and menu', () => {
  const item = (m, id) => m.items.find((it) => it.id === id);
  const idle = trayModel({ running: 0, visible: false });
  assert.equal(idle.icon, 'idle');
  assert.equal(idle.tooltip, 'Aska');
  assert.equal(item(idle, 'toggle').label, 'Show Aska');
  assert.equal(item(idle, 'new').enabled, true);
  assert.equal(item(idle, 'cancel').enabled, false);
  assert.equal(item(idle, 'quit').enabled, true);

  const busy = trayModel({ running: 1, agentLabels: ['Claude'], visible: true });
  assert.equal(busy.icon, 'running');
  assert.equal(busy.tooltip, 'Aska: Claude running…');
  assert.equal(item(busy, 'toggle').label, 'Hide Aska');
  // A new conversation opens in a tab: allowed while a request is running.
  assert.equal(item(busy, 'new').enabled, true);
  assert.equal(item(busy, 'cancel').enabled, true);
  assert.equal(item(busy, 'cancel').label, 'Cancel the run');

  // Several tabs at work: count, and agents without duplicates.
  const many = trayModel({ running: 3, agentLabels: ['Claude', 'Codex', 'Claude'], visible: false });
  assert.equal(many.tooltip, 'Aska: 3 requests running (Claude, Codex)');
  assert.equal(item(many, 'cancel').label, 'Cancel the 3 runs');

  // Follows the UI language.
  try {
    i18n.setLanguage('fr');
    const fr = trayModel({ running: 2, agentLabels: ['Codex'], visible: false });
    assert.equal(fr.tooltip, 'Aska : 2 demandes en cours (Codex)');
    assert.equal(item(fr, 'toggle').label, 'Afficher Aska');
    assert.equal(item(fr, 'cancel').label, 'Annuler les 2 exécutions');
    assert.equal(item(trayModel({ running: 1, agentLabels: ['Claude'] }), 'cancel').label, 'Annuler l’exécution');
  } finally {
    i18n.setLanguage('en');
  }

  // The declared icons exist, in normal and high-density sizes.
  for (const f of Object.values(ICONS)) {
    assert.ok(fs.existsSync(path.join(ICON_DIR, f)), f);
    assert.ok(fs.existsSync(path.join(ICON_DIR, f.replace('.png', '@2x.png'))), f);
  }
});

test('system tray icon: menu wired to actions, rebuilt only when needed', () => {
  const log = [];
  class FakeTray {
    constructor(img) { this.img = img; this.handlers = {}; this.destroyed = false; log.push(['new', img]); }
    on(ev, fn) { this.handlers[ev] = fn; }
    setImage(img) { this.img = img; }
    setToolTip(tip) { this.tip = tip; }
    setContextMenu(m) { this.menu = m; log.push(['menu']); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  let tray;
  const electron = {
    Tray: class extends FakeTray { constructor(i) { super(i); tray = this; } },
    Menu: { buildFromTemplate: (tpl) => tpl },
    nativeImage: { createFromPath: (p) => path.basename(p) },
  };
  const called = [];
  const actions = Object.fromEntries(['toggle', 'new', 'cancel', 'settings', 'quit'].map((k) => [k, () => called.push(k)]));
  const handle = createTray(electron, actions);

  handle.update({ running: 0, visible: false });
  assert.equal(tray.img, 'tray.png');
  assert.equal(tray.tip, 'Aska');
  const menus = () => log.filter((l) => l[0] === 'menu').length;
  assert.equal(menus(), 1);
  handle.update({ running: 0, visible: false });
  assert.equal(menus(), 1, 'same state: menu not rebuilt');

  handle.update({ running: 1, agentLabels: ['Codex'], visible: false });
  assert.equal(tray.img, 'tray-running.png');
  assert.equal(tray.tip, 'Aska: Codex running…');
  assert.equal(menus(), 2);

  // Each entry calls its action; clicking the icon shows or hides.
  for (const it of tray.menu) if (it.click) it.click();
  tray.handlers.click();
  assert.deepEqual(called, ['toggle', 'new', 'cancel', 'settings', 'quit', 'toggle']);

  handle.destroy();
  handle.destroy();
  assert.equal(tray.destroyed, true);
});

test('config: system tray icon on by default, can be turned off', () => {
  const d = tmp();
  const f = path.join(d, 'config.json');
  assert.equal(loadConfig(path.join(d, 'absent.json')).config.tray, true);
  fs.writeFileSync(f, JSON.stringify({ tray: false }), { mode: 0o600 });
  assert.equal(loadConfig(f).config.tray, false);
  fs.writeFileSync(f, JSON.stringify({ tray: 'no' }), { mode: 0o600 });
  assert.equal(loadConfig(f).config.tray, true);
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
  // The extended PATH adds /usr/local/bin and /opt/homebrew/bin: Codex may be installed there on the test machine.
  const codexInstalled = !WIN && ['/usr/local/bin', '/opt/homebrew/bin'].some((d) => fs.existsSync(path.join(d, 'codex')));
  if (!codexInstalled) assert.match(out, /✗ Codex\s+not found in PATH\n\s+install: npm i -g @openai\/codex/);
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
  const placeholders = (s) => [...s.matchAll(/\{((?:key:)?\w+)\}/g)].map((m) => m[1]).sort();
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

// ---------- macOS ----------

test('macOS: real system folders (/private/etc...) and Homebrew in the PATH', () => {
  const dirs = sec.posixSystemDirs('darwin');
  for (const d of ['/etc', '/private/etc', '/System', '/Library']) assert.ok(dirs.includes(d), d);
  assert.ok(!sec.posixSystemDirs('linux').includes('/private/etc'));
  const mac = extendedPath({ env: { PATH: '/usr/bin' }, home: '/Users/u', platform: 'darwin' }).split(':');
  assert.ok(mac.includes('/opt/homebrew/bin'));
  assert.ok(mac.includes('/Users/u/.local/bin'));
  const linux = extendedPath({ env: { PATH: '/usr/bin' }, home: '/home/u', platform: 'linux' }).split(':');
  assert.ok(!linux.includes('/opt/homebrew/bin'));
});

// ---------- tabs ----------

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

test('tabs: creation, reuse of the empty tab, limit', () => {
  const { tabs } = tabsFixture();
  tabs.restore([], null, '/p');
  assert.equal(tabs.list.length, 1);
  const first = tabs.active();
  // The active tab is still empty: "new tab" reuses it.
  assert.equal(tabs.create('/p').tab, first);
  first.conv.turns.push({ agent: 'claude', prompt: 'q', answer: '' });
  const second = tabs.create('/p').tab;
  assert.notEqual(second, first);
  assert.equal(tabs.activeId, second.id);
  second.conv.turns.push({ agent: 'codex', prompt: 'q2', answer: '' });
  tabs.create('/q').tab.conv.turns.push({ agent: 'codex', prompt: 'q3', answer: '' });
  assert.match(tabs.create('/p').error, /3 tabs at most/);
  assert.equal(tabs.cycle(1).id, first.id); // wraps around
  assert.equal(tabs.cycle(-1).id, tabs.list[2].id);
});

test('tabs: open a saved conversation, without duplicates', () => {
  const { tabs, saved } = tabsFixture();
  const a = saved('Sujet A');
  const b = saved('Sujet B');
  tabs.restore([], null, '/p');
  const emptyId = tabs.activeId;
  // The empty tab is replaced by the opened conversation.
  tabs.open(a);
  assert.deepEqual(tabs.list.map((t) => t.id), [a]);
  assert.ok(!tabs.get(emptyId));
  tabs.open(b);
  assert.deepEqual(tabs.list.map((t) => t.id), [a, b]);
  // Already open: simply activated.
  tabs.open(a);
  assert.equal(tabs.list.length, 2);
  assert.equal(tabs.activeId, a);
  assert.match(tabs.open('0123456789abcdef').error, /not found/);
});

test('tabs: closing a working tab asks for confirmation and cancels its request', () => {
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
  assert.equal(tabs.activeId, b, 'the neighbouring tab becomes active');
  // Closing the last tab reopens an empty one: there is always one left.
  tabs.close(b);
  assert.equal(tabs.list.length, 1);
  assert.equal(tabs.active().conv.turns.length, 0);
  // Deleting a working conversation from the history is refused.
  tabs.open(a);
  tabs.get(a).run = { id: 2, handle: { cancel() {} } };
  assert.match(tabs.forget(a).error, /is running/);
});

test('tabs: saved then reopened, unread answers cleared on activation', () => {
  const { store, tabs, saved } = tabsFixture();
  const a = saved('A');
  const b = saved('B');
  tabs.restore([a, b], b, '/p');
  tabs.create('/p'); // empty tab: not saved
  assert.deepEqual(tabs.serialize(), { tabs: [a, b], activeTab: b });
  tabs.get(a).unread = true;
  tabs.activate(a);
  assert.equal(tabs.get(a).unread, false);
  // Reopening: deleted conversation skipped, invalid ids skipped.
  store.delete(b);
  const again = new Tabs(store);
  again.restore([a, b, 42, a], b, '/p');
  assert.deepEqual(again.list.map((t) => t.id), [a]);
  assert.equal(again.activeId, a);
});

// ---------- shortcuts inside the window ----------

const keys = require('../src/main/keys');

test('shortcuts: parsing, canonical form and display', () => {
  const { parseCombo, comboId, formatCombo } = keys;
  assert.deepEqual(parseCombo('Ctrl+Shift+M'), { ctrl: true, shift: true, alt: false, meta: false, key: 'm' });
  assert.deepEqual(parseCombo('control + pagedown'), { ctrl: true, shift: false, alt: false, meta: false, key: 'PageDown' });
  assert.deepEqual(parseCombo('Cmd+,'), { ctrl: false, shift: false, alt: false, meta: true, key: ',' });
  assert.equal(parseCombo('Option+F5').key, 'F5');
  for (const bad of ['', 'Ctrl+', 'Ctrl++', 'Ctrl+Ctrl+M', 'Ctrl+Enter', 'Ctrl+ArrowUp', 'Ctrl+Space', 'Shift+Ctrl', 'M+Ctrl', 42, null, 'x'.repeat(41)]) {
    assert.equal(parseCombo(bad), null, String(bad));
  }
  assert.equal(comboId(parseCombo('Shift+Ctrl+M')), comboId(parseCombo('Ctrl+Shift+m')));
  assert.equal(formatCombo(parseCombo('ctrl+shift+m')), 'Ctrl+Shift+M');
  try {
    i18n.setLanguage('fr');
    assert.equal(formatCombo(parseCombo('Ctrl+Shift+PageDown')), 'Ctrl+Maj+PgSuiv');
  } finally {
    i18n.setLanguage('en');
  }
});

test('shortcuts: combos kept for typing, editing and tab numbers', () => {
  const r = (s) => keys.reservedReason(keys.parseCombo(s));
  assert.equal(r('H'), 'needsModifier');
  assert.equal(r('Shift+H'), 'needsModifier');
  for (const s of ['Ctrl+C', 'Ctrl+V', 'Ctrl+Shift+V', 'Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+Y', 'Ctrl+A', 'Meta+X']) assert.equal(r(s), 'editing', s);
  assert.equal(r('Ctrl+3'), 'tabNumbers');
  for (const s of ['Ctrl+Shift+C', 'Ctrl+Alt+C', 'Alt+H', 'Ctrl+Shift+3', 'Ctrl+H']) assert.equal(r(s), null, s);
});

test('shortcuts: defaults, replaced, removed, conflicts and warnings', () => {
  const { resolveKeybindings, ACTIONS, keyLabels } = keys;
  const ids = (b, a) => b[a].map(keys.comboId);
  const d = resolveKeybindings(undefined);
  assert.deepEqual(Object.keys(d.bindings), ACTIONS);
  assert.deepEqual(d.warnings, []);
  assert.deepEqual(ids(d.bindings, 'newTab'), ['ctrl+t', 'ctrl+n', 'ctrl+l']);
  assert.deepEqual(keyLabels(d.bindings).modelMenu, 'Ctrl+Shift+M');

  // An action given replaces its defaults; false removes them; a combo taken
  // from another action's defaults is removed there, silently.
  const r = resolveKeybindings({ history: 'Ctrl+J', closeTab: false, pickDir: ['Ctrl+N', 'Alt+O'] });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(ids(r.bindings, 'history'), ['ctrl+j']);
  assert.deepEqual(r.bindings.closeTab, []);
  assert.deepEqual(ids(r.bindings, 'pickDir'), ['ctrl+n', 'alt+o']);
  assert.deepEqual(ids(r.bindings, 'newTab'), ['ctrl+t', 'ctrl+l']);
  assert.equal(keyLabels(r.bindings).closeTab, 'no shortcut');

  // Between two configured actions, the first keeps the combo.
  const c = resolveKeybindings({ history: 'Ctrl+J', copyAnswer: ['Ctrl+J', 'Ctrl+Shift+J'] });
  assert.deepEqual(ids(c.bindings, 'copyAnswer'), ['ctrl+shift+j']);
  assert.match(c.warnings.join('\n'), /keybindings\.copyAnswer: Ctrl\+J is already used by "history"/);

  // Invalid entries are reported; an action left without any valid combo keeps its defaults.
  const bad = resolveKeybindings({ history: 'Ctrl+C', toggleMini: 'Ctrl+Enter', nope: 'Ctrl+K', togglePin: 3 });
  assert.equal(bad.warnings.length, 4);
  assert.match(bad.warnings[0], /kept for text editing/);
  assert.match(bad.warnings[1], /not a valid shortcut/);
  assert.match(bad.warnings[2], /unknown action "nope"/);
  assert.match(bad.warnings[3], /keybindings\.togglePin: expected/);
  assert.deepEqual(ids(bad.bindings, 'history'), ['ctrl+h']);
  assert.deepEqual(ids(bad.bindings, 'toggleMini'), ['ctrl+m']);
  assert.match(resolveKeybindings(['Ctrl+H']).warnings[0], /"keybindings" ignored/);
});

test('config: keybindings fill {key:…} in strings and in aska --help', () => {
  const { execFileSync } = require('child_process');
  const d = tmp();
  const f = path.join(d, 'config.json');
  try {
    fs.writeFileSync(f, JSON.stringify({ keybindings: { history: 'Ctrl+J', togglePin: [] } }), { mode: 0o600 });
    const c = loadConfig(f);
    assert.deepEqual(c.warnings, []);
    assert.deepEqual(c.config.keybindings.history.map(keys.comboId), ['ctrl+j']);
    assert.equal(i18n.t('ui.history.title'), 'Conversations (Ctrl+J)');
    assert.equal(i18n.t('cli.outsideClickHides'), 'Hides the chat (no shortcut to pin it)');
    assert.equal(i18n.t('security.homeRefused').endsWith('(Ctrl+O)'), true);
    // Back to the defaults when the config has no keybindings.
    loadConfig(path.join(d, 'absent.json'));
    assert.equal(i18n.t('ui.history.title'), 'Conversations (Ctrl+H)');
  } finally {
    loadConfig(path.join(d, 'absent.json'));
  }

  // The help lists the shortcuts as configured, in the config's language.
  const home = tmp();
  const env = WIN
    ? { ...baseEnv(), USERPROFILE: home, APPDATA: path.join(home, 'R'), LOCALAPPDATA: path.join(home, 'L'), NO_COLOR: '1' }
    : { ...baseEnv(), HOME: home, NO_COLOR: '1' };
  for (const k of Object.keys(env)) if (/^XDG_/.test(k)) delete env[k];
  const P = require('../src/main/config').paths(env, home);
  fs.mkdirSync(P.configDir, { recursive: true });
  fs.writeFileSync(P.config, JSON.stringify({ language: 'fr', keybindings: { history: 'Ctrl+J', modelMenu: 'Alt+Shift+M' } }), { mode: 0o600 });
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), '--help'], { env, encoding: 'utf8' });
  assert.match(out, /Ctrl\+J\s+Historique des conversations/);
  assert.match(out, /Alt\+Maj\+M\s+Choisir le modèle/);
  assert.ok(!/Ctrl\+H\s/.test(out), 'Ctrl+H no longer listed');
});

// ---------- settings panel ----------

const settings = require('../src/main/settings');
const gnome = require('../src/main/gnome');

test('shortcuts: canonical text for the config, settings action', () => {
  assert.equal(keys.comboText(keys.parseCombo('shift+ctrl+pagedown')), 'Ctrl+Shift+PageDown');
  assert.equal(keys.comboText(keys.parseCombo('cmd+,')), 'Meta+,');
  assert.deepEqual(keys.resolveKeybindings(undefined).bindings.settings.map(keys.comboId), ['ctrl+,']);
  const r = keys.resolveKeybindings({ history: 'Ctrl+C', nope: 'Ctrl+K' });
  assert.deepEqual(r.problems.map((p) => p.action), ['history', null]);
});

test('settings: validation of the values sent by the window', () => {
  const { validateSettings } = settings;
  const ok = validateSettings(
    { language: 'fr', defaultAgent: 'codex', defaultMode: 'edit', timeoutSec: 120, tray: false, notify: 'never', shortcut: 'ctrl+alt+a', keybindings: { history: ['Ctrl+J'] }, agents: { evil: {} }, allowAutoMode: true },
    { agentIds: ['claude', 'codex'] }
  );
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.values, { language: 'fr', defaultAgent: 'codex', defaultMode: 'edit', timeoutSec: 120, tray: false, notify: 'never', shortcut: 'Control+Alt+A', keybindings: { history: ['Ctrl+J'] } });
  assert.ok(!('agents' in ok.values) && !('allowAutoMode' in ok.values), 'keys outside the panel are dropped');

  const bad = validateSettings(
    { language: 'de', defaultAgent: 'gemini', defaultMode: 'auto', timeoutSec: 2, tray: 'yes', notify: 'always', shortcut: 'A' },
    { agentIds: ['claude'] }
  );
  assert.deepEqual(Object.keys(bad.errors).sort(), ['defaultAgent', 'defaultMode', 'language', 'notify', 'shortcut', 'timeoutSec', 'tray']);
  assert.match(bad.errors.timeoutSec, /5 and 3600/);
  for (const s of ['Shift+A', 'Control+Alt+Enter', 'Control+Control+A', 'Hyper+A']) assert.ok(validateSettings({ shortcut: s }).errors.shortcut, s);
  assert.equal(validateSettings({ shortcut: false }).values.shortcut, false);
  assert.equal(validateSettings({ shortcut: 'Super+F12' }).values.shortcut, 'Super+F12');

  // Shortcut conflicts and reserved combos: errors on the action, nothing to write.
  const kb = validateSettings({ keybindings: { history: ['Ctrl+J'], copyAnswer: ['Ctrl+J'], pickDir: ['Ctrl+V'] } });
  assert.deepEqual(Object.keys(kb.errors).sort(), ['keybindings.copyAnswer', 'keybindings.pickDir']);
  assert.match(validateSettings(null).errors._, /Invalid/);
});

test('settings: config.json keeps the rest and only what differs from the defaults', () => {
  const { mergeConfig } = settings;
  const raw = { shortcut: 'Control+Alt+A', tray: false, agents: { claude: { extraArgs: ['--max-turns', '20'] } }, keybindings: { togglePin: false } };
  const out = mergeConfig(raw, {
    tray: true, // back to the default: removed
    language: 'fr',
    shortcut: 'Control+Alt+Space', // default: removed
    keybindings: { history: ['Ctrl+J'], togglePin: ['Ctrl+P'], closeTab: [] },
    allowAutoMode: true, // not managed: ignored
  });
  assert.deepEqual(out, {
    agents: { claude: { extraArgs: ['--max-turns', '20'] } },
    keybindings: { history: ['Ctrl+J'], closeTab: false },
    language: 'fr',
  });
  assert.deepEqual(mergeConfig({ keybindings: { history: ['Ctrl+J'] } }, { keybindings: { history: ['Ctrl+H'] } }), {}, 'no keybindings left: section removed');
  assert.deepEqual(mergeConfig(null, { shortcut: false }), { shortcut: false });
  // The view sends the effective values and the defaults, shortcuts as text.
  const v = settings.settingsView(loadConfig(path.join(tmp(), 'absent.json')).config);
  assert.equal(v.values.shortcut, 'Control+Alt+Space');
  assert.deepEqual(v.values.keybindings.prevTab, ['Ctrl+Shift+Tab', 'Ctrl+PageUp']);
  assert.deepEqual(v.defaults.keybindings.settings, ['Ctrl+,']);
});

test('GNOME shortcut: conversions and gsettings calls', async () => {
  assert.equal(gnome.toGnome('Control+Alt+A'), '<Control><Alt>a');
  assert.equal(gnome.toGnome('Super+Shift+Space'), '<Super><Shift>space');
  assert.equal(gnome.toGnome('Control+F5'), '<Control>F5');
  assert.equal(gnome.toGnome(false), '');
  assert.equal(gnome.fromGnome('<Primary><Alt>space'), 'Control+Alt+Space');
  assert.equal(gnome.fromGnome('<Alt><Control>a'), 'Control+Alt+A');
  assert.equal(gnome.fromGnome(''), false);
  assert.equal(gnome.isGnomeSession({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, 'linux'), true);
  assert.equal(gnome.isGnomeSession({ XDG_CURRENT_DESKTOP: 'KDE' }, 'linux'), false);
  assert.equal(gnome.isGnomeSession({ XDG_CURRENT_DESKTOP: 'GNOME' }, 'darwin'), false);
  // The system gsettings (root-owned) wins over one from the PATH (Homebrew…), which may write elsewhere.
  const fakeStat = (files) => (p) => {
    if (!files[p]) throw new Error('ENOENT');
    return { isFile: () => true, ...files[p] };
  };
  assert.equal(gnome.systemGsettings({ stat: fakeStat({ '/usr/bin/gsettings': { uid: 0, mode: 0o755 } }) }), '/usr/bin/gsettings');
  assert.equal(gnome.systemGsettings({ stat: fakeStat({ '/usr/bin/gsettings': { uid: 1000, mode: 0o755 } }) }), null, 'not root-owned');
  assert.equal(gnome.systemGsettings({ stat: fakeStat({ '/usr/bin/gsettings': { uid: 0, mode: 0o777 } }) }), null, 'writable by others');
  assert.equal(gnome.systemGsettings({ stat: fakeStat({}) }), null);

  // Fake gsettings: an in-memory store, as GVariant text.
  const fake = (initial) => {
    const db = { ...initial };
    const calls = [];
    const run = async (args) => {
      calls.push(args);
      const [op, schema, key, value] = args;
      if (op === 'get') return (db[`${schema} ${key}`] ?? (key === 'custom-keybindings' ? '@as []' : "''")) + '\n';
      db[`${schema} ${key}`] = value;
      return '';
    };
    return { db, calls, run };
  };
  const LIST = `${gnome.SCHEMA} custom-keybindings`;
  const E = `${gnome.SCHEMA}.custom-keybinding:${gnome.KEY}`;

  // No entry yet: added after the existing ones, with the given command.
  const other = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/';
  const f = fake({ [LIST]: `['${other}']` });
  assert.deepEqual(await gnome.readShortcut(f.run), { binding: false, command: '' });
  await gnome.writeShortcut(f.run, 'Control+Alt+A', '/home/me/.local/bin/aska --toggle');
  assert.deepEqual(gnome.parseList(f.db[LIST]), [other, gnome.KEY]);
  assert.equal(f.db[`${E} binding`], "'<Control><Alt>a'");
  assert.equal(f.db[`${E} command`], "'/home/me/.local/bin/aska --toggle'");
  assert.deepEqual(await gnome.readShortcut(f.run), { binding: 'Control+Alt+A', command: '/home/me/.local/bin/aska --toggle' });

  // Existing entry: list untouched, command kept, binding emptied for "none".
  f.db[`${E} command`] = "'/opt/aska/bin/aska --toggle'";
  const before = f.calls.length;
  await gnome.writeShortcut(f.run, false, '/other --toggle');
  assert.ok(!f.calls.slice(before).some((c) => c[0] === 'set' && c[2] === 'custom-keybindings'));
  assert.equal(f.db[`${E} command`], "'/opt/aska/bin/aska --toggle'");
  assert.equal(f.db[`${E} binding`], "''");
  // Quotes in a value are escaped for GVariant; only fixed arguments, no shell.
  const g = fake({});
  await gnome.writeShortcut(g.run, 'Control+Alt+A', "/home/o'neil/aska --toggle");
  assert.equal(g.db[`${E} command`], "'/home/o\\'neil/aska --toggle'");
  assert.ok(g.calls.every((c) => Array.isArray(c) && c.length <= 4));

  // Command for a new entry: the launcher if installed, else Electron, quoted when needed.
  assert.equal(gnome.toggleCommand({ env: {}, home: '/home/me', exists: () => true }), '/home/me/.local/bin/aska --toggle');
  assert.equal(gnome.toggleCommand({ env: {}, home: '/h', exists: () => false, execPath: '/opt/my apps/electron', appPath: '/src/aska' }), '"/opt/my apps/electron" /src/aska --toggle');
});

// ---------- POSIX ACLs ----------

test('ACL: only a real write access for someone else refuses a private file', () => {
  const w = (text) => sec.aclWritableByOthers(text, 1000);
  // ACL naming the owner (domain-joined machine): mode 670, nobody else can write.
  assert.equal(w('user::rw-\nuser:1000:rwx\ngroup::---\nmask::rwx\nother::---\n'), false);
  assert.equal(w('user::rw-\ngroup::r--\nother::r--\n'), false);
  assert.equal(w('user::rw-\nuser:1001:rw-\ngroup::---\nmask::rwx\nother::---\n'), true, 'another user');
  assert.equal(w('user::rw-\nuser:1001:rw-\ngroup::---\nmask::r--\nother::---\n'), false, 'masked out');
  assert.equal(w('user::rw-\ngroup::rw-\nother::---\n'), true, 'owning group');
  assert.equal(w('user::rw-\ngroup::---\ngroup:50:rwx\nmask::rwx\nother::---\n'), true, 'named group');
  assert.equal(w('user::rw-\ngroup::---\nother::rw-\n'), true, 'other');
  assert.equal(w('user::rw-\nuser:1000:rwx\t#effective:r--\ngroup::---\nmask::r--\nother::---\n'), false, 'comments ignored');
  assert.equal(w('garbage'), null);
});

test('ACL: a real file with an ACL naming its owner is read, another user refuses it', (t) => {
  const { execFileSync } = require('child_process');
  if (process.platform !== 'linux' || !fs.existsSync('/usr/bin/setfacl')) return t.skip('setfacl not available');
  const f = path.join(tmp(), 'config.json');
  fs.writeFileSync(f, '{"ok":true}', { mode: 0o600 });
  try {
    execFileSync('/usr/bin/setfacl', ['-m', `u:${process.getuid()}:rwx`, f]);
  } catch {
    return t.skip('ACLs not supported on this file system');
  }
  assert.equal(fs.statSync(f).mode & 0o070, 0o070, 'the mask shows up as the group bits');
  assert.deepEqual(sec.readOwnedJson(f), { data: { ok: true } });
  execFileSync('/usr/bin/setfacl', ['-m', 'g::rw', f]);
  assert.match(sec.readOwnedJson(f).error, /writable by other users/);
});

// ---------- "/" commands typed in the field (renderer, pure logic) ----------

const commands = require('../src/renderer/commands');

test('commands: what is a command, what is a message', () => {
  const ctx = { agents: [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }] };
  assert.deepEqual(commands.parse('/new', ctx), { kind: 'command', name: 'new', arg: '' });
  assert.deepEqual(commands.parse('  /MODE  edit ', ctx), { kind: 'command', name: 'mode', arg: 'edit' });
  assert.deepEqual(commands.parse('/clear', ctx), { kind: 'command', name: 'new', arg: '' }, 'alias');
  assert.deepEqual(commands.parse('/cd ~/my project', ctx), { kind: 'command', name: 'cd', arg: '~/my project' });
  // An agent id: switch, and send the rest (several lines kept).
  assert.deepEqual(commands.parse('/codex explain\nthis', ctx), { kind: 'agent', agentId: 'codex', rest: 'explain\nthis' });
  assert.deepEqual(commands.parse('/cursor hi', ctx), { kind: 'unknown', name: 'cursor' }, 'unavailable agent');
  assert.deepEqual(commands.parse('/review', ctx), { kind: 'unknown', name: 'review' });
  // Messages: a path, a slash elsewhere, "//" escapes.
  assert.deepEqual(commands.parse('/etc/hosts: what is it?', ctx), { kind: 'send', text: '/etc/hosts: what is it?' });
  assert.deepEqual(commands.parse('a/b /new', ctx), { kind: 'send', text: 'a/b /new' });
  assert.deepEqual(commands.parse('//review the diff', ctx), { kind: 'send', text: '/review the diff' });
  assert.deepEqual(commands.parse('/', ctx), { kind: 'send', text: '/' });
  assert.deepEqual(commands.parse('/1abc', ctx), { kind: 'send', text: '/1abc' });
  // No context: no agent, never "__proto__" or the like.
  assert.deepEqual(commands.parse('/__proto__'), { kind: 'send', text: '/__proto__' });
  assert.deepEqual(commands.parse('/constructor'), { kind: 'unknown', name: 'constructor' });
});

test('commands: suggestions while typing', () => {
  const ctx = {
    agents: [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }],
    modes: [{ id: 'read', label: 'Read-only' }, { id: 'edit', label: 'Edit' }],
    models: ['opus', 'sonnet'],
  };
  const names = (text) => commands.suggest(text, ctx).map((i) => i.name);
  // Not a command being typed.
  for (const s of ['hello', '//x', '/new\n', '', ' /new']) assert.equal(commands.suggest(s, ctx), null, s);
  // "/" alone: every command, then the agents.
  assert.equal(names('/').length, 12, 'capped');
  assert.deepEqual(names('/c'), ['clear', 'close', 'cd', 'copy', 'claude', 'codex']);
  assert.deepEqual(names('/MO'), ['mode', 'model']);
  // A required argument: the line waits for it.
  const mode = commands.suggest('/mode', ctx)[0];
  assert.deepEqual([mode.line, mode.done, mode.arg], ['/mode ', false, 'mode']);
  const nw = commands.suggest('/new', ctx)[0];
  assert.deepEqual([nw.line, nw.done], ['/new', true]);
  const cl = commands.suggest('/cla', ctx)[0];
  assert.deepEqual([cl.line, cl.desc, cl.descParams], ['/claude', 'switchTo', { agent: 'Claude' }]);
  // Values of the argument.
  assert.deepEqual(commands.suggest('/mode ', ctx).map((i) => i.line), ['/mode read', '/mode edit']);
  assert.deepEqual(names('/mode e'), ['edit']);
  assert.deepEqual(names('/model '), ['default', 'opus', 'sonnet']);
  assert.deepEqual(names('/agent co'), ['codex']);
  assert.deepEqual(names('/cd ~/'), [], 'free argument');
  assert.deepEqual(names('/mode edit now'), [], 'one argument at most');
  assert.deepEqual(names('/zzz '), []);
  assert.deepEqual(names('/zzz'), []);
});

test('commands: every description and argument is translated', () => {
  for (const lang of i18n.LANGUAGES) {
    const ui = i18n.DICTS[lang].ui.commands;
    for (const c of commands.COMMANDS) {
      assert.equal(typeof ui.desc[c.name], 'string', `${lang}: ${c.name}`);
      if (c.arg) assert.equal(typeof ui.args[c.arg], 'string', `${lang}: ${c.arg}`);
    }
    assert.equal(typeof ui.desc.switchTo, 'string');
    assert.equal(typeof ui.args.message, 'string');
  }
});
