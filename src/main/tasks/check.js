'use strict';
// A task as sent by the window (later: drafted by the orchestrator and reviewed
// by the user), checked before anything runs. Approving it grants each
// subtask the commands of its bot, remote ones included: the plan was read.

const fs = require('fs');
const path = require('path');
const { checkWorkdir, within } = require('../security');
const { MODE_ORDER } = require('../agents');
const { repoRoot, realPath } = require('./worktree');
const { checkTempBot } = require('./bots');
const { t } = require('../../i18n');

const MAX_SUBTASKS = 20;
const GOAL_MAX = 2000;
const PROMPT_MAX = 20000;

/**
 * input: { goal, root, subtasks: [{ repo, botId | bot (see checkTempBot), prompt, mode }] }.
 * Returns { goal, root, subtasks: [{ repo, botId, prompt, mode, allow }] } or { error }.
 */
function checkTask(input, { bots, agents, allowAutoMode = false, gitBin, home, defaultAgent }) {
  const v = input && typeof input === 'object' ? input : {};
  const goal = typeof v.goal === 'string' ? v.goal.trim() : '';
  if (!goal || goal.length > GOAL_MAX || goal.includes('\0')) return { error: t('tasks.badGoal', { max: GOAL_MAX }) };
  if (typeof v.root !== 'string' || !path.isAbsolute(v.root)) return { error: t('tasks.badRoot') };
  const root = checkWorkdir(v.root, 'read', home);
  if (root.error) return { error: root.error };
  const list = Array.isArray(v.subtasks) ? v.subtasks : [];
  if (!list.length || list.length > MAX_SUBTASKS) return { error: t('tasks.badCount', { max: MAX_SUBTASKS }) };

  const subtasks = [];
  for (const [i, s] of list.entries()) {
    const n = i + 1;
    if (!s || typeof s !== 'object' || typeof s.repo !== 'string' || !path.isAbsolute(s.repo)) return { error: t('tasks.badRepo', { n }) };
    let real;
    try {
      real = fs.realpathSync.native(s.repo);
    } catch {
      return { error: t('tasks.badRepo', { n }) };
    }
    // A repository of the chosen folder, by its top folder.
    const top = repoRoot(gitBin, real);
    if (!top || !within(top, realPath(root.path))) return { error: t('tasks.repoOutside', { n, repo: s.repo }) };
    // An existing bot, or a temporary one (a copy, or made for the task: written when the task is created).
    let bot;
    let temp;
    if (s.bot !== undefined) {
      const c = checkTempBot(s.bot, n, { bots, agents, allowAutoMode, defaultAgent });
      if (c.error) return c;
      temp = c.temp;
      bot = { id: `tmp-${n}`, label: temp.label, agent: temp.agent, maxMode: temp.maxMode, allow: temp.allow };
    } else bot = typeof s.botId === 'string' && Object.hasOwn(bots, s.botId) ? bots[s.botId] : null;
    if (!bot) return { error: t('tasks.badBot', { n }) };
    const agent = agents[bot.agent];
    if (!agent || !agent.binPath) return { error: t('tasks.badAgent', { n, bot: bot.label }) };
    const prompt = typeof s.prompt === 'string' ? s.prompt.trim() : '';
    if (!prompt || prompt.length > PROMPT_MAX || prompt.includes('\0')) return { error: t('tasks.badPrompt', { n, max: PROMPT_MAX }) };
    // Up to the bot's ceiling, a mode its agent offers; autonomous only if the config allows it.
    const mode = s.mode === undefined ? (MODE_ORDER.indexOf(bot.maxMode) >= 1 ? 'edit' : 'read') : s.mode;
    const ok = MODE_ORDER.includes(mode) && MODE_ORDER.indexOf(mode) <= MODE_ORDER.indexOf(bot.maxMode) && agent.modes[mode] && (mode !== 'auto' || allowAutoMode);
    if (!ok) return { error: t('tasks.badMode', { n, bot: bot.label, max: bot.maxMode }) };
    subtasks.push({ repo: top, botId: bot.id, prompt, mode, allow: [...bot.allow], ...(temp ? { temp } : {}) });
  }
  return { goal, root: realPath(root.path), subtasks };
}

module.exports = { checkTask, MAX_SUBTASKS };
