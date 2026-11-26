'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadBots, recentEntries } = require('../src/main/bots');
const { resolveAgents } = require('../src/main/agents');
const { paths } = require('../src/main/config');
const sec = require('../src/main/security');
const i18n = require('../src/i18n');

i18n.setLanguage('en');

const POSIX = process.platform !== 'win32';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aska-bots-'));
const AGENTS = resolveAgents({}).agents;

/** Writes a bot folder; null leaves a file out, a string is written as is. */
function makeBot(root, id, json = { agent: 'claude' }, soul = 'You translate into English.', memory = null) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const put = (name, content) => {
    if (content === null) return;
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
  };
  put('bot.json', json);
  put('SOUL.md', soul);
  put('MEMORY.md', memory);
  return dir;
}

const load = (root, opts = {}) => loadBots(root, { agents: AGENTS, home: root, ...opts });
const warned = (r, re) => assert.ok(r.warnings.some((w) => re.test(w)), `expected a warning ${re}, got ${JSON.stringify(r.warnings)}`);

test('bots: a valid bot is loaded with its defaults', () => {
  const root = tmp();
  makeBot(root, 'trad', { agent: 'claude', label: '  Translator  ', description: 'Into English', model: 'haiku' }, '\uFEFF# Translator\nYou translate.\n');
  const r = load(root);
  assert.deepEqual(r.warnings, []);
  const b = r.bots.trad;
  assert.equal(b.label, 'Translator');
  assert.equal(b.description, 'Into English');
  assert.equal(b.agent, 'claude');
  assert.equal(b.model, 'haiku');
  assert.equal(b.color, require('../src/renderer/avatar').avatarColor('Translator', 0), 'color of the avatar by default');
  assert.equal(b.mode, 'read');
  assert.equal(b.maxMode, 'read', 'read-only by default');
  assert.equal(b.cwd, null);
  assert.equal(b.soul, '# Translator\nYou translate.', 'BOM and surrounding blanks removed');
  assert.equal(b.memory, '');
});

test('bots: missing folder, files, hidden entries and invalid names', () => {
  const root = tmp();
  assert.deepEqual(load(path.join(root, 'nope')), { bots: {}, warnings: [] }, 'no bots/ folder: no error');
  fs.writeFileSync(path.join(root, 'README.md'), 'not a bot');
  fs.writeFileSync(path.join(root, '.seeded'), '');
  fs.mkdirSync(path.join(root, '.hidden'));
  makeBot(root, 'Bad Name');
  makeBot(root, '9lives');
  const r = load(root);
  assert.deepEqual(r.bots, {});
  assert.equal(r.warnings.length, 2);
  warned(r, /invalid folder name "Bad Name"/);
  warned(r, /invalid folder name "9lives"/);
});

test('bots: bot.json missing or invalid, unknown or disabled agent', () => {
  const root = tmp();
  makeBot(root, 'nojson', null);
  makeBot(root, 'badjson', '{ "agent": ');
  makeBot(root, 'array', []);
  makeBot(root, 'noagent', { label: 'x' });
  makeBot(root, 'ghost', { agent: 'nope' });
  makeBot(root, 'off', { agent: 'claude', enabled: false });
  makeBot(root, 'cdx', { agent: 'codex' });
  const r = load(root, { agents: resolveAgents({ codex: { enabled: false } }).agents });
  assert.deepEqual(Object.keys(r.bots), []);
  warned(r, /"nojson" ignored: bot.json is missing/);
  warned(r, /"badjson": .*invalid JSON/);
  warned(r, /"array" ignored: bot.json must contain an object/);
  warned(r, /"noagent" ignored: unknown or disabled agent ""/);
  warned(r, /"ghost" ignored: unknown or disabled agent "nope"/);
  warned(r, /"cdx" ignored: unknown or disabled agent "codex"/);
  assert.ok(!r.warnings.some((w) => w.includes('"off"')), 'enabled: false is silent');
});

