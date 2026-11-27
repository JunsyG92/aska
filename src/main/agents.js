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

// Commands never run, even inside an allowed prefix ("git push" allowed:
// "git push --force", "git push origin --delete x" still denied).
const ALWAYS_DENIED = [
  'git push --force*', 'git push * --force*', 'git push -f*', 'git push * -f*',
  'git push --delete*', 'git push * --delete*', 'git push -d*', 'git push * -d*', 'git push * :*', 'git push --mirror*', 'git push * --mirror*',
  'gh repo delete*', 'gh release delete*', 'gh api*',
];
const MODE_ORDER = ['read', 'edit', 'auto'];

// Read-only shell commands allowed to Copilot. None of them can write or run
// anything else: find (-delete, -exec), sed (-i), sort (-o), tree (-o), rg (--pre)
// and, in read-only mode, git log/diff/show (--output=file) are left out.
const COPILOT_READ_SHELL = ['ls', 'cat', 'head', 'tail', 'grep', 'wc', 'pwd', 'file', 'stat', 'git status'];
const COPILOT_EDIT_SHELL = [...COPILOT_READ_SHELL, 'git log', 'git diff', 'git show'];
const allowShell = (cmds) => cmds.flatMap((c) => ['--allow-tool', `shell(${c})`]);

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
    // A bot's personality, added to the system prompt. On --resume, the CLI keeps
    // the text of the first request (system prompt snapshot): see sessionKey in main.js.
    systemFlag: '--append-system-prompt',
    // Commands a bot may run without asking (bot.json "allow"), in a writing
    // mode only: "git commit" allows "git commit" and "git commit …". One
    // argument (comma list): the flag would take the next arguments otherwise.
    // Tested with Claude Code 2.1.332 (-p, acceptEdits): the allowed command
    // runs, any other command is denied without a prompt.
    allowFlag: (cmds) => ['--allowedTools', cmds.flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]).join(',')],
    // Always denied when commands are allowed: a deny rule wins over any allow
    // rule, so "git push" can never become a forced push or a remote deletion.
    denyFlag: () => ['--disallowedTools', ALWAYS_DENIED.map((c) => `Bash(${c})`).join(',')],
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
      // Copilot mostly reads files through the shell: denying the whole shell
      // ("--deny-tool shell", which beats any allow) left it blind. A closed list of
      // read commands is allowed; any other command stays refused, compound
      // commands included.
      read: [...allowShell(COPILOT_READ_SHELL), '--deny-tool', 'write'],
      edit: ['--allow-tool', 'write', ...allowShell(COPILOT_EDIT_SHELL)],
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
  ollama: {
    label: 'Ollama',
    color: '#8e8a83',
    bin: ['ollama'],
    // Local models: Ollama only answers, with no tool and no file access. Only the
    // read-only mode makes sense.
    prompt: 'stdin',
    output: 'ollama',
    base: ['run'],
    modes: { read: [] },
    modelPositional: true, // "ollama run <model>"
    requiresModel: true,
    env: ['OLLAMA_*'],
    install: 'https://ollama.com/download',
  },
};

/** Does the agent let you pick its model? */
const canPickModel = (agent) => !!(agent.modelFlag || agent.modelPositional);

/**
 * The model of a request: the bot's when it runs on its own agent (null: the
 * CLI's default, unless the agent needs a model), else the one picked for the
 * agent, else fallback() (Ollama: the first model installed).
 */
function chooseModel(agent, { bot = null, picked = null, fallback = () => null } = {}) {
  const own = bot && bot.agent === agent.id ? bot.model : undefined;
  if (own !== undefined && (own || !agent.requiresModel)) return own;
  return picked || fallback();
}

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
        // Option that takes a bot's personality; without it, the personality goes before the prompt.
        systemFlag: typeof user.systemFlag === 'string' && /^--[\w-]+$/.test(user.systemFlag) && !isDangerousArg(user.systemFlag) ? user.systemFlag : undefined,
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
function buildInvocation(agent, mode, prompt, { model, resume, trusted, system, allow = [] } = {}) {
  const modeArgs = agent.modes[mode];
  if (!modeArgs) throw new Error(t('errors.modeNotOffered', { agent: agent.label, mode: MODES[mode]?.label || mode }));
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error(t('errors.emptyPrompt'));
  if (prompt.includes('\0')) throw new Error(t('errors.invalidPrompt'));

  if (model != null && !isModel(model)) throw new Error(t('errors.invalidModel'));
  if (resume != null && !SESSION_RE.test(resume)) throw new Error(t('errors.invalidSession'));
  if (system != null && (!agent.systemFlag || typeof system !== 'string' || system.includes('\0'))) throw new Error(t('errors.invalidPrompt'));

  const chosen = model === undefined ? agent.model : model; // null = the CLI's default model
  if (!chosen && agent.requiresModel) throw new Error(t('errors.modelRequired', { agent: agent.label }));
  // Positional model ("ollama run <model>"): right after the base command.
  const argv = [...(agent.base || []), ...(chosen && agent.modelPositional ? [chosen] : []), ...modeArgs];
  if (trusted && agent.trustFlag) argv.push(agent.trustFlag);
  if (chosen && agent.modelFlag) argv.push(agent.modelFlag, chosen);
  if (resume && agent.resumeFlag) argv.push(agent.resumeFlag, resume);
  // Personality: never written to the audit log (replaced with <system>).
  const systemAt = system ? argv.push(agent.systemFlag, system) - 1 : -1;
  // Commands allowed to a bot: never in read-only mode, and only for a CLI that
  // can allow commands one by one (checked by the bots' loader, see bots.js).
  if (mode !== 'read' && agent.allowFlag && Array.isArray(allow) && allow.length) {
    argv.push(...agent.allowFlag(allow));
    if (agent.denyFlag) argv.push(...agent.denyFlag());
  }
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
  if (systemAt >= 0) logArgv[systemAt] = '<system>';
  return { argv, stdin, logArgv };
}

/**
 * Builds the invocation with as much history as the system's command line can
 * take (a CLI that receives the prompt as an argument can exceed it).
 * build(maxChars) returns an invocation whose history fits in maxChars characters
 * (0: no history); excess(inv) says how far it goes beyond the limit (0: it fits).
 * The oldest turns go first; if even the request alone is too long, an error.
 */
function fitInvocation(build, excess, maxChars) {
  let budget = maxChars;
  for (;;) {
    const inv = build(budget);
    const over = excess(inv);
    if (!over) return inv;
    if (budget <= 0) throw new Error(t('errors.promptTooLong'));
    // One history character takes at least one unit of the limit: removing
    // `over` of them (and a margin) is enough, unless whole turns stand in the way.
    budget = Math.max(0, budget - over - 500);
  }
}

module.exports = { ALWAYS_DENIED, MODES, MODE_ORDER, BUILTIN, resolveAgents, buildInvocation, fitInvocation, isDangerousArg, isModel, canPickModel, chooseModel };
