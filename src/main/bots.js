'use strict';
// Custom bots: one folder per bot in ~/.aska/bots/<id>/ (bot.json, SOUL.md,
// MEMORY.md). Read once at startup and on reload, never when the window opens.
// A bot is a preset (agent, model, modes, folder) plus a personality; it never
// goes beyond what the agent and the config allow.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readOwnedJson, readOwnedText, readOwnedFile, checkWorkdir, writePrivate, ensurePrivateDir } = require('./security');
const { MODE_ORDER, isModel, buildInvocation, fitInvocation } = require('./agents');
const { avatarColor, SHAPES, EMBLEMS } = require('../renderer/avatar');
const { buildContextPrompt, HISTORY_CHARS } = require('./conversations');
const { t } = require('../i18n');

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/; // same rule as the agents
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const SOUL_WARN = 4000; // characters: longer works, but costs on every request
const SOUL_MAX = 8000; // characters: beyond, the bot is refused
const MEMORY_MAX = 6000; // characters injected from MEMORY.md
const FILE_MAX = 256 * 1024; // bytes read at most from SOUL.md or MEMORY.md
const MAX_BOTS = 50;
// Fields of later versions (shortcut, starters, output, fallbackAgent) and
// unknown keys are accepted and ignored: a bot.json written for a newer Aska still loads.

const rank = (m) => MODE_ORDER.indexOf(m);

/**
 * Keeps the most recent entries of MEMORY.md that fit in max characters.
 * Entries are lines, added at the end of the file: the end is kept, whole lines only.
 */
function recentEntries(text, max = MEMORY_MAX) {
  if (text.length <= max) return { text, cut: false };
  const lines = text.split('\n');
  const kept = [];
  let n = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (n + lines[i].length + 1 > max) break;
    kept.unshift(lines[i]);
    n += lines[i].length + 1;
  }
  return { text: kept.join('\n'), cut: true };
}

