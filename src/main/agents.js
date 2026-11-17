'use strict';
// Agent definitions: how each CLI is invoked, and what each permission mode
// maps to. No mode uses a CLI "bypass" flag.

const { t } = require('../i18n');

// Labels and hints are read in the current language each time they are used.
const modeInfo = (id) => ({
  get label() {
    return t(`modes.${id}.label`);
  },
  get hint() {
    return t(`modes.${id}.hint`);
  },
});
const MODES = { read: modeInfo('read'), edit: modeInfo('edit'), auto: modeInfo('auto') };
const MODE_ORDER = ['read', 'edit', 'auto'];

const BUILTIN = {
  claude: {
    label: 'Claude',
    color: '#d97757',
    bin: ['claude'],
    prompt: 'stdin',
    output: 'stream-json',
    base: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'],
    modes: {
      // Headless (-p), Claude Code does not ask whether to trust the folder and
      // would run the hooks from its .claude/settings.json: in read-only mode, only
      // the user's own settings are loaded.
      read: ['--permission-mode', 'plan', '--setting-sources', 'user'],
      edit: ['--permission-mode', 'acceptEdits'],
      auto: ['--permission-mode', 'auto'],
    },
    modelFlag: '--model',
    models: ['opus', 'sonnet', 'haiku'],
    resumeFlag: '--resume', // native resume: the CLI restores the full thread context
    env: ['ANTHROPIC_*', 'CLAUDE_*'],
    install: 'npm i -g @anthropic-ai/claude-code',
  },
  codex: {
    label: 'Codex',
    color: '#10a37f',
    bin: ['codex'],
    prompt: 'stdin',
    output: 'text',
    base: ['exec', '--skip-git-repo-check', '--color', 'never'],
    modes: {
      read: ['--sandbox', 'read-only'],
      // workspace-write: writes limited to the folder, no network.
      edit: ['--sandbox', 'workspace-write'],
      auto: ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'],
    },
    tail: ['-'],
    modelFlag: '--model',
    env: ['OPENAI_*', 'CODEX_*'],
    install: 'npm i -g @openai/codex',
  },
  copilot: {
    label: 'Copilot',
    color: '#8250df',
    bin: ['copilot'],
    // VS Code installs a fake "copilot" that only offers to install it:
    // it is used only if no real CLI is found.
    avoidPath: /github\.copilot|\.vscode|[\\/]Code[\\/]/i,
    prompt: 'arg',
    promptFlag: '-p',
    output: 'text',
    base: ['-s'],
    modes: {
      read: ['--deny-tool', 'shell', '--deny-tool', 'write'],
      edit: ['--allow-tool', 'write', '--deny-tool', 'shell'],
      // Copilot has no sandbox: everything is allowed except the deny list.
      auto: [
        '--allow-all-tools',
        '--deny-tool', 'shell(rm)',
        '--deny-tool', 'shell(sudo)',
        '--deny-tool', 'shell(git push)',
      ],
    },
    modelFlag: '--model',
    env: ['COPILOT_*', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST'],
    install: 'npm i -g @github/copilot',
  },
  cursor: {
    label: 'Cursor',
    color: '#3b82f6',
    bin: ['cursor-agent', 'agent'],
    // Headless, the Cursor CLI requires confirming that the folder is trusted.
    // Aska only passes this flag after your approval (or in its own empty folder).
    trustFlag: '--trust',
    prompt: 'arg',
    output: 'stream-json',
    base: ['-p', '--output-format', 'stream-json'],
    modes: {
      read: ['--mode', 'ask'],
      // The Cursor CLI only applies changes with --force, which also allows
      // commands: there is no "edit only" mode.
      auto: ['--force'],
    },
    modelFlag: '--model',
    env: ['CURSOR_*'],
    install: 'curl https://cursor.com/install -fsS | bash',
  },
};

// Flags rejected in `extraArgs`: they disable the CLI's safeguards.
const DANGEROUS_ARG = [
  /^--dangerously/i,
  /^--allow-dangerously/i,
  /^--yolo$/i,
  /^--trust$/i,
  /^--force$/i,
  /^-f$/,
  /^--allow-all/i,
  /^--full-auto$/i,
  /bypassPermissions/i,
  /danger-full-access/i,
  /^--permission-mode/i,
  /^--setting-sources/i,
  /^--sandbox/i,
  /^-s$/,
  /^--ask-for-approval/i,
  /^--mode(=|$)/i,
];

function isDangerousArg(arg) {
  return DANGEROUS_ARG.some((re) => re.test(arg));
}

const MODEL_RE = /^[A-Za-z0-9][\w.:/[\]-]{0,79}$/;
const SESSION_RE = /^[A-Za-z0-9][\w-]{7,79}$/;
const isModel = (m) => typeof m === 'string' && MODEL_RE.test(m);

const isStrArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && !s.includes('\0'));

