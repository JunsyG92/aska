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
    ownColor: COLOR_RE.test(u.color || ''), // set in bot.json (the settings show it)
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
 * Saves the fields the settings edit: label, description, color, model, mode,
 * avatar and the personality (SOUL.md). bot.json is rewritten with every other
 * field kept as it is (agent, cwd, maxMode, enabled, later fields…): those stay
 * in the files. Checked with the rules of loadBots; nothing is written if a
 * value is refused. values: only the fields that changed.
 * Returns {} or { errors: { field: message } }.
 */
function saveBot(dir, values, { agents = {}, allowAutoMode = false } = {}) {
  const v = values && typeof values === 'object' ? values : {};
  const j = readOwnedJson(path.join(dir, 'bot.json'));
  if (j.error || !j.data || typeof j.data !== 'object' || Array.isArray(j.data)) return { errors: { _: j.error || t('bots.edit.unreadable') } };
  const raw = { ...j.data };
  const errors = {};
  if ('label' in v) {
    const s = typeof v.label === 'string' ? v.label.trim() : '';
    if (!s || s.length > 24) errors.label = t('bots.edit.label', { max: 24 });
    else raw.label = s;
  }
  if ('description' in v) {
    const s = typeof v.description === 'string' ? v.description.trim() : null;
    if (s === null || s.length > 120) errors.description = t('bots.edit.description', { max: 120 });
    else if (s) raw.description = s;
    else delete raw.description;
  }
  if ('color' in v) {
    if (v.color === '' || v.color === null) delete raw.color; // the avatar's
    else if (typeof v.color === 'string' && COLOR_RE.test(v.color)) raw.color = v.color.toLowerCase();
    else errors.color = t('bots.edit.color');
  }
  if ('model' in v) {
    if (v.model === '' || v.model === null) delete raw.model; // the agent's
    else if (isModel(v.model)) raw.model = v.model;
    else errors.model = t('bots.edit.model');
  }
  if ('mode' in v) {
    // The ceiling stays in the file, read as loadBots reads it.
    const max = MODE_ORDER.includes(raw.maxMode) && (raw.maxMode !== 'auto' || allowAutoMode) ? raw.maxMode : raw.maxMode === 'auto' ? 'edit' : 'read';
    const agent = Object.hasOwn(agents, raw.agent) ? agents[raw.agent] : null;
    if (!MODE_ORDER.includes(v.mode) || v.mode === 'auto' || rank(v.mode) > rank(max) || (agent && !agent.modes[v.mode])) {
      errors.mode = t('bots.edit.mode', { max });
    } else raw.mode = v.mode;
  }
  if ('avatar' in v) {
    const a = v.avatar;
    const ok =
      a && typeof a === 'object' && !Array.isArray(a) &&
      (a.variant === undefined || (Number.isInteger(a.variant) && a.variant >= 0 && a.variant < 10000)) &&
      (a.shape === undefined || a.shape === 'auto' || SHAPES.includes(a.shape)) &&
      (a.emblem === undefined || a.emblem === 'auto' || a.emblem === 'none' || EMBLEMS.includes(a.emblem));
    if (!ok) errors.avatar = t('bots.edit.avatar');
    else {
      // Defaults are left out: the file stays short.
      const clean = {};
      if (a.variant) clean.variant = a.variant;
      if (a.shape && a.shape !== 'auto') clean.shape = a.shape;
      if (a.emblem && a.emblem !== 'auto') clean.emblem = a.emblem;
      if (Object.keys(clean).length) raw.avatar = clean;
      else delete raw.avatar;
    }
  }
  let soul;
  if ('soul' in v) {
    soul = typeof v.soul === 'string' ? v.soul.trim() : null;
    if (soul === null || soul.includes('\0')) errors.soul = t('bots.edit.soulInvalid');
    else if (!soul) errors.soul = t('bots.edit.soulEmpty');
    else if (soul.length > SOUL_MAX) errors.soul = t('bots.edit.soulTooLong', { length: soul.length, max: SOUL_MAX });
  }
  if (Object.keys(errors).length) return { errors };
  try {
    writePrivate(path.join(dir, 'bot.json'), JSON.stringify(raw, null, 2) + '\n');
    if (soul !== undefined) writePrivate(path.join(dir, 'SOUL.md'), soul + '\n');
  } catch (e) {
    return { errors: { _: e.message } };
  }
  return {};
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

// Drawing elements kept from an SVG added by hand; anything else is dropped
// with its content (script, foreignObject, style, image, a, set…).
const SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'title', 'desc', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'marker',
  'filter', 'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite', 'feflood', 'fegaussianblur', 'femerge',
  'femergenode', 'feoffset', 'fedropshadow', 'fefuncr', 'fefuncg', 'fefuncb', 'fefunca', 'femorphology', 'feturbulence',
  'animate', 'animatetransform',
]);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()];
    const hex = e[1] === 'x' || e[1] === 'X';
    const code = Number.parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}
