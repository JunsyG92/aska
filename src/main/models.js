'use strict';
// Discovery of the models offered by each CLI, to show a real list instead of
// manual input. Each source is parsed leniently: if the format changes, we
// simply fall back to the built-in list.

const fs = require('fs');
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

// ----- Copilot: its help no longer lists the models; ACP (the protocol editors use)
// gives the full list when a session opens. Two requests on stdin, nothing is prompted.

/** Requests sent to "copilot --acp": initialize, then open a session in `cwd`. */
function acpRequests(cwd) {
  return [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } },
  ].map((m) => JSON.stringify(m) + '\n').join('');
}

/** Answer to "session/new": { models, sessionId, error }. */
function parseAcpSession(text) {
  for (const line of String(text).split('\n')) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (!m || m.id !== 2) continue;
    if (m.error) return { models: [], sessionId: null, error: String(m.error.message || 'error').slice(0, 200) };
    const r = m.result || {};
    const list = r.models && Array.isArray(r.models.availableModels) ? r.models.availableModels : [];
    const models = [];
    for (const x of list) {
      const id = x && x.modelId;
      if (!isModel(id) || models.some((o) => o.id === id)) continue;
      const label = typeof x.name === 'string' && x.name !== id ? x.name.slice(0, 60) : null;
      models.push({ id, label });
    }
    return { models, sessionId: typeof r.sessionId === 'string' ? r.sessionId : null, error: null };
  }
  return { models: [], sessionId: null, error: null };
}

/**
 * Copilot saves the session opened to read the list: removed, but only if it is
 * exactly that one, opened in Aska's empty folder, and still empty. Anything else
 * is left alone. Returns true if removed.
 */
function removeEmptyAcpSession(sessionId, { cwd, env = process.env, home = os.homedir() } = {}) {
  if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) return false;
  const base = env.COPILOT_HOME && path.isAbsolute(env.COPILOT_HOME) ? env.COPILOT_HOME : path.join(home, '.copilot');
  const dir = path.join(base, 'session-state', sessionId);
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    const yaml = fs.readFileSync(path.join(dir, 'workspace.yaml'), 'utf8');
    const field = (k) => (yaml.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1];
    if (field('id') !== sessionId || field('cwd') !== cwd || field('summary_count') !== '0') return false;
    // Only what an untouched session holds.
    const allowed = new Set(['workspace.yaml', '.workspace-fork.lock', 'checkpoints', 'checkpoints/index.md', 'files', 'research']);
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (!allowed.has(r) || e.isSymbolicLink()) return false;
        if (e.isDirectory() && !walk(r)) return false;
      }
      return true;
    };
    if (!walk('')) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** What the CLI said when it gave no list (e.g. "Authentication required…"), shortened. */
function cliMessage(text) {
  const line = clean(String(text || ''))
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('{'));
  return line ? line.replace(/^error:\s*/i, '').slice(0, 200) : null;
}

// Where to find the models of each built-in agent.
const SOURCES = {
  claude: { args: ['--help'], parse: (t) => parseHelpOption(t) },
  copilot: { args: ['--acp'], acp: true, timeoutMs: 20000 },
  cursor: { args: ['--list-models'], parse: parseModelLines },
  codex: {
    file: (env) => path.join(env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(os.homedir(), '.codex'), 'models_cache.json'),
    parse: parseCodexCache,
  },
};

/**
 * @param runCommand (args, { stdin, timeoutMs }) => Promise<{ ok, text, err }>: runs the agent's CLI (no shell)
 * @param opts.cwd folder the CLI runs in (Aska's empty folder), for Copilot's ACP session
 * @returns {Promise<{ models: {id,label}[], error: string|null }>}
 */
async function discoverModels(agentId, runCommand, env = process.env, { cwd, home } = {}) {
  const src = SOURCES[agentId];
  if (!src) return { models: [], error: null };
  try {
    if (src.file) {
      const r = readOwnedJson(src.file(env));
      return { models: r.data ? src.parse(r.data).slice(0, 400) : [], error: null };
    }
    if (src.acp) {
      const res = await runCommand(src.args, { stdin: acpRequests(cwd), timeoutMs: src.timeoutMs });
      const a = parseAcpSession(res.text || '');
      if (a.sessionId) removeEmptyAcpSession(a.sessionId, { cwd, env, home });
      const models = a.models.slice(0, 400);
      return { models, error: models.length ? null : a.error || cliMessage(res.err) || cliMessage(res.text) || t('models.noList') };
    }
    const res = await runCommand(src.args, { timeoutMs: src.timeoutMs });
    const models = src.parse(res.text || '').slice(0, 400);
    return { models, error: models.length ? null : res.ok ? null : cliMessage(res.err) || cliMessage(res.text) || t('models.noList') };
  } catch (e) {
    return { models: [], error: e.message };
  }
}

module.exports = {
  discoverModels,
  parseModelLines,
  parseHelpOption,
  parseCodexCache,
  acpRequests,
  parseAcpSession,
  removeEmptyAcpSession,
  cliMessage,
  SOURCES,
};