/** Reads and checks one bot. Returns { bot } or {} (refused, with a warning). */
function loadBot(dir, id, { agents, allowAutoMode, home }, warn) {
  const refuse = (key, vars) => {
    warn(key, vars);
    return {};
  };
  const j = readOwnedJson(path.join(dir, 'bot.json'));
  if (j.missing) return refuse('missingJson');
  if (j.error) return refuse('fileError', { error: j.error });
  const u = j.data;
  if (!u || typeof u !== 'object' || Array.isArray(u)) return refuse('notAnObject');
  if (u.enabled === false) return {};
  const bad = (field) => warn('badField', { field });

  const agent = typeof u.agent === 'string' && Object.hasOwn(agents, u.agent) ? agents[u.agent] : null;
  if (!agent) return refuse('unknownAgent', { agent: String(u.agent ?? '') });

  const bot = {
    id,
    dir,
    agent: agent.id,
    label: typeof u.label === 'string' && u.label.trim() ? u.label.trim().slice(0, 24) : id,
    description: typeof u.description === 'string' ? u.description.trim().slice(0, 120) : '',
    color: COLOR_RE.test(u.color || '') ? u.color : null, // none: the avatar's (below)
    model: undefined,
    mode: 'read',
    maxMode: 'read',
    cwd: null,
    avatar: {},
    soul: '',
    memory: '',
  };
  if (u.color !== undefined && u.color !== null && bot.color !== u.color) bad('color');
  if (u.model !== undefined) {
    if (u.model === null || isModel(u.model)) bot.model = u.model;
    else bad('model');
  }

  // Modes: maxMode caps /mode; auto only if the config allows it, and never at startup.
  if (u.maxMode !== undefined) {
    if (!MODE_ORDER.includes(u.maxMode)) bad('maxMode');
    else if (u.maxMode === 'auto' && !allowAutoMode) {
      warn('autoNotAllowed');
      bot.maxMode = 'edit';
    } else bot.maxMode = u.maxMode;
  }
  if (u.mode !== undefined) {
    if (!MODE_ORDER.includes(u.mode)) bad('mode');
    else if (u.mode === 'auto') {
      warn('autoAtStart');
      bot.mode = 'edit';
    } else bot.mode = u.mode;
  }
  if (rank(bot.mode) > rank(bot.maxMode)) {
    warn('modeAboveMax', { mode: bot.mode, max: bot.maxMode });
    bot.mode = bot.maxMode;
  }
  // A mode the agent does not offer (Cursor has no "edit"): the closest one below.
  if (!agent.modes[bot.mode]) {
    const below = MODE_ORDER.slice(0, rank(bot.mode) + 1).filter((m) => agent.modes[m]).pop();
    if (!below) return refuse('noMode', { agent: agent.label, mode: bot.mode });
    bot.mode = below;
  }

  if (u.cwd !== undefined && u.cwd !== null) {
    if (typeof u.cwd !== 'string' || !path.isAbsolute(u.cwd)) bad('cwd');
    else {
      // Checked for the highest mode the bot can reach.
      const w = checkWorkdir(u.cwd, bot.maxMode, home);
      if (w.error) warn('badCwd', { error: w.error });
      else bot.cwd = w.path;
    }
  }

  if (u.avatar !== undefined) {
    const a = u.avatar;
    if (!a || typeof a !== 'object' || Array.isArray(a)) bad('avatar');
    else {
      if (Number.isInteger(a.variant) && a.variant >= 0 && a.variant < 10000) bot.avatar.variant = a.variant;
      else if (a.variant !== undefined) bad('avatar.variant');
      if (a.shape === 'auto' || SHAPES.includes(a.shape)) bot.avatar.shape = a.shape;
      else if (a.shape !== undefined) bad('avatar.shape');
      if (a.emblem === 'auto' || a.emblem === 'none' || EMBLEMS.includes(a.emblem)) bot.avatar.emblem = a.emblem;
      else if (a.emblem !== undefined) bad('avatar.emblem');
    }
  }
  // No color in bot.json: the neon of its avatar.
  if (!bot.color) bot.color = avatarColor(bot.label, bot.avatar.variant || 0);
  // Picture added by hand (avatar.png or avatar.svg), read once here: replaces the generated robot.
  bot.image = avatarImage(dir, warn);

  // SOUL.md: required; too long refuses the bot (never cut silently).
  const s = readOwnedText(path.join(dir, 'SOUL.md'), FILE_MAX);
  if (s.missing) return refuse('missingSoul');
  if (s.error) return refuse('fileError', { error: s.error });
  if (s.text.includes('\0')) return refuse('invalidText', { file: 'SOUL.md' });
  bot.soul = s.text.trim();
  if (bot.soul.length > SOUL_MAX) return refuse('soulTooLong', { length: bot.soul.length, max: SOUL_MAX });
  if (bot.soul.length > SOUL_WARN) warn('soulLong', { length: bot.soul.length, max: SOUL_WARN });

  // MEMORY.md: optional; a file that cannot be trusted is left out, the bot still works.
  const m = readOwnedText(path.join(dir, 'MEMORY.md'), FILE_MAX);
  if (m.error) warn('fileError', { error: m.error });
  else if (m.text !== undefined) {
    if (m.text.includes('\0')) warn('invalidText', { file: 'MEMORY.md' });
    else {
      const r = recentEntries(m.text.trim());
      bot.memory = r.text;
      if (r.cut) warn('memoryCut', { max: MEMORY_MAX });
    }
  }
  return { bot };
}

/**
 * Loads every bot of dir. agents: the resolved agents (a bot's agent must
 * exist and be enabled). A missing folder is not an error.
 * Returns { bots: { id: bot }, warnings }.
 */
