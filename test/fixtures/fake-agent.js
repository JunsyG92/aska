#!/usr/bin/env node
// Faux CLI d'agent pour les tests : son comportement dépend de FAKE_MODE ou du prompt.
const args = process.argv.slice(2);
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', async () => {
  const prompt = stdin || args[args.length - 1] || '';
  // La balise [mode] est lue dans la dernière demande (le prompt peut contenir l'historique).
  const tags = [...prompt.matchAll(/\[(echo|hang|flood|fail|stream|text)\]/g)];
  const mode = process.env.FAKE_MODE || (tags.length ? tags[tags.length - 1][1] : 'text');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const j = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  if (process.env.FAKE_LOG) require('fs').appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, stdin }) + '\n');
  if (mode === 'echo') {
    process.stdout.write(JSON.stringify({ args, stdin, env: Object.keys(process.env).sort(), cwd: process.cwd() }));
  } else if (mode === 'hang') {
    process.on('SIGTERM', () => {}); // ignore SIGTERM : seul SIGKILL l'arrête
    setInterval(() => {}, 1000);
    process.stdout.write('started\n');
  } else if (mode === 'flood') {
    const chunk = 'x'.repeat(65536);
    setInterval(() => process.stdout.write(chunk), 1);
  } else if (mode === 'fail') {
    process.stderr.write('\x1b[31mauth error: not logged in\x1b[0m\n');
    process.exit(3);
  } else if (mode === 'stream') {
    const resumed = args.includes('--resume');
    const chosen = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'fake-model-1';
    j({ type: 'system', subtype: 'init', model: chosen, session_id: 'sess-0001-abcd' });
    if (resumed) {
      j({ type: 'assistant', message: { content: [{ type: 'text', text: 'Suite de la session : `preload.js` expose une API minimale.' }] } });
      j({ type: 'result', subtype: 'success', is_error: false, result: 'fin', session_id: 'sess-0001-abcd' });
      return;
    }
    const words = '## Résumé\n\nVoici **trois** points sur `main.js` :\n\n- la fenêtre est créée au démarrage\n- le raccourci bascule son affichage\n- chaque appel IPC est validé\n\n```js\nconst ok = true;\n```\n'.split(/(?<= )/);
    j({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
    for (const w of words) {
      j({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: w } } });
      await sleep(Number(process.env.FAKE_DELAY || 15));
    }
    j({ type: 'assistant', message: { content: [{ type: 'text', text: words.join('') }, { type: 'tool_use', name: 'Read', input: { file_path: 'src/main/main.js' } }] } });
    await sleep(Number(process.env.FAKE_DELAY || 15) * 20);
    j({ type: 'result', subtype: 'success', is_error: false, result: 'fin', permission_denials: prompt.includes('deny') ? [{ tool_name: 'Bash' }, { tool_name: 'Edit' }] : [] });
  } else {
    process.stdout.write('Bonjour depuis le faux agent.\n');
  }
});