test('bots: mode capped by maxMode, auto only when allowed and never at startup', () => {
  const root = tmp();
  makeBot(root, 'above', { agent: 'claude', mode: 'edit' });
  makeBot(root, 'auto', { agent: 'claude', mode: 'auto', maxMode: 'auto' });
  makeBot(root, 'editor', { agent: 'claude', mode: 'edit', maxMode: 'edit' });
  makeBot(root, 'cursor', { agent: 'cursor', mode: 'edit', maxMode: 'edit' });
  makeBot(root, 'junk', { agent: 'claude', mode: 'bypass', maxMode: 'all' });
  let r = load(root);
  assert.equal(r.bots.above.mode, 'read');
  warned(r, /"above": mode "edit" above maxMode "read"/);
  assert.equal(r.bots.auto.maxMode, 'edit');
  assert.equal(r.bots.auto.mode, 'edit');
  warned(r, /"auto": maxMode "auto" requires "allowAutoMode"/);
  warned(r, /"auto": mode "auto" rejected at startup/);
  assert.equal(r.bots.editor.mode, 'edit');
  assert.equal(r.bots.cursor.mode, 'read', 'Cursor has no "edit" mode: the one below');
  assert.equal(r.bots.junk.mode, 'read');
  assert.equal(r.bots.junk.maxMode, 'read');
  warned(r, /"junk": "mode" ignored/);
  warned(r, /"junk": "maxMode" ignored/);

  r = load(root, { allowAutoMode: true });
  assert.equal(r.bots.auto.maxMode, 'auto');
  assert.equal(r.bots.auto.mode, 'edit', 'still never auto at startup');
});

test('bots: SOUL.md limits, never cut silently', () => {
  const root = tmp();
  makeBot(root, 'ok', undefined, 'x'.repeat(4000));
  makeBot(root, 'long', undefined, 'x'.repeat(4001));
  makeBot(root, 'huge', undefined, 'x'.repeat(8001));
  makeBot(root, 'nosoul', undefined, null);
  makeBot(root, 'nul', undefined, 'a\0b');
  const r = load(root);
  assert.deepEqual(Object.keys(r.bots).sort(), ['long', 'ok']);
  assert.equal(r.bots.long.soul.length, 4001);
  warned(r, /"long": SOUL.md is 4001 characters long/);
  warned(r, /"huge" ignored: SOUL.md is 8001 characters long, 8000 at most/);
  warned(r, /"nosoul" ignored: SOUL.md is missing/);
  warned(r, /"nul": SOUL.md contains an invalid character/);
  assert.ok(!r.warnings.some((w) => w.includes('"ok"')));
});

test('bots: MEMORY.md keeps the most recent entries, with a warning', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `- 2026-11-${String(i).padStart(3, '0')} entry ${'y'.repeat(40)}`);
  const root = tmp();
  makeBot(root, 'mem', undefined, 'soul', lines.join('\n'));
  makeBot(root, 'small', undefined, 'soul', '- one\n- two\n');
  makeBot(root, 'nul', undefined, 'soul', 'a\0b');
  const r = load(root);
  const kept = r.bots.mem.memory;
  assert.ok(kept.length <= 6000 && kept.length > 5000);
  assert.ok(kept.endsWith(lines[199]), 'the end of the file (newest) is kept');
  assert.ok(!kept.includes(lines[0]));
  assert.ok(kept.split('\n').every((l) => lines.includes(l)), 'whole lines only');
  warned(r, /"mem": MEMORY.md is longer than 6000 characters/);
  assert.equal(r.bots.small.memory, '- one\n- two');
  assert.equal(r.bots.nul.memory, '', 'an unreadable memory is left out, the bot still loads');
  warned(r, /"nul": MEMORY.md contains an invalid character/);

  assert.deepEqual(recentEntries('a\nb', 10), { text: 'a\nb', cut: false });
  assert.deepEqual(recentEntries('aaaa\nbb\ncc', 6), { text: 'bb\ncc', cut: true });
});

test('bots: files writable by others are refused (POSIX)', { skip: !POSIX && 'no POSIX permissions on Windows' }, () => {
  const root = tmp();
  fs.chmodSync(path.join(makeBot(root, 'soulw'), 'SOUL.md'), 0o620);
  fs.chmodSync(path.join(makeBot(root, 'jsonw'), 'bot.json'), 0o602);
  fs.chmodSync(path.join(makeBot(root, 'memw', undefined, 'soul', '- note'), 'MEMORY.md'), 0o660);
  const r = load(root);
  assert.deepEqual(Object.keys(r.bots), ['memw']);
  assert.equal(r.bots.memw.memory, '', 'memory writable by others: left out');
  warned(r, /"soulw": .*SOUL.md is writable by other users/);
  warned(r, /"jsonw": .*bot.json is writable by other users/);
  warned(r, /"memw": .*MEMORY.md is writable by other users/);
});