function loadBots(dir, { agents = {}, allowAutoMode = false, home = os.homedir() } = {}) {
  const bots = {};
  const warnings = [];
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort();
  } catch {
    return { bots, warnings };
  }
  for (const id of entries) {
    const botDir = path.join(dir, id);
    try {
      if (!fs.statSync(botDir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!ID_RE.test(id)) {
      warnings.push(t('bots.invalidId', { id }));
      continue;
    }
    if (Object.keys(bots).length >= MAX_BOTS) {
      warnings.push(t('bots.tooMany', { max: MAX_BOTS }));
      break;
    }
    const warn = (key, vars = {}) => {
      warnings.push(t(`bots.${key}`, { id, ...vars }));
    };
    const r = loadBot(botDir, id, { agents, allowAutoMode, home }, warn);
    if (r.bot) bots[id] = r.bot;
  }
  return { bots, warnings };
}

// ---------- avatar added by hand (avatar.png or avatar.svg in the bot's folder) ----------

const SVG_MAX = 64 * 1024;
const IMAGE_MAX = 10 * 1024 * 1024; // source picture before resizing
const PNG_MAX = 512 * 1024; // avatar.png once resized (128 px)
const AVATAR_PX = 128;

/**
 * Cleans an SVG chosen by the user. It is only ever shown as <img src="data:">,
 * where an SVG runs no script and loads nothing; this is a second line of
 * defense: scripts, event handlers, foreign content, external links and
 * resources, entity declarations and animations of links are removed.
 * Returns { svg } or { error }.
 */
function sanitizeSvg(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > SVG_MAX) return { error: t('bots.avatarTooBig', { max: SVG_MAX / 1024 }) };
  if (text.includes('\0')) return { error: t('bots.avatarNotImage') };
  let s = text.replace(/^\uFEFF/, '');
  for (let i = 0, before = ''; i < 6 && s !== before; i++) {
    before = s;
    s = s
      .replace(/<\?[\s\S]*?\?>/g, '') // XML declaration and processing instructions
      .replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, '') // DOCTYPE and its entities
      .replace(/<!ENTITY[\s\S]*?>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|foreignObject|iframe|object|embed|audio|video|handler|listener)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(script|foreignObject|iframe|object|embed|audio|video|handler|listener|set)\b[^>]*>/gi, '')
      .replace(/<\/(script|foreignObject|iframe|object|embed|audio|video|handler|listener|set)\s*>/gi, '')
      .replace(/<animate\w*\b[^>]*attributeName\s*=\s*["']?(?:xlink:)?href[\s\S]*?(\/>|<\/animate\w*\s*>)/gi, '')
      // event handlers: onload=, onclick=…
      .replace(/\s+on[\w-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      // links and resources: only to the document itself (#id)
      .replace(/\s+(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*'|(?!["'#])[^\s>]+)/gi, '')
      .replace(/url\((?![\s'"]*#)[^)]*\)/gi, 'none')
      .replace(/@import[^;]*;?/gi, '')
      .replace(/javascript:/gi, '');
  }
  s = s.trim();
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg\s*>$/i.test(s)) return { error: t('bots.avatarNotImage') };
  return { svg: s };
}

/** Image added by hand, as a data URL, or null (the generated avatar). */
function avatarImage(dir, warn) {
  const png = readOwnedFile(path.join(dir, 'avatar.png'), PNG_MAX);
  if (png.data) return 'data:image/png;base64,' + png.data.toString('base64');
  if (png.error) warn('fileError', { error: png.error });
  const svg = readOwnedFile(path.join(dir, 'avatar.svg'), SVG_MAX);
  if (svg.error) warn('fileError', { error: svg.error });
  if (!svg.data) return null;
  const clean = sanitizeSvg(svg.data.toString('utf8'));
  if (clean.error) {
    warn('fileError', { error: clean.error });
    return null;
  }
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(clean.svg);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);
const WEBP = (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
const GIF = (b) => b.toString('latin1', 0, 4) === 'GIF8';

/**
 * Imports a picture chosen by the user as the bot's avatar. The kind comes from
 * the content, not the extension. A PNG, JPEG, WebP or GIF is cropped to a
 * square and resized to 128 px by nativeImage (Electron), saved as avatar.png;
 * an SVG is cleaned (sanitizeSvg) and saved as avatar.svg. The other one is removed.
 * Returns {} or { error }.
 */
function importAvatar(botDir, file, { nativeImage }) {
  let buf;
  try {
    if (fs.statSync(file).size > IMAGE_MAX) return { error: t('bots.avatarTooBig', { max: IMAGE_MAX / 1024 }) };
    buf = fs.readFileSync(file);
  } catch (e) {
    return { error: e.message };
  }
  const raster = buf.subarray(0, 4).equals(PNG_SIG) || buf.subarray(0, 3).equals(JPEG_SIG) || WEBP(buf) || GIF(buf);
  try {
    if (raster) {
      let img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return { error: t('bots.avatarNotImage') };
      const { width, height } = img.getSize();
      const side = Math.min(width, height);
      img = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
      if (side > AVATAR_PX) img = img.resize({ width: AVATAR_PX, height: AVATAR_PX, quality: 'best' });
      writePrivate(path.join(botDir, 'avatar.png'), img.toPNG());
      fs.rmSync(path.join(botDir, 'avatar.svg'), { force: true });
      return {};
    }
    const clean = sanitizeSvg(buf.toString('utf8'));
    if (clean.error) return clean;
    writePrivate(path.join(botDir, 'avatar.svg'), clean.svg);
    fs.rmSync(path.join(botDir, 'avatar.png'), { force: true });
    return {};
  } catch (e) {
    return { error: e.message };
  }
}

/** Back to the generated avatar. */
function clearAvatar(botDir) {
  for (const f of ['avatar.png', 'avatar.svg']) fs.rmSync(path.join(botDir, f), { force: true });
}

const EXAMPLES = path.join(__dirname, '..', '..', 'assets', 'bots');
const SEEDED = '.seeded';

/**
 * Copies the example bots into dir, once (marker file ".seeded"), in the
 * interface's language, for the default agent. Never overwrites a folder that
 * exists, and does nothing once done: a bot deleted by the user stays deleted,
 * and an update of Aska never touches them.
 * Returns the ids copied ([] when nothing was done).
 */
function seedBots(dir, { lang = 'en', agent = 'claude', source = EXAMPLES } = {}) {
  if (fs.existsSync(path.join(dir, SEEDED))) return [];
  const from = fs.existsSync(path.join(source, lang)) ? path.join(source, lang) : path.join(source, 'en');
  const copied = [];
  let ids = [];
  try {
    ids = fs.readdirSync(from).filter((id) => ID_RE.test(id));
  } catch {
    return copied; // no examples (partial install): nothing to copy
  }
  try {
    ensurePrivateDir(dir);
    for (const id of ids) {
      const target = path.join(dir, id);
      if (fs.existsSync(target)) continue;
      const json = JSON.parse(fs.readFileSync(path.join(from, id, 'bot.json'), 'utf8'));
      writePrivate(path.join(target, 'bot.json'), JSON.stringify({ ...json, agent }, null, 2) + '\n');
      writePrivate(path.join(target, 'SOUL.md'), fs.readFileSync(path.join(from, id, 'SOUL.md'), 'utf8'));
      copied.push(id);
    }
    writePrivate(path.join(dir, SEEDED), `${new Date().toISOString()}\n`);
  } catch { /* read-only home…: the bots are optional, Aska starts anyway */ }
  return copied;
}

/**
 * What a bot adds to each request: its personality, then its memory. The same
 * text goes into the system prompt (agent with systemFlag) or before the prompt.
 */
function systemText(bot) {
  const parts = [`You are "${bot.label}", an assistant set up by the user. Follow these instructions:`, '', bot.soul];
  if (bot.memory) parts.push('', 'What the user asked you to remember (oldest first):', '', bot.memory);
  return parts.join('\n');
}

/** Agent without systemFlag: the personality as a block, before the history and the request. */
function botBlock(bot) {
  return `<bot name="${bot.label.replace(/[<>"&]/g, '')}">\n${systemText(bot)}\n</bot>`;
}

/**
 * Builds a request's invocation, with the bot's personality if there is one.
 * It goes into the system prompt when the CLI has an option for it (systemFlag);
 * otherwise (no option, cmd.exe launcher, command line too long) as a block
 * before the history and the request. A resumed session already has it.
 * excess(inv): how far the command goes beyond the system's limit (see fitInvocation);
 * canPass(args): whether these arguments can be passed at all.
 */
function invocationFor({ agent, mode, prompt, turns, bot = null, model, resume = null, excess = () => 0, canPass = () => true }) {
  const persona = bot ? systemText(bot) : '';
  const build = (asSystem) => (maxChars) => {
    const preamble = persona && !asSystem && !resume ? botBlock(bot) : '';
    const text = resume ? prompt : buildContextPrompt(turns, prompt, maxChars, preamble);
    return buildInvocation(agent, mode, text, { model, resume, trusted: true, system: asSystem ? persona : undefined });
  };
  if (persona && agent.systemFlag && canPass([agent.systemFlag, persona])) {
    try {
      return fitInvocation(build(true), excess, HISTORY_CHARS);
    } catch { /* does not fit on the command line: before the prompt instead */ }
  }
  return fitInvocation(build(false), excess, HISTORY_CHARS);
}

/** Short fingerprint of the injected text: a CLI session is only resumed with the same text. */
function fingerprint(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

module.exports = { loadBots, seedBots, sanitizeSvg, importAvatar, clearAvatar, recentEntries, systemText, botBlock, fingerprint, invocationFor, SOUL_WARN, SOUL_MAX, MEMORY_MAX };
