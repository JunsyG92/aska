'use strict';
// Conversations: a thread of turns (request → answer), saved as private files
// (0600), one per conversation. Independent of Electron.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writePrivate, ensurePrivateDir, readOwnedJson } = require('./security');
const { sanitizeSources } = require('./sources');

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

/** Conversation list entry (without the turns themselves). */
function summaryOf(c) {
  return {
    id: c.id,
    title: c.title || titleOf(c.turns[0].prompt),
    updatedAt: c.updatedAt,
    turns: c.turns.length,
    agents: [...new Set(c.turns.map((t) => t.label || t.agent))],
    agentIds: [...new Set(c.turns.map((t) => t.agent))],
    cwd: typeof c.cwd === 'string' ? c.cwd : null,
    preview: previewOf(c.turns),
  };
}

class ConversationStore {
  constructor(dir, { persist = true, max = 200 } = {}) {
    this.dir = dir;
    this.persist = persist;
    this.max = max;
    // List summaries, by file name: { ctimeMs, size, item }. Avoids rereading and
    // parsing every conversation (answers up to 200 KB) on each list/save.
    this.summaries = new Map();
  }

  create(cwd) {
    const now = new Date().toISOString();
    return { id: crypto.randomBytes(8).toString('hex'), title: '', createdAt: now, updatedAt: now, cwd, turns: [], sessions: {}, sources: [] };
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
      const file = this.file(conv.id);
      writePrivate(file, JSON.stringify(conv));
      this.remember(`${conv.id}.json`, file, summaryOf(conv));
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
    c.sources = sanitizeSources(c.sources); // documents and links attached to the conversation
    return c;
  }

  // Caches a summary, tied to the file's ctime and size (content, owner, permissions).
  remember(name, file, item) {
    try {
      const st = fs.statSync(file);
      this.summaries.set(name, { ctimeMs: st.ctimeMs, size: st.size, item });
    } catch {
      this.summaries.delete(name);
    }
  }

  names() {
    try {
      return fs.readdirSync(this.dir).filter((n) => n.endsWith('.json') && validId(n.slice(0, -5)));
    } catch {
      return [];
    }
  }

  list() {
    if (!this.persist) return [];
    const names = this.names();
    const out = [];
    for (const n of names) {
      const file = path.join(this.dir, n);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      let hit = this.summaries.get(n);
      // Only files changed since their last read are reparsed.
      if (!hit || hit.ctimeMs !== st.ctimeMs || hit.size !== st.size) {
        const c = this.load(n.slice(0, -5));
        hit = { ctimeMs: st.ctimeMs, size: st.size, item: c && c.turns.length ? summaryOf(c) : null };
        this.summaries.set(n, hit);
      }
      if (hit.item) out.push(hit.item);
    }
    const live = new Set(names);
    for (const n of this.summaries.keys()) if (!live.has(n)) this.summaries.delete(n);
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  delete(id) {
    if (!validId(id)) return;
    try {
      fs.unlinkSync(this.file(id));
    } catch { /* already deleted */ }
    this.summaries.delete(`${id}.json`);
  }

  prune() {
    // Compter les fichiers suffit pour savoir s'il faut en supprimer.
    if (this.names().length <= this.max) return;
    const all = this.list();
    for (const c of all.slice(this.max)) this.delete(c.id);
  }
}

const HISTORY_CHARS = 24000; // history fed back into a request, at most

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '\n[… truncated]' : s);

/**
 * For a CLI without session resume (or when switching agents mid-conversation),
 * the context is fed back into the request: the previous turns, from newest to
 * oldest, as long as the budget allows.
 */
function buildContextPrompt(turns, prompt, maxChars = HISTORY_CHARS) {
  if (maxChars <= 0) return prompt; // no room left for the history (see fitInvocation)
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

module.exports = { ConversationStore, buildContextPrompt, HISTORY_CHARS, plainText, validId, titleOf, MAX_ANSWER, ensurePrivateDir };
