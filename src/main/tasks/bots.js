'use strict';
// Temporary bots of a task: a copy of an existing bot (other rights, same
// personality) or a bot made for the task (from the window, later from the
// orchestrator's plan). They live in <state>/tasks/<task>/bots/<n>/, never in
// ~/.aska/bots: they are not offered with "@", and they go with the task,
// unless the user keeps one ("Keep this bot" copies it into ~/.aska/bots).

const fs = require('fs');
const path = require('path');
const { writePrivate, readOwnedJson, readOwnedText } = require('../security');
const { MODE_ORDER } = require('../agents');
const { cleanAllow, loadBotFrom, createBot, saveBot, SOUL_MAX } = require('../bots');
const { EMBLEMS } = require('../../renderer/avatar');
const { t } = require('../../i18n');

// Their personality always ends with the safety rules (added if missing).
const SAFETY_RE = /^## (Safety|Sécurité)[ \t]*$/m; // no \b: "é" is not a word character for it
const withSafety = (soul) => (SAFETY_RE.test(soul) ? soul : `${soul.trim()}\n\n${t('bots.safety')}`);

/**
 * The bot of a subtask when it is not an existing one, as sent by the window:
 * { copyOf, allow?, maxMode? } or { label, soul, agent?, maxMode?, allow?, emblem? }.
 * Checked as any bot (refused commands make it refused: the user sees the plan).
 * Returns { temp } or { error }.
 */
function checkTempBot(spec, n, { bots, agents, allowAutoMode = false, defaultAgent }) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { error: t('tasks.badBot', { n }) };
  const source = spec.copyOf !== undefined ? (typeof spec.copyOf === 'string' && Object.hasOwn(bots, spec.copyOf) ? bots[spec.copyOf] : null) : null;
  if (spec.copyOf !== undefined && !source) return { error: t('tasks.badBot', { n }) };
  const label = source ? source.label : typeof spec.label === 'string' ? spec.label.trim() : '';
  if (!label || label.length > 24) return { error: t('tasks.badTempBot', { n, error: t('bots.edit.label', { max: 24 }) }) };
  const agentId = source ? source.agent : typeof spec.agent === 'string' ? spec.agent : defaultAgent;
  const agent = agentId && Object.hasOwn(agents, agentId) ? agents[agentId] : null;
  if (!agent || !agent.binPath) return { error: t('tasks.badAgent', { n, bot: label }) };
  const soul = source ? source.soul : typeof spec.soul === 'string' ? spec.soul.trim() : '';
  if (!soul || soul.length > SOUL_MAX || soul.includes('\0')) return { error: t('tasks.badTempBot', { n, error: t('bots.edit.soulTooLong', { length: soul.length, max: SOUL_MAX }) }) };
  const maxMode = spec.maxMode === undefined ? (source ? source.maxMode : 'read') : spec.maxMode;
  if (!MODE_ORDER.includes(maxMode) || (maxMode === 'auto' && !allowAutoMode)) return { error: t('tasks.badTempBot', { n, error: t('bots.edit.maxMode') }) };
  const r = cleanAllow(spec.allow === undefined ? (source ? source.allow : []) : spec.allow);
  if (r.refused.length || (spec.allow !== undefined && !Array.isArray(spec.allow))) {
    return { error: t('tasks.badTempBot', { n, error: t('bots.edit.allow', { commands: r.refused.join(', ') }) }) };
  }
  const emblem = typeof spec.emblem === 'string' && (spec.emblem === 'none' || EMBLEMS.includes(spec.emblem)) ? spec.emblem : undefined;
  return {
    temp: {
      label,
      description: source ? source.description : typeof spec.description === 'string' ? spec.description.trim().slice(0, 120) : '',
      agent: agent.id,
      model: source ? source.model : undefined,
      soul,
      maxMode,
      allow: r.allow,
      avatar: source ? source.avatar : emblem ? { emblem } : {},
      color: source && source.ownColor ? source.color : undefined,
      copyOf: source ? source.id : undefined,
      sourceDir: source ? source.dir : undefined,
    },
  };
}

/** Writes a temporary bot into dir (0600 files, 0700 folder), with its avatar picture if copied. */
function writeTempBot(dir, temp) {
  const json = { label: temp.label, agent: temp.agent, mode: MODE_ORDER.indexOf(temp.maxMode) >= 1 ? 'edit' : 'read', maxMode: temp.maxMode };
  if (temp.description) json.description = temp.description;
  if (temp.model !== undefined) json.model = temp.model;
  if (temp.allow.length) json.allow = temp.allow;
  if (temp.color) json.color = temp.color;
  if (temp.avatar && Object.keys(temp.avatar).length) json.avatar = temp.avatar;
  writePrivate(path.join(dir, 'bot.json'), JSON.stringify(json, null, 2) + '\n');
  writePrivate(path.join(dir, 'SOUL.md'), withSafety(temp.soul) + '\n');
  if (temp.sourceDir) {
    for (const f of ['avatar.png', 'avatar.svg']) {
      const from = path.join(temp.sourceDir, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, f));
    }
  }
}

/** The temporary bot of subtask n, checked as any bot; null if it no longer loads. */
function loadTempBot(dir, n, opts) {
  return loadBotFrom(dir, `tmp-${n}`, opts).bot || null;
}

/**
 * Keeps a temporary bot: a new bot in ~/.aska/bots (its name must be free),
 * with the same fields, personality and picture. Returns { id } or { errors }.
 */
function keepTempBot(dir, { botsDir, taken, agents, allowAutoMode }) {
  const j = readOwnedJson(path.join(dir, 'bot.json'));
  const soul = readOwnedText(path.join(dir, 'SOUL.md'));
  if (!j.data || soul.text === undefined) return { errors: { _: t('tasks.unknown') } };
  const raw = j.data;
  const made = createBot(botsDir, { label: raw.label, agent: raw.agent, taken });
  if (made.errors) return made;
  const target = path.join(botsDir, made.id);
  const values = { soul: soul.text, maxMode: raw.maxMode, mode: raw.mode, allow: raw.allow || [] };
  if (raw.description) values.description = raw.description;
  if (raw.model) values.model = raw.model;
  if (raw.color) values.color = raw.color;
  if (raw.avatar) values.avatar = raw.avatar;
  const s = saveBot(target, values, { agents, allowAutoMode });
  if (s.errors) {
    fs.rmSync(target, { recursive: true, force: true });
    return s;
  }
  for (const f of ['avatar.png', 'avatar.svg']) {
    const from = path.join(dir, f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(target, f));
  }
  return { id: made.id };
}

module.exports = { checkTempBot, writeTempBot, loadTempBot, keepTempBot, withSafety };
