'use strict';
// Tasks and their subtasks, saved as private JSON files (0600) in
// <state>/tasks/<id>.json. A subtask that was running when Aska stopped is
// marked as failed when the tasks are read again: nothing runs by itself.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writePrivate, readOwnedJson, ensurePrivateDir } = require('../security');
const { t } = require('../../i18n');

const ID_RE = /^[a-f0-9]{12}$/;
const MAX_TASKS = 50;
const ANSWER_TAIL = 8000; // characters of a subtask's answer kept in the file

/** Short name for the branches: lowercase words of the goal. */
function slugOf(goal) {
  const s = String(goal)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return /^[a-z0-9]/.test(s) ? s : 'task';
}

class TaskStore {
  constructor(dir) {
    this.dir = dir;
  }

  file(id) {
    if (!ID_RE.test(id)) throw new Error('Invalid task id');
    return path.join(this.dir, `${id}.json`);
  }

  /** A new task (not saved yet): subtasks numbered from 1, all pending. */
  create({ goal, root, subtasks }) {
    const now = new Date().toISOString();
    return {
      id: crypto.randomBytes(6).toString('hex'),
      goal,
      root,
      slug: slugOf(goal),
      status: 'ready',
      createdAt: now,
      updatedAt: now,
      subtasks: subtasks.map((s, i) => ({ n: i + 1, status: 'pending', ...s })),
    };
  }

  save(task) {
    ensurePrivateDir(this.dir);
    task.updatedAt = new Date().toISOString();
    for (const s of task.subtasks) if (typeof s.answer === 'string' && s.answer.length > ANSWER_TAIL) s.answer = s.answer.slice(-ANSWER_TAIL);
    writePrivate(this.file(task.id), JSON.stringify(task, null, 2));
  }

  load(id) {
    if (!ID_RE.test(id)) return null;
    const r = readOwnedJson(this.file(id));
    const task = r.data;
    if (!task || task.id !== id || !Array.isArray(task.subtasks)) return null;
    // Stopped mid-run (Aska closed): failed, never started again by itself.
    let changed = false;
    for (const s of task.subtasks) {
      if (s.status === 'running' || s.status === 'queued') {
        s.status = s.status === 'running' ? 'failed' : 'cancelled';
        if (s.status === 'failed') s.error = t('tasks.interrupted');
        changed = true;
      }
    }
    if (task.status === 'running') {
      task.status = 'stopped';
      changed = true;
    }
    if (changed) this.save(task);
    return task;
  }

  list() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => ID_RE.test(n.replace(/\.json$/, '')) && n.endsWith('.json'));
    } catch {
      return [];
    }
    return names
      .map((n) => this.load(n.slice(0, -5)))
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, MAX_TASKS);
  }

  remove(id) {
    try {
      fs.unlinkSync(this.file(id));
    } catch { /* already gone */ }
  }
}

module.exports = { TaskStore, slugOf, ID_RE };
