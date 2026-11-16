'use strict';
// Définition des agents : comment chaque CLI est invoqué, et à quoi correspond
// chaque mode de permission. Aucun mode n'utilise un flag « bypass » du CLI.

const MODES = {
  read: {
    label: 'Lecture seule',
    hint: "L'agent lit et répond, sans rien modifier",
  },
  edit: {
    label: 'Édition',
    hint: "L'agent peut modifier les fichiers du dossier",
  },
  auto: {
    label: 'Autonome',
    hint: "L'agent peut modifier des fichiers et lancer des commandes",
  },
};
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
      read: ['--permission-mode', 'plan'],
      edit: ['--permission-mode', 'acceptEdits'],
      auto: ['--permission-mode', 'auto'],
    },
    modelFlag: '--model',
    models: ['opus', 'sonnet', 'haiku'],
    resumeFlag: '--resume', // reprise native : le CLI retrouve tout le contexte du fil
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
      // workspace-write : écritures limitées au dossier, sans réseau.
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
    prompt: 'arg',
    promptFlag: '-p',
    output: 'text',
    base: ['-s'],
    modes: {
      read: ['--deny-tool', 'shell', '--deny-tool', 'write'],
      edit: ['--allow-tool', 'write', '--deny-tool', 'shell'],
      // Copilot n'a pas de bac à sable : tout est permis sauf la liste noire.
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
    bin: ['cursor-agent'],
    prompt: 'arg',
    output: 'stream-json',
    base: ['-p', '--output-format', 'stream-json'],
    modes: {
      read: ['--mode', 'ask'],
      // Le CLI Cursor n'applique les modifications qu'avec --force, qui autorise
      // aussi les commandes : il n'existe pas de mode « édition seule ».
      auto: ['--force'],
    },
    modelFlag: '--model',
    env: ['CURSOR_*'],
    install: 'curl https://cursor.com/install -fsS | bash',
  },
};

// Flags refusés dans `extraArgs` : ils désactivent les garde-fous du CLI.
const DANGEROUS_ARG = [
  /^--dangerously/i,
  /^--allow-dangerously/i,
  /^--yolo$/i,
  /^--force$/i,
  /^-f$/,
  /^--allow-all/i,
  /^--full-auto$/i,
  /bypassPermissions/i,
  /danger-full-access/i,
  /^--permission-mode/i,
  /^--sandbox/i,
  /^-s$/,
  /^--ask-for-approval/i,
  /^--mode(=|$)/i,
];

function isDangerousArg(arg) {
  return DANGEROUS_ARG.some((re) => re.test(arg));
}

const MODEL_RE = /^[A-Za-z0-9][\w.:\/\[\]-]{0,79}$/;
const SESSION_RE = /^[A-Za-z0-9][\w-]{7,79}$/;
const isModel = (m) => typeof m === 'string' && MODEL_RE.test(m);

const isStrArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && !s.includes('\0'));

/** Fusionne les agents intégrés avec la config utilisateur (déjà validée en intégrité). */
function resolveAgents(userAgents = {}) {
  const out = {};
  const warnings = [];
  const ids = new Set([...Object.keys(BUILTIN), ...Object.keys(userAgents || {})]);
  for (const id of ids) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) {
      warnings.push(`Agent ignoré : identifiant invalide « ${id} »`);
      continue;
    }
    const base = BUILTIN[id];
    const user = (userAgents && userAgents[id]) || {};
    if (user.enabled === false) continue;
    let agent;
    if (base) {
      agent = { ...base, id, modes: { ...base.modes }, models: [...(base.models || [])] };
    } else {
      // Agent personnalisé : entièrement décrit par l'utilisateur.
      if (!user.bin || !user.modes || typeof user.modes !== 'object') {
        warnings.push(`Agent « ${id} » ignoré : "bin" et "modes" sont requis`);
        continue;
      }
      const modes = {};
      for (const m of MODE_ORDER) if (isStrArray(user.modes[m])) modes[m] = user.modes[m];
      if (!Object.keys(modes).length) {
        warnings.push(`Agent « ${id} » ignoré : aucun mode valide`);
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
        warnings.push(`Agent « ${id} » : "extraArgs" doit être une liste de chaînes`);
      } else {
        const bad = user.extraArgs.filter(isDangerousArg);
        if (bad.length) {
          warnings.push(`Agent « ${id} » : arguments refusés (${bad.join(', ')}) — les permissions passent par les modes`);
        }
        agent.extraArgs = user.extraArgs.filter((a) => !isDangerousArg(a));
      }
    }
    out[id] = agent;
  }
  return { agents: out, warnings };
}

/**
 * Construit argv (sans shell). Le prompt est soit envoyé sur stdin, soit passé
 * comme un argument unique ; il n'est jamais interprété par un shell.
 */
function buildInvocation(agent, mode, prompt, { model, resume } = {}) {
  const modeArgs = agent.modes[mode];
  if (!modeArgs) throw new Error(`${agent.label} ne propose pas le mode « ${MODES[mode]?.label || mode} »`);
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Prompt vide');
  if (prompt.includes('\0')) throw new Error('Prompt invalide');

  if (model != null && !isModel(model)) throw new Error('Nom de modèle invalide');
  if (resume != null && !SESSION_RE.test(resume)) throw new Error('Identifiant de session invalide');

  const argv = [...(agent.base || []), ...modeArgs];
  const chosen = model === undefined ? agent.model : model; // null = modèle par défaut du CLI
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
    // Un prompt commençant par « - » ne doit pas être lu comme une option.
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
