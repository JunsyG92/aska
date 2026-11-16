'use strict';
// Conversations : fil de tours (demande → réponse), enregistré en fichiers
// privés (0600), un par conversation. Indépendant d'Electron.

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
    if (!validId(id)) throw new Error('Identifiant de conversation invalide');
    return path.join(this.dir, `${id}.json`);
  }

  save(conv) {
    if (!this.persist || !conv.turns.length) return;
    conv.updatedAt = new Date().toISOString();
    if (!conv.title) conv.title = titleOf(conv.turns[0].prompt);
    try {
      writePrivate(this.file(conv.id), JSON.stringify(conv));
      this.prune();
    } catch { /* l'historique ne doit jamais bloquer une réponse */ }
  }

  load(id) {
    if (!validId(id)) return null;
    const r = readOwnedJson(this.file(id));
    const c = r.data;
    if (!c || c.id !== id || !Array.isArray(c.turns)) return null;
    c.turns = c.turns.filter((t) => t && typeof t.prompt === 'string' && typeof t.agent === 'string');
    for (const t of c.turns) {
      if (typeof t.answer !== 'string') t.answer = '';
      if (t.status === 'running') t.status = 'error'; // app fermée en cours de route
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
      });
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  delete(id) {
    if (!validId(id)) return;
    try {
      fs.unlinkSync(this.file(id));
    } catch { /* déjà supprimée */ }
  }

  prune() {
    const all = this.list();
    for (const c of all.slice(this.max)) this.delete(c.id);
  }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '\n[… tronqué]' : s);

/**
 * Pour un CLI sans reprise de session (ou quand on change d'agent en cours de
 * route), le contexte est réinjecté dans la demande : les tours précédents,
 * du plus récent au plus ancien tant que le budget le permet.
 */
function buildContextPrompt(turns, prompt, maxChars = 24000) {
  const blocks = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const answer = t.answer.trim() ? clip(t.answer.trim(), 6000) : '(aucune réponse : demande interrompue ou en échec)';
    const block = `[Utilisateur]\n${clip(t.prompt, 4000)}\n\n[Assistant — ${t.label || t.agent}]\n${answer}`;
    if (used + block.length > maxChars && blocks.length) break;
    blocks.unshift(block);
    used += block.length;
  }
  if (!blocks.length) return prompt;
  return [
    "Voici l'historique de la conversation en cours, du plus ancien au plus récent. Il sert de contexte : n'y réponds pas à nouveau.",
    '',
    '<historique>',
    blocks.join('\n\n'),
    '</historique>',
    '',
    "Nouvelle demande de l'utilisateur :",
    prompt,
  ].join('\n');
}

module.exports = { ConversationStore, buildContextPrompt, validId, titleOf, MAX_ANSWER, ensurePrivateDir };
