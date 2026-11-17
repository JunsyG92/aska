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

/** Début de la dernière réponse, débarrassé de la syntaxe Markdown, pour la liste. */
/** Texte brut d'une réponse Markdown, raccourci à n caractères (aperçus, notifications). */
function plainText(md, n = 140) {
  const t = String(md)
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^\s*\|.*$/gm, ' ') // lignes de tableau
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

/** Entrée de la liste des conversations (sans les tours eux-mêmes). */
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
    // Résumés de la liste, par nom de fichier : { ctimeMs, size, item }. Évite de
    // relire et parser chaque conversation (réponses jusqu'à 200 Ko) à chaque list/save.
    this.summaries = new Map();
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
      const file = this.file(conv.id);
      writePrivate(file, JSON.stringify(conv));
      this.remember(`${conv.id}.json`, file, summaryOf(conv));
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

  // Met un résumé en cache, lié au ctime et à la taille du fichier (contenu, propriétaire, droits).
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
      // Seuls les fichiers modifiés depuis leur dernière lecture sont reparsés.
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
    } catch { /* déjà supprimée */ }
    this.summaries.delete(`${id}.json`);
  }

  prune() {
    // Compter les fichiers suffit pour savoir s'il faut en supprimer.
    if (this.names().length <= this.max) return;
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

module.exports = { ConversationStore, buildContextPrompt, plainText, validId, titleOf, MAX_ANSWER, ensurePrivateDir };
