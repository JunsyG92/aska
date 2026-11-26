'use strict';
// Git worktrees for the subtasks of a task: each one works on its own branch,
// in a folder of Aska's data, so the user's working copy is never touched and
// several bots can work on the same repository. git is run without a shell.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { t } = require('../../i18n');

const BRANCH_RE = /^aska\/[a-z0-9][a-z0-9._-]{0,40}\/[0-9]{1,3}$/;

/** Runs git; { ok, out, err }. Never prompts (no credentials asked on a terminal). */
function git(gitBin, args, cwd) {
  const r = spawnSync(gitBin, args, {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  return { ok: !r.error && r.status === 0, out: (r.stdout || '').trim(), err: (r.error ? r.error.message : r.stderr || '').trim() };
}

/** Top folder of the repository holding dir, or null. */
function repoRoot(gitBin, dir) {
  const r = git(gitBin, ['rev-parse', '--show-toplevel'], dir);
  return r.ok && r.out ? path.resolve(r.out) : null;
}

/** Repositories found in root: itself, or its folders (two levels at most). */
function findRepos(gitBin, root, { depth = 2, max = 100 } = {}) {
  const found = [];
  const walk = (dir, level) => {
    if (found.length >= max) return;
    if (fs.existsSync(path.join(dir, '.git'))) {
      found.push(dir);
      return; // a repository's own folders are not searched
    }
    if (level >= depth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name), level + 1);
    }
  };
  walk(root, 0);
  return found.filter((d) => repoRoot(gitBin, d));
}

/**
 * Creates the worktree of a subtask: folder dir, new branch, from base (the
 * repository's HEAD by default). The branch must not exist yet.
 * Returns { dir, branch, base } or { error }.
 */
function addWorktree(gitBin, { repo, dir, branch, base = 'HEAD' }) {
  if (!BRANCH_RE.test(branch)) return { error: t('tasks.badBranch', { branch }) };
  const top = repoRoot(gitBin, repo);
  if (!top) return { error: t('tasks.notRepo', { repo }) };
  if (git(gitBin, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], top).ok) return { error: t('tasks.branchExists', { branch }) };
  const head = git(gitBin, ['rev-parse', '--verify', `${base}^{commit}`], top);
  if (!head.ok) return { error: t('tasks.noBase', { repo, error: head.err }) };
  if (fs.existsSync(dir)) return { error: t('tasks.folderExists', { dir }) };
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  const r = git(gitBin, ['worktree', 'add', '-b', branch, dir, head.out], top);
  if (!r.ok) return { error: t('tasks.worktreeFailed', { repo, error: r.err.slice(-300) }) };
  return { dir: fs.realpathSync(dir), branch, base: head.out };
}

/**
 * Removes a subtask's worktree (its folder, even with changes left in it).
 * The branch is kept: its commits are the result (pushed or not, ticket 17).
 */
function removeWorktree(gitBin, { repo, dir }) {
  const top = repoRoot(gitBin, repo) || repo;
  const r = git(gitBin, ['worktree', 'remove', '--force', dir], top);
  if (!r.ok && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  git(gitBin, ['worktree', 'prune'], top);
  return { ok: !fs.existsSync(dir) };
}

/** Commits of the branch since its base, and the files changed. */
function summary(gitBin, { dir, base }) {
  const log = git(gitBin, ['log', '--format=%h %s', `${base}..HEAD`], dir);
  const stat = git(gitBin, ['diff', '--shortstat', `${base}...HEAD`], dir);
  const dirty = git(gitBin, ['status', '--porcelain'], dir);
  return {
    commits: log.ok && log.out ? log.out.split('\n').slice(0, 50) : [],
    changes: stat.ok ? stat.out : '',
    uncommitted: dirty.ok && dirty.out ? dirty.out.split('\n').length : 0,
  };
}

module.exports = { git, repoRoot, findRepos, addWorktree, removeWorktree, summary, BRANCH_RE };
