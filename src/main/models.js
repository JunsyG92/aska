'use strict';
// Découverte des modèles proposés par chaque CLI, pour offrir une vraie liste
// au lieu d'une saisie à la main. Chaque source est lue de façon tolérante :
// si le format change, on retombe simplement sur la liste intégrée.

const os = require('os');
const path = require('path');
const { isModel } = require('./agents');
const { readOwnedJson } = require('./security');
const { clean } = require('./runner');

/** « id - Libellé (current) », une ligne par modèle (cursor-agent --list-models). */
function parseModelLines(text) {
  const out = [];
  for (const raw of clean(text).split('\n')) {
    const m = raw.match(/^\s*(?:[*•>-]\s+)?([A-Za-z0-9][\w.:/[\]-]*)\s+[-–—:]\s+(.+?)\s*$/);
    if (!m || !isModel(m[1])) continue;
    const label = m[2].replace(/\s*\((current|default|actuel)[^)]*\)\s*/gi, ' ').trim();
    out.push({ id: m[1], label: label && label !== m[1] ? label.slice(0, 60) : null });
  }
  return out;
}

/** Valeurs entre guillemets dans la description de l'option --model d'une aide (copilot help, claude --help). */
function parseHelpOption(text, flag = '--model') {
  const lines = clean(text).split('\n');
  const esc = flag.replace(/[-]/g, '\\-');
  const start = lines.findIndex((l) => new RegExp(`^\\s*(?:-\\w,\\s*)?${esc}(?:[ =<\\[]|$)`).test(l));
  if (start < 0) return [];
  let block = lines[start];
  for (let i = start + 1; i < lines.length && !/^\s{0,6}-{1,2}[A-Za-z]/.test(lines[i]); i++) block += ' ' + lines[i].trim();
  const out = [];
  for (const m of block.matchAll(/"([^"\s]+)"|'([^'\s]+)'/g)) {
    const id = m[1] || m[2];
    if (isModel(id) && !out.some((o) => o.id === id)) out.push({ id, label: null });
  }
  return out;
}

/** Catalogue mis en cache par Codex dans son dossier de configuration. */
function parseCodexCache(data) {
  const list = data && Array.isArray(data.models) ? data.models : Array.isArray(data) ? data : [];
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    if (typeof m.visibility === 'string' && m.visibility !== 'list') continue;
    const id = m.slug || m.id || m.model;
    if (!isModel(id) || out.some((o) => o.id === id)) continue;
    const label = typeof m.display_name === 'string' && m.display_name !== id ? m.display_name.slice(0, 60) : null;
    out.push({ id, label });
  }
  return out;
}

/**
 * « ollama list » : un tableau dont la première colonne est le nom du modèle.
 *   NAME               ID              SIZE      MODIFIED
 *   llama3.2:latest    a80c4f17acd5    2.0 GB    3 weeks ago
 */
function parseOllamaList(text) {
  const out = [];
  for (const raw of clean(text).split('\n')) {
    // Une vraie ligne du tableau : le nom, puis l'identifiant (12 caractères hexadécimaux).
    const cols = raw.trim().split(/\s+/);
    const name = cols[0];
    if (cols.length < 3 || !/^[0-9a-f]{12}$/.test(cols[1]) || !isModel(name) || out.some((o) => o.id === name)) continue;
    const size = (raw.match(/\b(\d+(?:\.\d+)?\s?[KMGT]B)\b/) || [])[1];
    out.push({ id: name, label: size ? `${name.replace(/:latest$/, '')} · ${size}` : null });
  }
  return out;
}

// Où trouver les modèles de chaque agent intégré.
const SOURCES = {
  ollama: { args: ['list'], parse: parseOllamaList },
  claude: { args: ['--help'], parse: (t) => parseHelpOption(t) },
  copilot: { args: ['help'], parse: (t) => parseHelpOption(t) },
  cursor: { args: ['--list-models'], parse: parseModelLines },
  codex: {
    file: (env) => path.join(env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(os.homedir(), '.codex'), 'models_cache.json'),
    parse: parseCodexCache,
  },
};

/**
 * @param runCommand (args) => Promise<{ ok, text }> : exécute le CLI de l'agent (sans shell)
 * @returns {Promise<{ models: {id,label}[], error: string|null }>}
 */
async function discoverModels(agentId, runCommand, env = process.env) {
  const src = SOURCES[agentId];
  if (!src) return { models: [], error: null };
  try {
    if (src.file) {
      const r = readOwnedJson(src.file(env));
      return { models: r.data ? src.parse(r.data).slice(0, 400) : [], error: null };
    }
    const res = await runCommand(src.args);
    const models = src.parse(res.text || '').slice(0, 400);
    return { models, error: models.length || res.ok ? null : 'le CLI n\'a pas renvoyé sa liste de modèles' };
  } catch (e) {
    return { models: [], error: e.message };
  }
}

module.exports = { discoverModels, parseModelLines, parseHelpOption, parseCodexCache, parseOllamaList, SOURCES };
