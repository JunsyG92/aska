'use strict';
// Pull request guards: spot, without AI, what a malicious contribution would add
// to spy on the user or send their data away (network call, reading secrets,
// obfuscated code, install-time script, modified CI...).
//
// Run by .github/workflows/pr-review.yml from the main branch (never from the PR),
// so a PR cannot switch these rules off for itself. These are signals to review,
// not proof, and finding none is no guarantee.

const LEVELS = ['info', 'medium', 'high', 'critical'];
const ICON = { info: '🔵', medium: '🟡', high: '🟠', critical: '🔴', none: '🟢', low: '🟢' };
const GUARD_MARKER = '<!-- aska-pr-guard -->';
const AI_MARKER = '<!-- aska-ai-review -->';

const rank = (level) => LEVELS.indexOf(level);
const maxLevel = (levels) => levels.reduce((m, l) => (rank(l) > rank(m) ? l : m), 'info');

// Invisible or text-direction characters ("Trojan Source"): the code shown in
// review is not the code that runs.
const HIDDEN_CHARS = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF\u00AD]/;

const CODE_FILE = /\.(c?js|mjs|ts|tsx|jsx|sh|bash|ps1|psm1|cmd|bat|py|html?|ya?ml|json)$/i;
const EXECUTABLE_FILE = /\.(exe|dll|so|dylib|node|bin|msi|dmg|appimage|deb|rpm|jar|wasm|pyc)$/i;

// Hosts the project already mentions (agent docs, repository). Any other address
// added to code is reported.
const KNOWN_HOSTS = [
  'github.com', 'docs.github.com', 'cursor.com', 'ollama.com', 'code.claude.com', 'claude.ai', 'claude.com',
  'anthropic.com', 'docs.anthropic.com', 'openai.com', 'example.com', 'example.org', 'semver.org',
  'conventionalcommits.org', 'www.conventionalcommits.org', 'keepachangelog.com', 'nodejs.org', 'electronjs.org',
  'www.electronjs.org', 'json-schema.org', 'www.apple.com', 'opensource.org', 'www.contributor-covenant.org',
];

