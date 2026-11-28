'use strict';
// What a subtask reports when it ends: one JSON object at the end of its answer,
// { status, summary, commits, followUp }, read like the plan. Without it (or
// unreadable), the subtask is "to check": the user looks at its branch. The
// report is the agent's text: shown as text only, never run.

const { t } = require('../../i18n');

const STATUSES = ['done', 'partial', 'failed'];
const LANG_NAMES = { en: 'English', fr: 'French' };
const SUMMARY_MAX = 1000;
const COMMITS_MAX = 20;
const REMEMBER_MAX = 3;
const { ENTRY_MAX } = require('../bots');

/** Asked at the end of each subtask's instruction (the agent reads English). */
function reportInstruction(lang = 'en') {
  const language = LANG_NAMES[lang] || 'English';
  return [
    'When you are done, end your answer with ONE JSON object, alone on its last lines, with nothing after it (no code fence):',
    `{"status": "done" or "partial" or "failed", "summary": "what you did, in one to three sentences, in ${language}", "commits": ["<short hash> <subject>", ...], "followUp": "what is left to do, or an empty string", "remember": ["<a lasting fact worth remembering next time, in ${language}>", ...]}`,
    '"partial": part of the instruction is left; "failed": nothing could be done. Never push, merge or open a pull request unless the instruction asks for it.',
    `"remember": at most ${REMEMBER_MAX} short facts that will still be true and useful next time (a convention of the repository, a command that must be used), or [] (usually). The user decides whether they are kept; never a secret.`,
  ].join('\n');
}

const text = (v, max) => (typeof v === 'string' ? v.replace(/\0/g, '').trim().slice(0, max) : '');

/**
 * The last JSON object of the answer that is a report, cleaned, or null.
 * Tried from the last "{" backwards: the report ends the answer, and what comes
 * before it (code, other JSON) does not matter.
 */
function parseReport(answer) {
  const s = String(answer || '');
  const end = s.lastIndexOf('}');
  if (end === -1) return null;
  let tries = 0;
  for (let i = s.lastIndexOf('{', end); i !== -1 && tries < 200; i = i > 0 ? s.lastIndexOf('{', i - 1) : -1, tries++) {
    let j;
    try {
      j = JSON.parse(s.slice(i, end + 1));
    } catch {
      continue;
    }
    if (!j || typeof j !== 'object' || Array.isArray(j) || !STATUSES.includes(j.status)) continue;
    return {
      status: j.status,
      summary: text(j.summary, SUMMARY_MAX),
      commits: (Array.isArray(j.commits) ? j.commits : []).map((c) => text(c, 200)).filter(Boolean).slice(0, COMMITS_MAX),
      followUp: text(j.followUp, SUMMARY_MAX),
      // Facts the bot proposes to remember: one line each; written only when the user says so.
      remember: [...new Set((Array.isArray(j.remember) ? j.remember : []).map((r) => text(r, ENTRY_MAX).replace(/\s+/g, ' ')).filter(Boolean))].slice(0, REMEMBER_MAX),
    };
  }
  return null;
}

/** A finished subtask's state from its report: "done", "check" (missing, partial) or "failed". */
function statusFromReport(report) {
  if (!report) return 'check';
  return report.status === 'done' ? 'done' : report.status === 'failed' ? 'failed' : 'check';
}

/** The whole task at a glance: counts by state and the pull requests opened. */
function taskSummary(task) {
  const count = (st) => task.subtasks.filter((s) => s.status === st).length;
  return {
    total: task.subtasks.length,
    done: count('done'),
    check: count('check'),
    failed: count('failed'),
    cancelled: count('cancelled'),
    running: count('running') + count('queued'),
    pending: count('pending'),
    prs: task.subtasks.filter((s) => s.pr && s.pr.url).map((s) => ({ n: s.n, url: s.pr.url })),
  };
}

/**
 * The results, as given back to the orchestrator (ticket 18): one line per
 * subtask with its state, branch, report and pull request. English, like its prompt.
 */
function orchestratorReport(task, repoLabel = (s) => s.repo) {
  const sum = taskSummary(task);
  const lines = [
    `Results of the task: ${sum.done} done, ${sum.check} to check, ${sum.failed} failed, ${sum.cancelled} cancelled, ${sum.prs.length} pull request(s) opened.`,
  ];
  for (const s of task.subtasks) {
    const r = s.report;
    lines.push(
      `- ${s.n}. ${repoLabel(s)}: ${s.status}${s.branch ? `, branch ${s.branch}` : ''}${s.pr && s.pr.url ? `, pull request ${s.pr.url}` : ''}` +
        (r ? `. ${r.summary}${r.followUp ? ` Left to do: ${r.followUp}` : ''}` : s.error ? `. ${s.error}` : '. No report.')
    );
  }
  return lines.join('\n');
}

/** Title and body of a subtask's pull request, from its report (or the goal). */
function prText(task, s) {
  const r = s.report;
  const first = r && r.summary ? r.summary.split(/(?<=[.!?])\s|\n/)[0] : '';
  const title = (first || task.goal).replace(/\s+/g, ' ').trim().slice(0, 72);
  const commits = s.summary && s.summary.commits && s.summary.commits.length ? s.summary.commits : r ? r.commits : [];
  const body = [
    r && r.summary ? r.summary : task.goal,
    ...(commits.length ? ['', `## ${t('tasks.prBody.commits')}`, '', ...commits.map((c) => `- ${c}`)] : []),
    ...(r && r.followUp ? ['', `## ${t('tasks.prBody.followUp')}`, '', r.followUp] : []),
    '',
    '---',
    t('tasks.prBody.footer', { goal: task.goal.replace(/\s+/g, ' ').slice(0, 200) }),
  ].join('\n');
  return { title, body: body.slice(0, 20000) };
}

module.exports = { reportInstruction, parseReport, statusFromReport, taskSummary, orchestratorReport, prText, STATUSES };
