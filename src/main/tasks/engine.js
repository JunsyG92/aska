'use strict';
// Runs the subtasks of a task: each one in its own worktree and branch, at most
// as many at once as the requests limit allows (shared with the tabs). The
// agent itself is started by the caller (launch), as for a tab.

const path = require('path');
const { addWorktree, removeWorktree, summary } = require('./worktree');
const { t } = require('../../i18n');

const DONE = new Set(['done', 'failed', 'cancelled']);

class TaskEngine {
  /**
   * @param store        TaskStore
   * @param gitBin       git to run (absolute path)
   * @param worktreesDir where the worktrees go (Aska's data)
   * @param launch       (task, subtask) => { cancel(), done: Promise<{ ok, reason, error, durationMs, answer }> }
   * @param busy         () => requests running elsewhere (the tabs)
   * @param max          requests at most, all together
   * @param onUpdate     (task) => void, after every change
   */
  constructor({ store, gitBin, worktreesDir, launch, busy = () => 0, max = 4, onUpdate = () => {} }) {
    Object.assign(this, { store, gitBin, worktreesDir, launch, busy, max, onUpdate });
    this.tasks = new Map();
    this.running = new Map(); // "<task>/<n>" -> handle
    for (const task of store.list()) this.tasks.set(task.id, task);
  }

  get(id) {
    return this.tasks.get(id) || null;
  }

  list() {
    return [...this.tasks.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  /** Requests of the tasks running now (counted by the tabs too). */
  get active() {
    return this.running.size;
  }

  add(task) {
    this.store.save(task);
    this.tasks.set(task.id, task);
    this.onUpdate(task);
    return task;
  }

  changed(task) {
    this.store.save(task);
    this.onUpdate(task);
  }

  /** Queues the pending subtasks (or the given ones again) and starts what fits. */
  start(id, numbers = null) {
    const task = this.get(id);
    if (!task) return { error: t('tasks.unknown') };
    for (const s of task.subtasks) {
      const again = numbers && numbers.includes(s.n) && (s.status === 'failed' || s.status === 'cancelled');
      if (s.status === 'pending' || again) {
        s.status = 'queued';
        delete s.error;
      }
    }
    task.status = 'running';
    this.changed(task);
    this.pump();
    return { ok: true };
  }

  /** Starts queued subtasks while there is room. */
  pump() {
    for (const task of this.tasks.values()) {
      for (const s of task.subtasks) {
        if (s.status !== 'queued') continue;
        if (this.busy() + this.running.size >= this.max) return;
        this.run(task, s);
      }
    }
  }

  run(task, s) {
    // Its worktree, made once: a subtask run again works on top of its branch.
    if (!s.worktree) {
      const w = addWorktree(this.gitBin, {
        repo: s.repo,
        dir: path.join(this.worktreesDir, task.id, String(s.n)),
        branch: `aska/${task.slug}/${s.n}`,
      });
      if (w.error) return this.finish(task, s, { ok: false, reason: 'worktree', error: w.error });
      Object.assign(s, { worktree: w.dir, branch: w.branch, base: w.base });
    }
    s.status = 'running';
    s.startedAt = new Date().toISOString();
    let handle;
    try {
      handle = this.launch(task, s);
    } catch (e) {
      return this.finish(task, s, { ok: false, reason: 'launch', error: e.message });
    }
    if (handle.error) return this.finish(task, s, { ok: false, reason: 'launch', error: handle.error });
    this.running.set(`${task.id}/${s.n}`, handle);
    this.changed(task);
    handle.done.then(
      (res) => this.finish(task, s, res),
      (e) => this.finish(task, s, { ok: false, reason: 'launch', error: e.message })
    );
  }

  finish(task, s, res) {
    this.running.delete(`${task.id}/${s.n}`);
    s.status = res.ok ? 'done' : res.reason === 'cancel' ? 'cancelled' : 'failed';
    s.durationMs = res.durationMs || 0;
    if (typeof res.answer === 'string') s.answer = res.answer;
    if (!res.ok && res.reason !== 'cancel') s.error = res.error || t('tasks.failed', { reason: res.reason || '?' });
    if (s.worktree) s.summary = summary(this.gitBin, { dir: s.worktree, base: s.base });
    if (task.subtasks.every((x) => DONE.has(x.status) || x.status === 'pending')) task.status = 'done';
    this.changed(task);
    this.pump();
  }

  /** Cancels a subtask, or the whole task: queued ones do not start, running ones stop. */
  cancel(id, n = null) {
    const task = this.get(id);
    if (!task) return { error: t('tasks.unknown') };
    for (const s of task.subtasks) {
      if (n !== null && s.n !== n) continue;
      if (s.status === 'queued' || s.status === 'pending') s.status = 'cancelled';
      const h = this.running.get(`${task.id}/${s.n}`);
      if (h) h.cancel();
    }
    if (task.subtasks.every((x) => DONE.has(x.status))) task.status = 'done';
    this.changed(task);
    return { ok: true };
  }

  /**
   * Removes a finished task: its worktrees and its file. The branches stay in
   * the repositories (their commits are the result). Refused while it runs.
   */
  cleanup(id) {
    const task = this.get(id);
    if (!task) return { error: t('tasks.unknown') };
    if (task.subtasks.some((s) => this.running.has(`${task.id}/${s.n}`))) return { error: t('tasks.stillRunning') };
    for (const s of task.subtasks) if (s.worktree) removeWorktree(this.gitBin, { repo: s.repo, dir: s.worktree });
    this.store.remove(id);
    this.tasks.delete(id);
    return { ok: true };
  }

  /** Stops everything (Aska closing). */
  stopAll() {
    for (const h of this.running.values()) h.cancel();
  }
}

module.exports = { TaskEngine };
