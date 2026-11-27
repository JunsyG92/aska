#!/usr/bin/env node
// Fake agent CLI for tests: its behavior depends on FAKE_MODE or on the prompt.
const args = process.argv.slice(2);
if (args[0] === '--help' || args[0] === 'help') {
  process.stdout.write(`Usage: fake [options]

Options:
  --fallback-model <model>   Fallback model (e.g. 'nope-fallback')
  --model <model>            Model for the current session. Provide an alias
                             (e.g. 'fable', 'opus', or 'sonnet') or a full name.
  --verbose                  Override 'verbose-thing'
`);
  process.exit(0);
}
if (args[0] === '--list-models') {
  process.stdout.write('Available models\n\nauto - Auto (current)\n\x1b[1mgpt-5.2-codex\x1b[0m - GPT-5.2 Codex\nsonnet-4.6-thinking - Claude Sonnet 4.6 Thinking\n\nTip: use --model <id>\n');
  process.exit(0);
}
// Fake "ollama": model list, and an answer preceded by a thinking block.
if (process.env.FAKE_MODE === 'ollama' && args[0] === 'list') {
  process.stdout.write('NAME                ID              SIZE      MODIFIED\nqwen3:8b            500a1f067a9f    5.2 GB    2 days ago\nllama3.2:latest     a80c4f17acd5    2.0 GB    3 weeks ago\n');
  process.exit(0);
}
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', async () => {
  const prompt = stdin || args[args.length - 1] || '';
  // The [mode] tag is read from the last request (the prompt may contain the history).
  const tags = [...prompt.matchAll(/\[(echo|hang|flood|fail|stream|text|md)\]/g)];
  const mode = process.env.FAKE_MODE || (tags.length ? tags[tags.length - 1][1] : 'text');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const j = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  if (process.env.FAKE_LOG) {
    const entry = { args, stdin, cwd: process.cwd(), env: Object.keys(process.env) };
    require('fs').appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\n');
  }
  if (mode === 'ollama') {
    const out = ['Thinking...\n', 'The model thinks out loud.\n', '...done thinking.\n\n', `Local answer from ${args[1]}.\n`];
    for (const c of out) {
      process.stdout.write(c);
      await sleep(Number(process.env.FAKE_DELAY || 15) * 4);
    }
  } else if (mode === 'echo') {
    process.stdout.write(JSON.stringify({ args, stdin, env: Object.keys(process.env).sort(), cwd: process.cwd() }));
  } else if (mode === 'hang') {
    process.on('SIGTERM', () => {}); // ignore SIGTERM: only SIGKILL stops it
    setInterval(() => {}, 1000);
    process.stdout.write('started\n');
  } else if (mode === 'flood') {
    const chunk = 'x'.repeat(65536);
    setInterval(() => process.stdout.write(chunk), 1);
  } else if (mode === 'fail') {
    process.stderr.write('\x1b[31mauth error: not logged in\x1b[0m\n');
    process.exit(3);
  } else if (mode === 'md') {
    process.stdout.write([
      '## Comparison',
      '',
      'A text in *italics*, in **bold**, ~~strikethrough~~, with `some code` and a [link to the docs](https://example.com/doc?a=1).',
      'Bare link: https://example.org/page. Trap: [click](javascript:alert(1)) and <b>no HTML</b>.',
      '',
      '| Agent | Sandbox | Score |',
      '| :-- | :-: | --: |',
      '| Codex | yes | **9** |',
      '| Cursor | no | 6 |',
      '',
      '> A quote',
      '> on two lines',
      '',
      '1. First point',
      '   - sub-point `a`',
      '   - sub-point b',
      '2. Second point',
      '',
      '- [x] done',
      '- [ ] to do',
      '',
      '---',
      '',
      '```bash',
      'npm test   # all green',
      '```',
      '',
    ].join('\n'));
  } else if (mode === 'stream' && prompt.includes('<results>')) {
    // A next wave (tasks): nothing more at the last wave; otherwise new rights if the goal says so.
    j({ type: 'system', subtype: 'init', model: 'fake-model-1', session_id: 'sess-0005-wave' });
    const goal = (prompt.match(/<goal>\n([\s\S]*?)\n<\/goal>/) || [])[1] || '';
    const wave = prompt.includes('wave 3 of 3')
      ? { summary: 'Objectif atteint.', subtasks: [] }
      : goal.includes('[newrights]')
        ? { summary: 'Lancer les tests de web.', subtasks: [{ repo: 'web', bot: { label: 'Testeur', soul: 'Tu lances les tests.', maxMode: 'edit', allow: ['npm test'] }, mode: 'edit', instruction: 'Lance npm test' }] }
        : { summary: 'Relire encore.', subtasks: [{ repo: 'api', continues: 1, bot: 'trad', mode: 'read', instruction: 'Relis le README encore' }] };
    await sleep(Number(process.env.FAKE_DELAY || 15) * 10);
    j({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(wave) }] } });
    j({ type: 'result', subtype: 'success', is_error: false, result: 'fin' });
  } else if (mode === 'stream' && prompt.includes('<goal>')) {
    // The orchestrator's plan (tasks): the repositories it was given, one bot of each kind.
    j({ type: 'system', subtype: 'init', model: 'fake-model-1', session_id: 'sess-0003-plan' });
    const plan = {
      summary: 'Deux dépôts à mettre à jour.',
      subtasks: [
        { repo: 'api', bot: 'trad', mode: 'read', instruction: 'Lis le README' },
        { repo: 'web', bot: { label: 'Bumper', soul: 'Tu fais les bumps.', maxMode: 'edit', allow: ['git commit', 'rm'] }, mode: 'edit', instruction: 'Passe à Node 26 et committe' },
        { repo: '../ailleurs', bot: 'trad', instruction: 'x' },
      ],
    };
    await sleep(Number(process.env.FAKE_DELAY || 15) * 10);
    j({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(plan) }] } });
    j({ type: 'result', subtype: 'success', is_error: false, result: 'fin' });
  } else if (mode === 'stream' && prompt.includes('<description>')) {
    // A bot drafted from a description (settings): a proposal as JSON, after a sentence.
    j({ type: 'system', subtype: 'init', model: 'fake-model-1', session_id: 'sess-0002-draft' });
    const draft = {
      label: 'Notes de réunion',
      description: 'Résume mes notes de réunion en Markdown',
      soul: '# Notes de réunion\n\nTu résumes des notes de réunion.\n\n## Sécurité\n\n- Tu n’écris que si on te le demande.',
      emblem: 'pen',
      maxMode: 'edit',
      allow: ['git add', 'rm'],
    };
    await sleep(Number(process.env.FAKE_DELAY || 15) * 10);
    j({ type: 'assistant', message: { content: [{ type: 'text', text: 'Voici la proposition :\n' + JSON.stringify(draft) }] } });
    j({ type: 'result', subtype: 'success', is_error: false, result: 'fin' });
  } else if (mode === 'stream' && prompt.includes('[slow]')) {
    // A long subtask (tasks view): a first sentence, then nothing until it is stopped.
    j({ type: 'system', subtype: 'init', model: 'fake-model-1', session_id: 'sess-0004-slow' });
    j({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
    j({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Je commence par **package.json**.' } } });
    await sleep(60000);
    j({ type: 'result', subtype: 'success', is_error: false, result: 'fin' });
  } else if (mode === 'stream') {
    const resumed = args.includes('--resume');
    const chosen = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'fake-model-1';
    j({ type: 'system', subtype: 'init', model: chosen, session_id: 'sess-0001-abcd' });
    if (resumed) {
      await sleep(Number(process.env.FAKE_DELAY || 15) * 20);
      j({ type: 'assistant', message: { content: [{ type: 'text', text: 'Session continued: `preload.js` exposes a minimal API.' }] } });
      j({ type: 'result', subtype: 'success', is_error: false, result: 'fin', session_id: 'sess-0001-abcd', permission_denials: prompt.includes('deny') ? [{ tool_name: 'Bash' }] : [] });
      return;
    }
    const words = '## Summary\n\nHere are **three** points about `main.js`:\n\n- the window is created at startup\n- the shortcut toggles its visibility\n- every IPC call is validated\n\n```js\nconst ok = true;\n```\n'.split(/(?<= )/);
    j({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
    for (const w of words) {
      j({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: w } } });
      await sleep(Number(process.env.FAKE_DELAY || 15));
    }
    // A subtask of a task (asked for a report): commits if told to, then reports.
    let report = '';
    if (prompt.includes('"followUp"')) {
      const commits = [];
      if (prompt.includes('[commit]')) {
        const fs = require('fs');
        const { spawnSync } = require('child_process');
        const g = (...a) => spawnSync('git', ['-c', 'user.name=Fake', '-c', 'user.email=fake@example.com', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
        fs.writeFileSync('.nvmrc', '26\n');
        g('add', '.nvmrc');
        g('commit', '-q', '-m', 'chore: node 26');
        commits.push(g('log', '-1', '--format=%h %s').stdout.trim());
      }
      report = '\n\n' + JSON.stringify({ status: 'done', summary: 'Node 26 en place. Les tests passent.', commits, followUp: '' });
      j({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: report } } });
    }
    j({ type: 'assistant', message: { content: [{ type: 'text', text: words.join('') + report }, { type: 'tool_use', name: 'Read', input: { file_path: 'src/main/main.js' } }] } });
    await sleep(Number(process.env.FAKE_DELAY || 15) * 20);
    j({ type: 'result', subtype: 'success', is_error: false, result: 'fin', permission_denials: prompt.includes('deny') ? [{ tool_name: 'Bash' }, { tool_name: 'Edit' }] : [] });
  } else {
    process.stdout.write('Hello from the fake agent.\n');
  }
});
