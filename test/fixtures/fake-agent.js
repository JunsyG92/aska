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
  if (mode === 'echo') {
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
    j({ type: 'assistant', message: { content: [{ type: 'text', text: words.join('') }, { type: 'tool_use', name: 'Read', input: { file_path: 'src/main/main.js' } }] } });
    await sleep(Number(process.env.FAKE_DELAY || 15) * 20);
    j({ type: 'result', subtype: 'success', is_error: false, result: 'fin', permission_denials: prompt.includes('deny') ? [{ tool_name: 'Bash' }, { tool_name: 'Edit' }] : [] });
  } else {
    process.stdout.write('Hello from the fake agent.\n');
  }
});
