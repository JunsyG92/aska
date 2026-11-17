'use strict';
// Discovery of the models offered by each CLI, to show a real list instead of
// manual input. Each source is parsed leniently: if the format changes, we
// simply fall back to the built-in list.

const os = require('os');
const path = require('path');
const { isModel } = require('./agents');
const { readOwnedJson } = require('./security');
const { clean } = require('./runner');
const { t } = require('../i18n');

/** "id - Label (current)", one line per model (cursor-agent --list-models). */
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

/** Quoted values in the description of the --model option in a help text (copilot help, claude --help). */
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

/** Catalog cached by Codex in its config folder. */
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

// Where to find the models of each built-in agent.
const SOURCES = {
  claude: { args: ['--help'], parse: (t) => parseHelpOption(t) },
  copilot: { args: ['help'], parse: (t) => parseHelpOption(t) },
  cursor: { args: ['--list-models'], parse: parseModelLines },
  codex: {
    file: (env) => path.join(env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(os.homedir(), '.codex'), 'models_cache.json'),
    parse: parseCodexCache,
  },
};

/**
 * @param runCommand (args) => Promise<{ ok, text }>: runs the agent's CLI (no shell)
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
    return { models, error: models.length || res.ok ? null : t('models.noList') };
  } catch (e) {
    return { models: [], error: e.message };
  }
}

module.exports = { discoverModels, parseModelLines, parseHelpOption, parseCodexCache, SOURCES };
