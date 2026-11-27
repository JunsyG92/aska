'use strict';
// "Push and open the pull request" for a subtask: run by Aska itself, never by
// the agent, after the user confirmed it. Two fixed commands, without a shell:
//   git push -u origin <branch>       (never forced)
//   gh pr create --head <branch> …    (never merged)
// The title and body (from the subtask's report) go as an argument and on stdin.

const { spawn } = require('child_process');
const { git, BRANCH_RE } = require('./worktree');
const { t } = require('../../i18n');

const TIMEOUT_MS = 120000;
const URL_RE = /https:\/\/[^\s"'<>]+/g;

/** Runs a program, no shell; { ok, code, out, err }. Never prompts for credentials. */
function run(command, args, { cwd, env, stdin = '', timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, code: null, out: '', err: e.message });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 65536) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 65536) err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, out, err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, out: out.trim(), err: err.trim() });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

const tail = (s) => String(s || '').trim().split('\n').slice(-3).join(' ').slice(-300);

/**
 * Pushes the subtask's branch and opens its pull request.
 * dir: its worktree; baseRef: the branch it started from (base of the pull
 * request when origin has it, otherwise the repository's default branch);
 * gh: the launch of gh (resolveLaunch), or null with ghError when not found.
 * Returns { pushed, url?, error?, steps: [{ argv, ok }] } (steps: for the audit log).
 */
async function pushAndOpenPr({ gitBin, gh, ghError, dir, branch, baseRef, title, body, env }) {
  const steps = [];
  if (!BRANCH_RE.test(String(branch))) return { pushed: false, error: t('tasks.badBranch', { branch }), steps };
  const origin = git(gitBin, ['remote', 'get-url', 'origin'], dir);
  if (!origin.ok || !origin.out) return { pushed: false, error: t('tasks.pr.noRemote'), steps };

  const pushArgv = ['push', '-u', 'origin', branch];
  const push = await run(gitBin, pushArgv, { cwd: dir, env });
  steps.push({ bin: gitBin, argv: pushArgv, ok: push.ok });
  if (!push.ok) return { pushed: false, error: t('tasks.pr.pushFailed', { error: tail(push.err || push.out) }), steps };

  if (!gh) return { pushed: true, error: t('tasks.pr.noGh', { branch, error: ghError || '' }), steps };
  const prArgv = ['pr', 'create', '--head', branch, `--title=${title}`, '--body-file', '-'];
  const known = baseRef && /^[A-Za-z0-9._/-]{1,200}$/.test(baseRef) && !baseRef.startsWith('-')
    ? git(gitBin, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${baseRef}`], dir).ok
    : false;
  if (known) prArgv.push('--base', baseRef);
  // gh.exe, or node on an npm launcher's script: never through cmd.exe (the title is free text).
  if (gh.viaCmd) return { pushed: true, error: t('tasks.pr.noGh', { branch, error: t('tasks.pr.viaCmd') }), steps };
  const pr = await run(gh.command, [...gh.prefix, ...prArgv], { cwd: dir, env, stdin: body });
  steps.push({ bin: gh.command, argv: ['pr', 'create', '--head', branch, ...(known ? ['--base', baseRef] : [])], ok: pr.ok });
  const urls = (pr.out.match(URL_RE) || []).filter((u) => /\/pull\/\d+/.test(u));
  if (!pr.ok || !urls.length) return { pushed: true, error: t('tasks.pr.failed', { error: tail(pr.err || pr.out) || pr.code }), steps };
  return { pushed: true, url: urls[urls.length - 1], steps };
}

module.exports = { pushAndOpenPr, run };