/** Rules applied to every added line of a code file. */
const LINE_RULES = [
  {
    id: 'hidden', level: 'critical', test: (t) => HIDDEN_CHARS.test(t),
    why: 'Invisible or text-reversing character: the reviewed code may differ from the code that runs ("Trojan Source").',
  },
  {
    id: 'electron', level: 'critical',
    test: (t) => /nodeIntegration\s*:\s*true|contextIsolation\s*:\s*false|sandbox\s*:\s*false|webSecurity\s*:\s*false|allowRunningInsecureContent\s*:\s*true|enableRemoteModule|['"]--no-sandbox['"]|disable-web-security/.test(t),
    why: 'Weakens Electron isolation: a page or an agent answer could reach the system.',
  },
  {
    id: 'network', level: 'high',
    test: (t) => /\brequire\(\s*['"](?:node:)?(?:https?|http2|net|tls|dgram|dns)['"]\s*\)|\bfetch\s*\(|XMLHttpRequest|\bWebSocket\b|\bnet\.(?:request|fetch)\b|sendBeacon|\bundici\b|\baxios\b|\.connect\(\s*\d/.test(t),
    why: 'New network access. Aska makes none itself (only the agent CLIs connect): it needs a reason.',
  },
  {
    id: 'download', level: 'high',
    test: (t) => /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|nc|ncat|scp|rsync)\b\s+\S/.test(t),
    why: 'Downloads or sends data from the command line.',
  },
  {
    id: 'exec', level: 'high',
    test: (t) => /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.(?:run\w*|compileFunction|Script)\b|\brequire\(\s*[^'"`\s)]|\bimport\(\s*[^'"`\s)]|shell\s*:\s*true|\bsh\s+-c\b|\bbash\s+-c\b|\|\s*(?:sudo\s+)?(?:ba|z)?sh\b(?![|\w])|IEX\b|Invoke-Expression/.test(t),
    why: 'Runs code built on the fly, or goes through a shell.',
  },
  {
    id: 'process', level: 'medium',
    test: (t) => /child_process|\b(?:spawn|exec|execFile|fork)(?:Sync)?\s*\(/.test(t),
    why: 'Starts a program. Aska should only start the agent CLIs, without a shell.',
  },
  {
    id: 'obfuscation', level: 'high',
    test: (t) => /['"`][A-Za-z0-9+/=_-]{160,}['"`]|(?:\\x[0-9a-fA-F]{2}){8,}|(?:\\u[0-9a-fA-F]{4}){8,}|String\.fromCharCode|\batob\s*\(|['"](?:base64|hex)['"]\s*\)/.test(t),
    why: 'Encoded data or obfuscated code: its real content cannot be read in review.',
  },
  {
    id: 'secrets', level: 'high',
    test: (t) => /\.ssh\b|id_rsa|id_ed25519|\.aws\b|\.gnupg|\.kube\b|\.docker\/config|\.netrc|\.npmrc|\.git-credentials|\.pgpass|keychain|Keychains|Login Data|Cookies\b|wallet|\.config\/(?:gh|github-copilot|gcloud)|credentials\.json|auth\.json|\.claude\.json|\.codex\/|secret-tool|security\s+find-(?:generic|internet)-password/i.test(t),
    why: 'Mentions secrets or credentials of the machine. Only legitimate to protect them (deny list).',
  },
  {
    id: 'environment', level: 'high',
    test: (t) => /JSON\.stringify\(\s*process\.env|Object\.(?:keys|entries|values)\(\s*process\.env|\{\s*\.\.\.process\.env|printenv|\benv\s*>|Get-ChildItem\s+env:/i.test(t),
    why: 'Reads all environment variables, which often hold access tokens.',
  },
  {
    id: 'spying', level: 'high',
    test: (t) => /clipboard\.read|desktopCapturer|getUserMedia|uiohook|iohook|node-global-key|before-input-event|screen\.getCursorScreenPoint|systemPreferences\.(?:getMediaAccess|askForMediaAccess)|xinput|xdotool\s+getwindow/.test(t),
    why: 'Reads the clipboard, the screen, the microphone or the keyboard.',
  },
  {
    id: 'persistence', level: 'medium',
    test: (t) => /crontab|LaunchAgents|LaunchDaemons|\.bashrc|\.zshrc|\.profile\b|systemd\/user|\\Run\\|RunOnce|schtasks|setLoginItemSettings|autostart/i.test(t),
    why: 'Starts something automatically, or changes the shell profile.',
  },
  {
    id: 'csp', level: 'high', test: (t) => /Content-Security-Policy/i.test(t),
    why: 'Changes the content security policy of the UI.',
  },
];

const isGuardFile = (p) => p.startsWith('scripts/ci/') || p === 'test/pr-guard.test.js' || p === '.github/workflows/pr-review.yml';

/** Rules on the file itself: its path and the kind of change. */
function fileRules(file) {
  const out = [];
  const p = file.filename;
  const add = (level, id, why) => out.push({ level, id, why, file: p, line: null, excerpt: '' });
  if (isGuardFile(p)) {
    add('high', 'guards', 'Changes these guards, which contain the patterns they look for: line rules do not apply here. Review the whole file; the changes only take effect after merge.');
  } else if (p.startsWith('.github/workflows/') || p.startsWith('.github/actions/')) {
    add('high', 'ci', 'Changes CI: a workflow can read the repository secrets or publish a release.');
  } else if (p.startsWith('.github/')) {
    add('medium', 'github', 'Changes the GitHub settings of the repository (reviewers, rules, Dependabot...).');
  }
  if (/^scripts\/install|^scripts\/setup-/.test(p)) add('high', 'install', 'Script run on the machine of a user or maintainer.');
  if (/^src\/main\/(?:main|security|launch|agents|runner|preload|config|settings)\.js$/.test(p)) {
    add('high', 'core', 'Core of Aska security (window, calls from the UI, agent launch, filtering, permissions).');
  }
  if (p === 'src/renderer/index.html') add('medium', 'ui', 'UI page: check the content security policy and the scripts it loads.');
  if (/(^|\/)(?:\.npmrc|\.yarnrc(?:\.yml)?|\.gitmodules|\.gitattributes|\.nvmrc)$/.test(p)) {
    add('high', 'tooling', 'Changes where packages, submodules or tool versions come from.');
  }
  if (/(^|\/)package-lock\.json$/.test(p)) add('medium', 'lockfile', 'Locked dependencies changed: check they match package.json.');
  if (EXECUTABLE_FILE.test(p) && file.status !== 'removed') add('critical', 'binary', 'Adds an executable or a binary library: it cannot be reviewed.');
  else if (!file.patch && file.status !== 'removed' && file.status !== 'renamed') {
    add(CODE_FILE.test(p) ? 'high' : 'info', 'unreadable', 'GitHub gives no diff (binary or too large file): check it by hand.');
  }
  return out;
}

/** Added lines of a unified patch, with their number in the new version. */
function addedLines(patch) {
  const lines = [];
  let n = 0;
  for (const raw of (patch || '').split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) { n = Number(h[1]); continue; }
    if (raw.startsWith('+')) lines.push({ line: n++, text: raw.slice(1) });
    else if (raw.startsWith('-') || raw.startsWith('\\')) continue;
    else n++;
  }
  return lines;
}

/** Rules for package.json and the lockfile, line by line. */
function manifestRules(file, line) {
  const out = [];
  if (/(^|\/)package\.json$/.test(file.filename)) {
    if (/"(?:pre|post)?install"\s*:|"prepare"\s*:|"prepublish(?:Only)?"\s*:|"prepack"\s*:/.test(line.text)) {
      out.push({ level: 'critical', id: 'npm-script', why: 'Script run automatically by "npm install", on every machine that installs Aska.' });
    } else if (/^\s*"(?:@[\w.-]+\/)?[\w.-]+"\s*:\s*"(?:[~^<>=]*\d|npm:|git|https?:|file:|github:|[\w-]+\/[\w-]+)/.test(line.text)
      && !/^\s*"(?:version|node|npm|name|main|license|type|description)"\s*:/.test(line.text)) {
      out.push({ level: 'high', id: 'dependency', why: 'Dependency added or changed: check the package (exact name, author, popularity).' });
    }
  }
  if (/(^|\/)package-lock\.json$/.test(file.filename)) {
    const m = /"resolved"\s*:\s*"([^"]+)"/.exec(line.text);
    if (m && !m[1].startsWith('https://registry.npmjs.org/')) {
      out.push({ level: 'critical', id: 'package-source', why: 'Package downloaded from somewhere other than the official npm registry.' });
    }
    if (/"hasInstallScript"\s*:\s*true/.test(line.text)) {
      out.push({ level: 'high', id: 'package-script', why: 'A dependency runs a script when it is installed.' });
    }
  }
  return out;
}

function unknownHosts(text) {
  const hosts = [];
  for (const m of text.matchAll(/\b(?:https?|wss?|ftp):\/\/([a-z0-9.-]+)/gi)) {
    const h = m[1].toLowerCase();
    if (h === 'localhost' || /^127\./.test(h)) continue;
    if (!KNOWN_HOSTS.some((k) => h === k || h.endsWith('.' + k))) hosts.push(h);
  }
  return hosts;
}

/**
 * Analyses the files of a PR (GitHub "pulls/files" API format: filename, status,
 * patch, previous_filename). Returns the signals found.
 */
function analyze(files) {
  const findings = [];
  for (const file of files) {
    findings.push(...fileRules(file));
    if (isGuardFile(file.filename)) continue;
    const code = CODE_FILE.test(file.filename);
    for (const line of addedLines(file.patch)) {
      const hit = (r) => findings.push({ level: r.level, id: r.id, why: r.why, file: file.filename, line: line.line, excerpt: line.text });
      // Hidden characters count everywhere, documentation included.
      if (!code) { if (HIDDEN_CHARS.test(line.text)) hit(LINE_RULES[0]); continue; }
      for (const r of LINE_RULES) if (r.test(line.text)) hit(r);
      for (const r of manifestRules(file, line)) hit(r);
      const hosts = unknownHosts(line.text);
      if (hosts.length && !/(^|\/)package-lock\.json$/.test(file.filename)) {
        hit({ level: 'medium', id: 'address', why: `Address unknown to the project: ${[...new Set(hosts)].join(', ')}.` });
      }
    }
  }
  return dedupe(findings);
}

// Same rule on the same file: keep the first 3 lines and count the rest.
function dedupe(findings) {
  const groups = new Map();
  for (const f of findings) {
    const key = `${f.file}\0${f.id}\0${f.why}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const out = [];
  for (const list of groups.values()) {
    list.slice(0, 3).forEach((f, i) => out.push(i === 2 && list.length > 3 ? { ...f, more: list.length - 3 } : f));
  }
  return out.sort((a, b) => rank(b.level) - rank(a.level) || a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0));
}

/**
 * Makes text that comes from the PR safe in a comment: no mention (@someone)
 * outside code, no fake marker, no hidden character, no broken table.
 */
function clean(text, max = 140, { inCode = false } = {}) {
  let s = String(text == null ? '' : text)
    .replace(/[\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF\u00AD]/g, (c) => `<U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}>`)
    .replace(/<!--|-->/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/@/g, inCode ? '@' : '@\u200B')
    .replace(/\|/g, '\\|')
    .trim();
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
}
// GitHub creates no mention inside a code span: "@" stays as is there.
const code = (text, max = 100) => (text ? '`' + clean(text, max, { inCode: true }).replace(/`/g, 'ˋ') + '`' : '');

const FIRST_TIMERS = ['FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE'];

function renderGuard(findings, { files = 0, association = '', fromFork = false } = {}) {
  const level = findings.length ? maxLevel(findings.map((f) => f.level)) : null;
  const lines = [GUARD_MARKER, '### 🛡️ Security guards', ''];
  const who = [];
  if (FIRST_TIMERS.includes(association)) who.push('first contribution');
  if (fromFork) who.push('from a fork');
  if (who.length) lines.push(`> Author: ${who.join(', ')}. Do not run this branch on your machine before reviewing the code.`, '');
  if (!level) {
    lines.push(`✅ **Nothing sensitive found** in ${files} file(s): no network access, command, secret, dependency or critical file touched.`);
  } else {
    const verdict = {
      critical: 'do not merge without understanding every red point',
      high: 'review the points below carefully',
      medium: 'a few points to check',
      info: 'for information',
    }[level];
    lines.push(`${ICON[level]} **Level ${level}**: ${verdict}.`, '', '| | File | Why | Excerpt |', '| :-: | --- | --- | --- |');
    for (const f of findings.slice(0, 40)) {
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`| ${ICON[f.level]} | ${code(where, 90)} | ${clean(f.why, 220)}${f.more ? ` (+${f.more} more line(s))` : ''} | ${code(f.excerpt)} |`);
    }
    if (findings.length > 40) lines.push('', `... and ${findings.length - 40} more signal(s).`);
  }
  lines.push('', '<sub>Automatic analysis without AI, run from the main branch: the PR cannot change it for itself. These are signals to review, not proof; finding none is no guarantee.</sub>');
  return { level, body: lines.join('\n') };
}

const AI_LEVELS = ['none', 'low', 'medium', 'high', 'critical'];

/** AI review comment, from its structured output (untrusted text). */
function renderAi(raw) {
  let r;
  try { r = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { r = null; }
  if (!r || typeof r !== 'object') return null;
  const risk = AI_LEVELS.includes(r.risk) ? r.risk : 'medium';
  const lines = [AI_MARKER, '### 🤖 AI review of the PR', ''];
  lines.push(`**In short**: ${clean(r.summary, 1200) || '(no summary)'}`, '');
  const changes = Array.isArray(r.changes) ? r.changes.slice(0, 10) : [];
  if (changes.length) lines.push(...changes.map((c) => `- ${clean(c, 300)}`), '');
  lines.push(`**Risk to your data**: ${ICON[risk]} ${risk}${r.risk_reason ? `. ${clean(r.risk_reason, 600)}` : ''}`);
  if (r.manipulation_attempt) {
    lines.push('', '> ⚠️ **The PR contains text that tries to give orders to the reviewing AI.** Treat it as suspicious, whatever level is shown.');
  }
  if (r.complete === false) lines.push('', '> The AI could not read the whole PR: the human review must cover the rest.');
  const findings = Array.isArray(r.findings) ? r.findings.slice(0, 20) : [];
  if (findings.length) {
    lines.push('', '| | File | Point | Explanation |', '| :-: | --- | --- | --- |');
    for (const f of findings) {
      const level = AI_LEVELS.includes(f && f.severity) ? f.severity : 'medium';
      const where = f && f.file ? code(`${f.file}${Number.isInteger(f.line) && f.line > 0 ? ':' + f.line : ''}`, 90) : '';
      lines.push(`| ${ICON[level]} | ${where} | ${clean(f && f.title, 120)} | ${clean(f && f.explanation, 400)} |`);
    }
  }
  lines.push('', '<sub>The AI can be wrong, or misled by the content of the PR: this review helps the human review, it does not replace it. It read the diff without running any code.</sub>');
  const level = { none: null, low: 'info', medium: 'medium', high: 'high', critical: 'critical' }[risk];
  return { level: r.manipulation_attempt ? 'critical' : level, body: lines.join('\n') };
}

/** Creates or updates Aska's comment on the PR (one per marker). */
async function upsertComment({ github, context, core }, marker, body) {
  const { owner, repo } = context.repo;
  const issue_number = context.payload.pull_request.number;
  try {
    const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number, per_page: 100 });
    const mine = comments.find((c) => c.user && c.user.type === 'Bot' && c.body && c.body.startsWith(marker));
    if (mine) await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
    else await github.rest.issues.createComment({ owner, repo, issue_number, body });
  } catch (e) {
    // Read-only token (Dependabot PR): the run summary is enough.
    core.warning(`Could not comment on the PR: ${e.message}`);
  }
}

async function report({ core }, level, body) {
  await core.summary.addRaw(body.replace(/^<!--.*-->\n/, '')).write();
  if (level === 'critical') core.setFailed('Critical security signal: see the comment on the PR.');
  else if (level === 'high') core.warning('Security points to review: see the comment on the PR.');
}

/** Entry point of the "Guards" job (actions/github-script). */
async function runGuard(ctx) {
  const { github, context } = ctx;
  const pr = context.payload.pull_request;
  const files = await github.paginate(github.rest.pulls.listFiles, {
    ...context.repo, pull_number: pr.number, per_page: 100,
  });
  const findings = analyze(files);
  const { level, body } = renderGuard(findings, {
    files: files.length,
    association: pr.author_association,
    fromFork: !!(pr.head.repo && pr.head.repo.full_name !== pr.base.repo.full_name),
  });
  await upsertComment(ctx, GUARD_MARKER, body);
  await report(ctx, level, body);
}

/** Publishes the AI review (structured output of claude-code-action). */
async function publishAi(ctx, raw) {
  const out = renderAi(raw);
  if (!out) {
    ctx.core.warning('The AI review gave no usable result.');
    return;
  }
  await upsertComment(ctx, AI_MARKER, out.body);
  await report(ctx, out.level, out.body);
}

module.exports = { analyze, addedLines, renderGuard, renderAi, clean, runGuard, publishAi, GUARD_MARKER, AI_MARKER };