const escapeXml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** An attribute's value kept, or null: no event handler, no link or resource outside the document. */
function safeAttribute(name, raw) {
  if (!/^[A-Za-z][\w:.-]*$/.test(name) || /^on/i.test(name)) return null;
  const value = decodeEntities(raw);
  if (/^(xlink:)?href$/i.test(name)) return /^#[\w:.-]+$/.test(value.trim()) ? value.trim() : null;
  if (/javascript:|@import|expression\(|url\((?![\s'"]*#)/i.test(value)) return null;
  return value;
}

/**
 * Cleans an SVG chosen by the user. It is only ever shown as <img src="data:">,
 * where an SVG runs no script and loads nothing; this is a second line of
 * defense. The SVG is cut into tags and text, and a new one is written from
 * the drawing elements and the safe attributes only: no script, event
 * handler, embedded content, style sheet, entity, external link or resource.
 * Returns { svg } or { error }.
 */
function sanitizeSvg(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > SVG_MAX) return { error: t('bots.avatarTooBig', { max: SVG_MAX / 1024 }) };
  if (input.includes('\0')) return { error: t('bots.avatarNotImage') };
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input; // BOM
  const TOKEN = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<[!?][^>]*>?|<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|[^<]+|</g;
  const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const out = [];
  const open = []; // elements kept and still open
  let skip = 0; // depth inside a dropped element
  let root = false;
  for (const m of text.matchAll(TOKEN)) {
    const [whole, closing, tag, attrs = '', selfClosing] = m;
    if (!tag) {
      // Text: inside the drawing only, escaped (an undeclared entity stays plain text).
      if (!skip && open.length && whole[0] !== '<') out.push(escapeXml(decodeEntities(whole)));
      continue;
    }
    const name = tag.toLowerCase();
    if (closing) {
      if (skip) skip--;
      else if (open.length && open[open.length - 1] === name) {
        open.pop();
        out.push(`</${tag}>`);
      }
      continue;
    }
    const pairs = [...attrs.matchAll(ATTR)].map(([, n, a, b, c]) => [n, a ?? b ?? c ?? '']);
    // Animating a link could point it elsewhere: dropped.
    const animatesLink = name.startsWith('animate') && pairs.some(([n, v]) => n === 'attributeName' && /href/i.test(v));
    const kept = !skip && !animatesLink && SVG_ELEMENTS.has(name) && (root ? open.length > 0 : name === 'svg');
    if (!kept) {
      if (!selfClosing) skip++;
      continue;
    }
    root = true;
    const safe = pairs.map(([n, v]) => [n, safeAttribute(n, v)]).filter(([, v]) => v !== null);
    out.push(`<${tag}${safe.map(([n, v]) => ` ${n}="${escapeXml(v)}"`).join('')}${selfClosing ? '/>' : '>'}`);
    if (!selfClosing) open.push(name);
  }
  if (!root || open.length) return { error: t('bots.avatarNotImage') };
  return { svg: out.join('').trim() };
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
  let fd;
  try {
    // Size checked and content read through the same descriptor.
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { error: t('bots.avatarNotImage') };
    if (st.size > IMAGE_MAX) return { error: t('bots.avatarTooBig', { max: IMAGE_MAX / 1024 }) };
    buf = fs.readFileSync(fd);
  } catch (e) {
    return { error: e.message };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
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
      // Created here or not at all (exclusive): a folder that exists is never touched.
      try {
        fs.mkdirSync(target, { mode: 0o700 });
      } catch {
        continue;
      }
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

module.exports = { loadBots, saveBot, seedBots, sanitizeSvg, importAvatar, clearAvatar, recentEntries, systemText, botBlock, fingerprint, invocationFor, SOUL_WARN, SOUL_MAX, MEMORY_MAX };
