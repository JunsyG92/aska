'use strict';
// Conversations: a thread of turns (request → answer), saved as private files
// (0600), one per conversation. Independent of Electron.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writePrivate, ensurePrivateDir, readOwnedJson } = require('./security');

const ID_RE = /^[a-f0-9]{16}$/;
const MAX_ANSWER = 200 * 1024;
const validId = (id) => typeof id === 'string' && ID_RE.test(id);

function titleOf(prompt) {
  const t = String(prompt).replace(/\s+/g, ' ').trim();
  return t.length > 70 ? t.slice(0, 69) + '…' : t;
}

/** Start of the last answer, stripped of Markdown syntax, for the list. */
/** Plain text of a Markdown answer, shortened to n characters (previews, notifications). */
function plainText(md, n = 140) {
  const t = String(md)
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^\s*\|.*$/gm, ' ') // table rows
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function previewOf(turns) {
  const last = [...turns].reverse().find((t) => t.answer && t.answer.trim());
  return last ? plainText(last.answer, 140) : '';
}

class ConversationStore {
  constructor(dir, { persist = true, max = 200 } = {}) {
    this.dir = dir;
    this.persist = persist;
    this.max = max;
  }

  create(cwd) {
    const now = new Date().toISOString();
    return { id: crypto.randomBytes(8).toString('hex'), title: '', createdAt: now, updatedAt: now, cwd, turns: [], sessions: {} };
  }

  file(id) {
    if (!validId(id)) throw new Error('Invalid conversation id');
    return path.join(this.dir, `${id}.json`);
  }

  save(conv) {
    if (!this.persist || !conv.turns.length) return;
    conv.updatedAt = new Date().toISOString();
    if (!conv.title) conv.title = titleOf(conv.turns[0].prompt);
    try {
      writePrivate(this.file(conv.id), JSON.stringify(conv));
      this.prune();
    } catch { /* history must never block an answer */ }
  }

  load(id) {
    if (!validId(id)) return null;
    const r = readOwnedJson(this.file(id));
    const c = r.data;
    if (!c || c.id !== id || !Array.isArray(c.turns)) return null;
    c.turns = c.turns.filter((t) => t && typeof t.prompt === 'string' && typeof t.agent === 'string');
    for (const t of c.turns) {
      if (typeof t.answer !== 'string') t.answer = '';
      if (t.status === 'running') t.status = 'error'; // app closed mid-run
    }
    if (!c.sessions || typeof c.sessions !== 'object') c.sessions = {};
    return c;
  }

  list() {
    if (!this.persist) return [];
    let names;
    try {
      names = fs.readdirSync(this.dir).filter((n) => validId(n.replace(/\.json$/, '')) && n.endsWith('.json'));
    } catch {
      return [];
    }
    const out = [];
    for (const n of names) {
      const c = this.load(n.slice(0, -5));
      if (!c || !c.turns.length) continue;
      out.push({
        id: c.id,
        title: c.title || titleOf(c.turns[0].prompt),
        updatedAt: c.updatedAt,
        turns: c.turns.length,
        agents: [...new Set(c.turns.map((t) => t.label || t.agent))],
        agentIds: [...new Set(c.turns.map((t) => t.agent))],
        cwd: typeof c.cwd === 'string' ? c.cwd : null,
        preview: previewOf(c.turns),
      });
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  delete(id) {
    if (!validId(id)) return;
    try {
      fs.unlinkSync(this.file(id));
    } catch { /* already deleted */ }
  }

  prune() {
    const all = this.list();
    for (const c of all.slice(this.max)) this.delete(c.id);
  }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '\n[… truncated]' : s);

/**
 * For a CLI without session resume (or when switching agents mid-conversation),
 * the context is fed back into the request: the previous turns, from newest to
 * oldest, as long as the budget allows.
 */
function buildContextPrompt(turns, prompt, maxChars = 24000) {
  const blocks = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const answer = t.answer.trim() ? clip(t.answer.trim(), 6000) : '(no answer: request interrupted or failed)';
    const block = `[User]\n${clip(t.prompt, 4000)}\n\n[Assistant: ${t.label || t.agent}]\n${answer}`;
    if (used + block.length > maxChars && blocks.length) break;
    blocks.unshift(block);
    used += block.length;
  }
  if (!blocks.length) return prompt;
  return [
    'Here is the history of the current conversation, from oldest to newest. It is context only: do not answer it again.',
    '',
    '<history>',
    blocks.join('\n\n'),
    '</history>',
    '',
    'New request from the user:',
    prompt,
  ].join('\n');
}

module.exports = { ConversationStore, buildContextPrompt, plainText, validId, titleOf, MAX_ANSWER, ensurePrivateDir };