/** Merges the built-in agents with the user config (integrity already checked). */
function resolveAgents(userAgents = {}) {
  const out = {};
  const warnings = [];
  const ids = new Set([...Object.keys(BUILTIN), ...Object.keys(userAgents || {})]);
  for (const id of ids) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) {
      warnings.push(t('agents.invalidId', { id }));
      continue;
    }
    const base = BUILTIN[id];
    const user = (userAgents && userAgents[id]) || {};
    if (user.enabled === false) continue;
    let agent;
    if (base) {
      agent = { ...base, id, modes: { ...base.modes }, models: [...(base.models || [])] };
    } else {
      // Custom agent: fully described by the user.
      if (!user.bin || !user.modes || typeof user.modes !== 'object') {
        warnings.push(t('agents.missingFields', { id }));
        continue;
      }
      const modes = {};
      for (const m of MODE_ORDER) if (isStrArray(user.modes[m])) modes[m] = user.modes[m];
      if (!Object.keys(modes).length) {
        warnings.push(t('agents.noValidMode', { id }));
        continue;
      }
      agent = {
        id,
        label: typeof user.label === 'string' ? user.label.slice(0, 24) : id,
        color: /^#[0-9a-f]{6}$/i.test(user.color || '') ? user.color : '#888888',
        bin: [],
        prompt: user.prompt === 'arg' ? 'arg' : 'stdin',
        promptFlag: typeof user.promptFlag === 'string' ? user.promptFlag : undefined,
        output: user.output === 'stream-json' ? 'stream-json' : 'text',
        base: isStrArray(user.base) ? user.base : [],
        modes,
        tail: isStrArray(user.tail) ? user.tail : [],
        modelFlag: typeof user.modelFlag === 'string' ? user.modelFlag : undefined,
        models: [],
        env: isStrArray(user.env) ? user.env : [],
        custom: true,
      };
    }
    if (typeof user.bin === 'string') agent.binOverride = user.bin;
    if (isModel(user.model)) agent.model = user.model;
    if (Array.isArray(user.models)) agent.models = user.models.filter(isModel).slice(0, 30);
    if (agent.model && !agent.models.includes(agent.model)) agent.models.unshift(agent.model);
    agent.extraArgs = [];
    if (user.extraArgs !== undefined) {
      if (!isStrArray(user.extraArgs)) {
        warnings.push(t('agents.extraArgsType', { id }));
      } else {
        const bad = user.extraArgs.filter(isDangerousArg);
        if (bad.length) {
          warnings.push(t('agents.argsRejected', { id, args: bad.join(', ') }));
        }
        agent.extraArgs = user.extraArgs.filter((a) => !isDangerousArg(a));
      }
    }
    out[id] = agent;
  }
  return { agents: out, warnings };
}

/**
 * Builds argv (no shell). The prompt is either sent on stdin or passed as a
 * single argument; it is never interpreted by a shell.
 */
function buildInvocation(agent, mode, prompt, { model, resume, trusted } = {}) {
  const modeArgs = agent.modes[mode];
  if (!modeArgs) throw new Error(t('errors.modeNotOffered', { agent: agent.label, mode: MODES[mode]?.label || mode }));
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error(t('errors.emptyPrompt'));
  if (prompt.includes('\0')) throw new Error(t('errors.invalidPrompt'));

  if (model != null && !isModel(model)) throw new Error(t('errors.invalidModel'));
  if (resume != null && !SESSION_RE.test(resume)) throw new Error(t('errors.invalidSession'));

  const argv = [...(agent.base || []), ...modeArgs];
  if (trusted && agent.trustFlag) argv.push(agent.trustFlag);
  const chosen = model === undefined ? agent.model : model; // null = the CLI's default model
  if (chosen && agent.modelFlag) argv.push(agent.modelFlag, chosen);
  if (resume && agent.resumeFlag) argv.push(agent.resumeFlag, resume);
  argv.push(...(agent.extraArgs || []));

  let stdin = null;
  let logArgv;
  if (agent.prompt === 'stdin') {
    stdin = prompt;
    argv.push(...(agent.tail || []));
    logArgv = [...argv];
  } else {
    // A prompt starting with "-" must not be read as an option.
    const safePrompt = prompt.startsWith('-') ? ` ${prompt}` : prompt;
    logArgv = [...argv];
    if (agent.promptFlag) {
      argv.push(agent.promptFlag);
      logArgv.push(agent.promptFlag);
    }
    argv.push(safePrompt, ...(agent.tail || []));
    logArgv.push('<prompt>', ...(agent.tail || []));
  }
  return { argv, stdin, logArgv };
}

module.exports = { MODES, MODE_ORDER, BUILTIN, resolveAgents, buildInvocation, isDangerousArg, isModel };
