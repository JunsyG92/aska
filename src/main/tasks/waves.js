'use strict';
// Waves: once a task's subtasks are finished, the orchestrator may propose a
// next wave (fix a failure, finish what is left), from their reports. Limits:
// 3 waves, 30 subtasks and 2 hours in all. A wave within the rights already
// approved for the task (same repositories, no higher mode, no other command)
// may start by itself when the user chose "Continue automatically"; any new
// right goes back to the user's review.

const { MODE_ORDER } = require('../agents');
const { t } = require('../../i18n');

const MAX_WAVES = 3;
const MAX_TOTAL = 30;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const FINISHED = new Set(['done', 'check', 'failed', 'cancelled']);

/**
 * Whether a next wave may be asked for now: { n, room } or { error }.
 * n: its number; room: how many subtasks it may add.
 */
function nextWave(task, now = Date.now()) {
  const wave = task.wave || 1;
  if (!task.subtasks.every((s) => FINISHED.has(s.status))) return { error: t('tasks.wave.notFinished') };
  if (wave >= MAX_WAVES) return { error: t('tasks.wave.tooMany', { max: MAX_WAVES }) };
  const room = MAX_TOTAL - task.subtasks.length;
  if (room <= 0) return { error: t('tasks.wave.tooManySubtasks', { max: MAX_TOTAL }) };
  const started = Date.parse(task.startedAt || task.createdAt);
  if (Number.isFinite(started) && now - started > MAX_DURATION_MS) return { error: t('tasks.wave.tooLong', { hours: MAX_DURATION_MS / 3600000 }) };
  return { n: wave + 1, room: Math.min(room, 20) };
}

/** Subtasks a next wave may continue on their branch: number -> { n, repo, branch }. */
function continuable(task) {
  return new Map(task.subtasks.filter((s) => s.branch && FINISHED.has(s.status)).map((s) => [s.n, { n: s.n, repo: s.repo, branch: s.branch }]));
}

// The commands a subtask really gets: in a writing mode only.
const granted = (mode, allow) => (mode === 'read' ? [] : allow || []);

/** What the task's approved subtasks may do, together. */
function approvedRights(task) {
  const repos = new Set(task.subtasks.map((s) => s.repo));
  const rank = Math.max(0, ...task.subtasks.map((s) => MODE_ORDER.indexOf(s.mode)));
  const allow = new Set(task.subtasks.flatMap((s) => granted(s.mode, s.allow)));
  return { repos, rank, allow };
}

/**
 * What a subtask of a next wave would get beyond what the task was granted:
 * a list of reasons ([]: nothing new). sub: { repo, mode, allow } (its commands
 * as they would be granted, see rightsOf).
 */
function newRights(task, sub) {
  const a = approvedRights(task);
  const out = [];
  if (!a.repos.has(sub.repo)) out.push(t('tasks.wave.newRepo'));
  if (MODE_ORDER.indexOf(sub.mode) > a.rank) out.push(t('tasks.wave.newMode', { mode: t(`modes.${sub.mode}.label`) }));
  const cmds = granted(sub.mode, sub.allow).filter((c) => !a.allow.has(c));
  if (cmds.length) out.push(t('tasks.wave.newCommands', { commands: cmds.join(', ') }));
  return out;
}

module.exports = { nextWave, continuable, approvedRights, newRights, MAX_WAVES, MAX_TOTAL, MAX_DURATION_MS };
