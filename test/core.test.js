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

const FAKE = path.join(__dirname, 'fixtures', 'fake-agent.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aska-test-'));
const run = (opts) => {
  const events = [];
  const h = runAgent({ bin: FAKE, argv: [], cwd: os.tmpdir(), env: { PATH: process.env.PATH }, ...opts }, (e) => events.push(e));
  return { h, events };
};
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
  assert.deepEqual(c.argv.slice(-2), ['--permission-mode', 'plan']);
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
  const bin = path.join(d, 'agentx');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(sec.resolveBinary(['agentx'], { envPath: d }).path, fs.realpathSync(bin));
  assert.ok(sec.resolveBinary(['agentx'], { envPath: '.:relative/dir' }).error);
  fs.chmodSync(bin, 0o777);
  assert.match(sec.resolveBinary(['agentx'], { envPath: d }).error, /modifiable par tous/);
  fs.chmodSync(bin, 0o755);
  fs.chmodSync(d, 0o777);
  assert.match(sec.resolveBinary(['agentx'], { envPath: d }).error, /modifiable par tous/);
  assert.match(sec.resolveBinary(['x'], { override: 'relative/x' }).error, /absolu/);
});

test('dossier de travail : écriture refusée dans ~, / et les dossiers sensibles', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'proj'));
  fs.mkdirSync(path.join(home, '.ssh'));
  assert.ok(sec.checkWorkdir(home, 'read', home).path);
  assert.match(sec.checkWorkdir(home, 'edit', home).error, /dossier personnel/);
  assert.match(sec.checkWorkdir('/', 'edit', home).error, /racine/);
  assert.match(sec.checkWorkdir('/etc', 'auto', home).error, /système/);
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
  fs.chmodSync(f, 0o666);
  r = loadConfig(f);
  assert.equal(r.config.allowAutoMode, false);
  assert.match(r.warnings[0], /ignorée/);
  assert.equal(loadConfig(path.join(d, 'absent.json')).config.defaultMode, 'read');
});

test('confiance et journal : fichiers privés (0600)', () => {
  const d = tmp();
  const t = new sec.TrustStore(path.join(d, 'c', 'trusted.json'));
  assert.equal(t.isTrusted('/a/b'), false);
  t.add('/a/b');
  const t2 = new sec.TrustStore(path.join(d, 'c', 'trusted.json'));
  assert.ok(t2.isTrusted('/a/b/c') && !t2.isTrusted('/a/bc'));
  assert.equal(fs.statSync(path.join(d, 'c', 'trusted.json')).mode & 0o777, 0o600);
  const log = path.join(d, 's', 'history.jsonl');
  sec.appendAudit(log, { prompt: 'un' });
  sec.appendAudit(log, { prompt: 'deux' });
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
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
  const d = fs.realpathSync(tmp());
  const { h, events } = run({ argv: ['$(id)', '; ls'], stdin: 'salut "toi"', cwd: d, env: { PATH: process.env.PATH, FAKE_MODE: 'echo' } });
  const res = await h.done;
  assert.equal(res.ok, true);
  const got = JSON.parse(textOf(events));
  assert.deepEqual(got.args, ['$(id)', '; ls']);
  assert.equal(got.stdin, 'salut "toi"');
  assert.equal(got.cwd, d);
  assert.ok(!got.env.includes('HOME'));
});

test('exécution : flux stream-json de bout en bout', async () => {
  const { h, events } = run({ output: 'stream-json', stdin: 'deny', env: { PATH: process.env.PATH, FAKE_MODE: 'stream', FAKE_DELAY: '1' } });
  const res = await h.done;
  assert.equal(res.ok, true);
  assert.match(textOf(events), /^## Résumé[\s\S]*const ok = true;\n```\n$/);
  assert.equal(events.find((e) => e.type === 'denied').count, 2);
});

test('exécution : échec remonté avec stderr nettoyé', async () => {
  const { h } = run({ env: { PATH: process.env.PATH, FAKE_MODE: 'fail' } });
  const res = await h.done;
  assert.equal(res.ok, false);
  assert.equal(res.code, 3);
  assert.equal(res.stderrTail, 'auth error: not logged in');
});

test('exécution : délai dépassé → SIGKILL même si SIGTERM est ignoré', async () => {
  const { h } = run({ timeoutMs: 300, env: { PATH: process.env.PATH, FAKE_MODE: 'hang' } });
  const res = await h.done;
  assert.equal(res.reason, 'timeout');
  assert.equal(res.ok, false);
});

test('exécution : annulation et plafond de sortie', async () => {
  const a = run({ env: { PATH: process.env.PATH, FAKE_MODE: 'hang' } });
  setTimeout(() => a.h.cancel(), 200);
  assert.equal((await a.h.done).reason, 'cancel');
  const b = run({ maxBytes: 200000, env: { PATH: process.env.PATH, FAKE_MODE: 'flood' } });
  assert.equal((await b.h.done).reason, 'overflow');
});

test('exécution : binaire inexistant', async () => {
  const { h } = run({ bin: '/nonexistent/agent' });
  const res = await h.done;
  assert.equal(res.reason, 'spawn-error');
});