test('bots: working folder, avatar, later fields and unknown keys', () => {
  const root = tmp();
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  makeBot(root, 'dev', {
    agent: 'claude',
    maxMode: 'edit',
    cwd: proj,
    color: '#4285F4',
    avatar: { variant: 3, shape: 'dome', emblem: 'translation' },
    shortcut: 'Control+Alt+T',
    starters: ['Hello'],
    output: { autoCopy: true },
    fallbackAgent: 'codex',
    somethingNew: 1,
  });
  makeBot(root, 'rel', { agent: 'claude', cwd: 'proj', color: 'blue', avatar: { variant: -1, shape: '<svg>', emblem: 'x'.repeat(40) } });
  makeBot(root, 'gone', { agent: 'claude', cwd: path.join(root, 'missing') });
  makeBot(root, 'home', { agent: 'claude', maxMode: 'edit', cwd: root });
  const r = load(root);
  const dev = r.bots.dev;
  assert.equal(dev.cwd, fs.realpathSync(proj));
  assert.equal(dev.color, '#4285F4');
  assert.deepEqual(dev.avatar, { variant: 3, shape: 'dome', emblem: 'translation' });
  assert.ok(!r.warnings.some((w) => w.includes('"dev"')), 'later fields and unknown keys: no warning');
  assert.equal(r.bots.rel.cwd, null);
  assert.deepEqual(r.bots.rel.avatar, {});
  for (const f of ['cwd', 'color', 'avatar.variant', 'avatar.shape', 'avatar.emblem']) warned(r, new RegExp(`"rel": "${f.replace('.', '\\.')}" ignored`));
  assert.equal(r.bots.gone.cwd, null);
  warned(r, /"gone": folder ignored \(Folder not found/);
  assert.equal(r.bots.home.cwd, null, 'write mode: the whole home folder is refused');
  warned(r, /"home": folder ignored \(Writing refused in your entire home folder/);
});

test('bots: ~/.aska is a sensitive folder, and paths().bots', () => {
  const home = tmp();
  const dir = path.join(home, '.aska', 'bots', 'trad');
  fs.mkdirSync(dir, { recursive: true });
  assert.match(sec.checkWorkdir(dir, 'edit', home).error, /sensitive/);
  assert.match(sec.checkWorkdir(path.join(home, '.aska'), 'auto', home).error, /sensitive/);
  assert.ok(sec.checkWorkdir(dir, 'read', home).path, 'reading stays allowed');
  assert.equal(paths({}, '/home/me', 'linux').bots, path.join('/home/me', '.aska', 'bots'));
  assert.equal(paths({ APPDATA: 'C:\\x' }, 'C:\\Users\\me', 'win32').bots, path.join('C:\\Users\\me', '.aska', 'bots'));
});

test('readOwnedText: BOM, size limit, folder', () => {
  const d = tmp();
  const f = path.join(d, 'a.md');
  fs.writeFileSync(f, '\uFEFFhello', { mode: 0o600 });
  assert.deepEqual(sec.readOwnedText(f), { text: 'hello' });
  assert.match(sec.readOwnedText(f, 4).error, /too big/);
  assert.deepEqual(sec.readOwnedText(path.join(d, 'none')), { missing: true });
  const sub = path.join(d, 'sub');
  fs.mkdirSync(sub);
  const r = sec.readOwnedText(sub);
  assert.ok(r.missing || /not a file/.test(r.error), 'a folder is never read as a file');
  // readOwnedJson still works on top of it.
  fs.writeFileSync(path.join(d, 'a.json'), '\uFEFF{"ok":true}', { mode: 0o600 });
  assert.deepEqual(sec.readOwnedJson(path.join(d, 'a.json')), { data: { ok: true } });
});

// ---------- personality injection (ticket 03) ----------

const { buildInvocation } = require('../src/main/agents');
const { buildContextPrompt } = require('../src/main/conversations');
const { systemText, botBlock, fingerprint, invocationFor } = require('../src/main/bots');

const BOT = { id: 'trad', label: 'Translator', agent: 'claude', soul: 'You translate into English.', memory: '' };
const TURNS = [{ prompt: 'Bonjour', answer: 'Hello', agent: 'claude', label: 'Claude', bot: 'trad', botLabel: 'Translator' }];

test('personality: system prompt option for Claude, never in the audit log', () => {
  const inv = buildInvocation(AGENTS.claude, 'read', 'hi', { system: 'Be brief.', model: 'haiku' });
  const at = inv.argv.indexOf('--append-system-prompt');
  assert.ok(at > 0);
  assert.equal(inv.argv[at + 1], 'Be brief.');
  assert.equal(inv.stdin, 'hi');
  assert.equal(inv.logArgv[at + 1], '<system>');
  assert.ok(!inv.logArgv.includes('Be brief.'));
  // Codex has no such option: refused rather than silently dropped.
  assert.throws(() => buildInvocation(AGENTS.codex, 'read', 'hi', { system: 'x' }), /Invalid prompt/);
  assert.throws(() => buildInvocation(AGENTS.claude, 'read', 'hi', { system: 'a\0b' }), /Invalid prompt/);
});

test('personality: a custom agent may declare its option, never a dangerous one', () => {
  const base = { bin: '/x', modes: { read: [] } };
  const { agents } = resolveAgents({ a: { ...base, systemFlag: '--system' }, b: { ...base, systemFlag: '--dangerously-skip-permissions' }, c: { ...base, systemFlag: 'rm' } });
  assert.equal(agents.a.systemFlag, '--system');
  assert.equal(agents.b.systemFlag, undefined);
  assert.equal(agents.c.systemFlag, undefined);
});

test('personality: text, block and fingerprint', () => {
  assert.match(systemText(BOT), /^You are "Translator"[\s\S]*You translate into English\.$/);
  assert.ok(!systemText(BOT).includes('remember'), 'no memory: no memory section');
  const withMemory = { ...BOT, memory: '- prefers British spelling' };
  assert.match(systemText(withMemory), /You translate into English\.\n\nWhat the user asked you to remember[\s\S]*- prefers British spelling$/);
  assert.match(botBlock({ ...BOT, label: 'A"<b>' }), /^<bot name="Ab">\n[\s\S]*\n<\/bot>$/);
  assert.equal(fingerprint('x'), fingerprint('x'));
  assert.notEqual(fingerprint(systemText(BOT)), fingerprint(systemText(withMemory)), 'memory changes the fingerprint');
  assert.notEqual(fingerprint(systemText(BOT)), fingerprint(systemText({ ...BOT, soul: 'Other.' })), 'SOUL changes the fingerprint');
  assert.match(fingerprint('x'), /^[0-9a-f]{16}$/);
});

test('personality: order is bot, then history, then request; turns labelled with the bot', () => {
  const p = buildContextPrompt(TURNS, 'Merci', 24000, '<bot name="T">x</bot>');
  assert.match(p, /^<bot name="T">x<\/bot>\n\nHere is the history[\s\S]*\[Assistant: Translator\]\nHello[\s\S]*<\/history>[\s\S]*New request from the user:\nMerci$/);
  assert.equal(buildContextPrompt(TURNS, 'Merci', 0, 'P'), 'P\n\nMerci', 'no room for history: personality and request');
  assert.equal(buildContextPrompt([], 'Merci', 24000, 'P'), 'P\n\nMerci');
  assert.equal(buildContextPrompt([], 'Merci'), 'Merci', 'no bot: unchanged');
});

test('personality: system prompt when possible, else before the prompt', () => {
  const req = { mode: 'read', prompt: 'Merci', turns: TURNS, bot: BOT };
  // Claude: system prompt; the history stays in the prompt.
  let inv = invocationFor({ ...req, agent: AGENTS.claude });
  assert.ok(inv.argv.includes('--append-system-prompt'));
  assert.ok(!inv.stdin.includes('<bot'));
  assert.match(inv.stdin, /<history>[\s\S]*Merci$/);
  // Codex, Copilot, Cursor: block before the history.
  for (const id of ['codex', 'copilot', 'cursor']) {
    inv = invocationFor({ ...req, agent: AGENTS[id] });
    const text = inv.stdin || inv.argv.find((a) => a.includes('Merci'));
    assert.match(text, /^<bot name="Translator">\nYou are "Translator"[\s\S]*<\/bot>\n\nHere is the history[\s\S]*Merci$/, id);
    assert.ok(!inv.argv.includes('--append-system-prompt'), id);
  }
  // cmd.exe launcher (no argument with spaces): before the prompt.
  inv = invocationFor({ ...req, agent: AGENTS.claude, canPass: () => false });
  assert.ok(!inv.argv.includes('--append-system-prompt'));
  assert.match(inv.stdin, /^<bot name="Translator">/);
  // Personality too long for the command line: before the prompt (stdin has no limit).
  inv = invocationFor({ ...req, agent: AGENTS.claude, excess: (i) => (i.argv.includes('--append-system-prompt') ? 10 : 0) });
  assert.ok(!inv.argv.includes('--append-system-prompt'));
  assert.match(inv.stdin, /^<bot name="Translator">/);
  // Resumed session: it already has the personality and the history.
  inv = invocationFor({ ...req, agent: AGENTS.claude, resume: 'abcdef12-3456' });
  assert.equal(inv.stdin, 'Merci');
  assert.ok(inv.argv.includes('--resume'));
  // No bot: exactly as before.
  assert.deepEqual(invocationFor({ ...req, bot: null, agent: AGENTS.codex }), buildInvocation(AGENTS.codex, 'read', buildContextPrompt(TURNS, 'Merci'), { trusted: true }));
});

// ---------- "@name" in the field (ticket 04) ----------

const { parse, suggest } = require('../src/renderer/commands');

const CTX = {
  bots: [
    { id: 'trad', label: 'Translator', description: 'Into English' },
    { id: 'review', label: 'Reviewer', description: '' },
  ],
  agents: [{ id: 'claude', label: 'Claude' }],
};

test('@name: parsed at the start of the message only', () => {
  assert.deepEqual(parse('@trad bonjour à tous', CTX), { kind: 'bot', botId: 'trad', rest: 'bonjour à tous' });
  assert.deepEqual(parse('@TRAD\nline 2', CTX), { kind: 'bot', botId: 'trad', rest: 'line 2' });
  assert.deepEqual(parse('@trad', CTX), { kind: 'bot', botId: 'trad', rest: '' });
  assert.deepEqual(parse('  @  ', CTX), { kind: 'bot', botId: null, rest: '' }, '"@" alone leaves the bot');
  assert.deepEqual(parse('@@trad hi', CTX), { kind: 'send', text: '@trad hi' });
  assert.deepEqual(parse('@nope hi', CTX), { kind: 'unknownBot', name: 'nope' });
  assert.deepEqual(parse('write to mail@example.org', CTX), { kind: 'send', text: 'write to mail@example.org' });
  assert.deepEqual(parse('@trad, hi', CTX), { kind: 'send', text: '@trad, hi' });
  assert.deepEqual(parse('@ hi', CTX), { kind: 'send', text: '@ hi' });
  assert.deepEqual(parse('@trad', {}), { kind: 'unknownBot', name: 'trad' }, 'no bots loaded');
  // "/" commands are unchanged.
  assert.deepEqual(parse('/claude hi', CTX), { kind: 'agent', agentId: 'claude', rest: 'hi' });
});

test('@name: suggestions by prefix of the id or the label, then "no bot"', () => {
  assert.deepEqual(suggest('@', CTX).map((i) => i.line), ['@trad', '@review']);
  assert.deepEqual(suggest('@', { ...CTX, bot: 'trad' }).map((i) => i.line), ['@', '@trad', '@review'], '"no bot" first when a bot is on: "@" then Enter leaves it');
  assert.equal(suggest('@', { ...CTX, bot: 'trad' })[0].none, true);
  assert.deepEqual(suggest('@tr', CTX).map((i) => i.line), ['@trad']);
  assert.deepEqual(suggest('@Rev', CTX).map((i) => i.line), ['@review'], 'case-insensitive, by label too');
  assert.deepEqual(suggest('@x', CTX), []);
  const it = suggest('@tr', CTX)[0];
  assert.deepEqual([it.name, it.label, it.text, it.bot, it.done, it.arg], ['trad', 'Translator', 'Into English', true, true, 'message']);
  assert.equal(suggest('@trad hello', CTX), null, 'typing the message: no palette');
  assert.equal(suggest('@tr\nx', CTX), null);
  assert.equal(suggest('@@tr', CTX), null);
  assert.equal(suggest('hello @tr', CTX), null);
});

// ---------- generated avatars (ticket 05) ----------

const AV = require('../src/renderer/avatar');

/** Minimal XML check: every tag is closed in order, attributes are quoted. */
function wellFormed(xml) {
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g;
  let last = 0;
  let m;
  while ((m = tagRe.exec(xml))) {
    if (/[<>]/.test(xml.slice(last, m.index))) return false; // stray < or > between tags
    last = tagRe.lastIndex;
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else if (!m[4]) stack.push(m[2]);
  }
  return stack.length === 0 && !/[<>]/.test(xml.slice(last));
}

test('avatars: same name and variant, same SVG; another variant, another one', () => {
  assert.equal(AV.avatar('Translator'), AV.avatar('Translator'));
  const drawing = (svg) => svg.replace(/aria-label="[^"]*"/, '');
  assert.equal(drawing(AV.avatar('Traducteur', { variant: 2 })), drawing(AV.avatar('traducteur ', { variant: 2 })), 'same robot whatever the case and spaces');
  assert.notEqual(AV.avatar('Translator', { variant: 0 }), AV.avatar('Translator', { variant: 1 }));
  assert.notEqual(AV.avatar('Translator'), AV.avatar('Reviewer'));
  assert.equal(AV.avatarDataUrl('Translator'), AV.avatarDataUrl('Translator'));
  assert.match(AV.avatarDataUrl('Translator'), /^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  assert.match(AV.avatarColor('Translator', 0), /^#[0-9a-f]{6}$/);
  assert.notEqual(AV.avatarColor('Translator', 0), undefined);
});

test('avatars: every shape, variant and emblem gives a small, well-formed, script-free SVG', () => {
  let max = 0;
  for (const shape of AV.SHAPES) {
    for (let variant = 0; variant < 30; variant++) {
      for (const emblem of ['auto', 'none', ...AV.EMBLEMS]) {
        for (const animate of [false, true]) {
          const svg = AV.avatar('Bot ' + variant, { shape, variant, emblem, animate });
          max = Math.max(max, Buffer.byteLength(svg));
          assert.ok(wellFormed(svg), `${shape}/${variant}/${emblem}`);
          assert.ok(!/<script|\son\w+=|href="(?!#)|javascript:|<foreignObject/i.test(svg), `${shape}/${variant}/${emblem}`);
        }
      }
    }
  }
  assert.ok(max < 6 * 1024, `largest avatar: ${max} bytes`);
});

test('avatars: name escaped, emblem guessed or initial, no badge at small sizes', () => {
  const svg = AV.avatar('A<b>"&\'x', { emblem: 'none' });
  assert.ok(wellFormed(svg));
  assert.match(svg, /aria-label="A&lt;b&gt;&quot;&amp;'x"/);
  assert.equal(AV.guessEmblem('Traducteur'), 'translation');
  assert.equal(AV.guessEmblem('Code reviewer'), 'search');
  assert.equal(AV.guessEmblem('Écrivain'), 'pen', 'accents ignored');
  assert.equal(AV.guessEmblem('Zorglub'), null);
  assert.match(AV.avatar('Zorglub'), /class="ini">Z<\/text>/, 'no known job: the initial');
  assert.match(AV.avatar('Traducteur'), /class="em"/);
  assert.ok(!AV.avatar('Traducteur', { badge: false }).includes('class="bd"'), 'no badge');
  assert.ok(!AV.avatar('Traducteur', { emblem: 'none' }).includes('class="bd"'));
  assert.ok(AV.avatar('Zorglub', { emblem: 'chef' }).includes('class="em"'), 'emblem fixed in bot.json');
  assert.ok(!AV.avatar('Zorglub').includes('<animate'), 'still by default');
  assert.ok(AV.avatar('Zorglub', { animate: true }).includes('<animate'));
  // An unknown shape falls back to the one drawn from the name.
  assert.equal(AV.avatar('Zorglub', { shape: 'nope' }), AV.avatar('Zorglub'));
});
