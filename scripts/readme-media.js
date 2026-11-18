'use strict';
// Régénère les images du README (docs/*.png et docs/demo.gif) à partir de la
// vraie application, pilotée avec de faux agents qui jouent un scénario.
//
//   xvfb-run -a -s "-screen 0 3200x2000x24" node scripts/readme-media.js
//
// Prérequis : Linux, ffmpeg, python3 avec Pillow (assemblage du GIF).
// ASKA_E2E_NO_SANDBOX=1 si le script est lancé en root.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('playwright');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

// ---------- faux agents : un scénario crédible, joué en flux ----------

const AGENT_SCRIPT = String.raw`
const args = process.argv.slice(2);
const name = process.env.DEMO_AGENT;
if (args[0] === '--help' || args[0] === 'help') {
  console.log("  --model <model>  Modèle (e.g. 'fable', 'opus', or 'sonnet')");
  process.exit(0);
}
if (args[0] === '--list-models') {
  console.log('auto - Auto (current)\ngpt-5.2-codex - GPT-5.2 Codex\nsonnet-4.6 - Claude Sonnet 4.6\ngemini-3-pro - Gemini 3 Pro');
  process.exit(0);
}
const ANSWERS = [
  [/sécurité|securite/i, [
    'Les contrôles sont faits **côté serveur**, dans ' + '\x60src/api/auth.ts\x60' + ' :',
    '',
    '| Contrôle | État | Détail |',
    '| :-- | :-: | :-- |',
    '| Jeton de session | ✓ | signé, expire après 1 h |',
    '| Limite de débit | ✓ | 60 requêtes / minute |',
    '| Journal des accès | à faire | prévu dans ' + '\x60audit.ts\x60' + ' |',
    '',
    '> Rien de bloquant, mais le journal des accès manque encore.',
  ]],
  [/test/i, [
    'Voici un test pour ' + '\x60parseDate\x60' + ' :',
    '',
    '\x60\x60\x60ts',
    "test('parseDate accepte le format ISO', () => {",
    "  expect(parseDate('2026-11-16')).toEqual(new Date(2026, 10, 16));",
    '});',
    '\x60\x60\x60',
  ]],
  [/./, [
    '## En trois points',
    '',
    '1. **Une API** en TypeScript, dans ' + '\x60src/api/\x60' + ', qui expose les commandes et les clients.',
    '2. **Un tableau de bord** React qui consomme cette API.',
    '3. **Des tâches planifiées** pour les relances et les exports.',
    '',
    'Le point d’entrée est ' + '\x60src/server.ts\x60' + ' ; les tests se lancent avec ' + '\x60npm test\x60' + '.',
  ]],
];
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', async () => {
  const all = stdin || args[args.length - 1] || '';
  const prompt = all.split("Nouvelle demande de l'utilisateur :").pop();
  const text = ANSWERS.find(([re]) => re.test(prompt))[1].join('\n') + '\n';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (name === 'codex') {
    process.stderr.write('thinking\n');
    await sleep(500);
    process.stdout.write(text);
    return;
  }
  const j = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'claude-sonnet-5-5';
  j({ type: 'system', subtype: 'init', model, session_id: 'demo-session-0001' });
  for (const [tool, input] of [['Glob', { pattern: 'src/**/*.ts' }], ['Read', { file_path: 'src/server.ts' }], ['Read', { file_path: 'src/api/auth.ts' }]]) {
    j({ type: 'assistant', message: { content: [{ type: 'tool_use', name: tool, input }] } });
    await sleep(Number(process.env.DEMO_TOOL_DELAY || 420));
  }
  for (const chunk of text.split(/(?<=[ \n])/)) {
    j({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } } });
    await sleep(Number(process.env.DEMO_DELAY || 28));
  }
  j({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'demo-session-0001' });
});
`;

function setupHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aska-media-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(home, 'agent.js'), AGENT_SCRIPT);
  for (const name of ['claude', 'codex', 'copilot', 'cursor-agent']) {
    fs.writeFileSync(
      path.join(bin, name),
      `#!/bin/sh\nDEMO_AGENT=${name} exec "${process.execPath}" "${path.join(home, 'agent.js')}" "$@"\n`,
      { mode: 0o755 }
    );
  }
  fs.mkdirSync(path.join(home, '.config', 'aska'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'aska', 'config.json'), JSON.stringify({ shortcut: false }), { mode: 0o600 });
  fs.mkdirSync(path.join(home, 'projets', 'boutique'), { recursive: true });

  // Quelques conversations passées, pour une page d'historique réaliste.
  const dir = path.join(home, '.local', 'state', 'aska', 'conversations');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ago = (days, h) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(h, 12, 0, 0);
    return d.toISOString();
  };
  const cwd = path.join(home, 'projets', 'boutique');
  const seed = [
    ['a1', 1, 17, 'Pourquoi le build échoue sur la CI ?', [['codex', 'Codex'], ['claude', 'Claude']], 'La CI utilise Node 18 alors que le projet demande Node 20 : il suffit de mettre à jour la version dans le workflow.'],
    ['a2', 3, 10, 'Rédige le message de commit pour ces changements', [['copilot', 'Copilot']], 'Corrige le calcul de la TVA sur les commandes multi-devises.'],
    ['a3', 5, 15, 'Compare les deux approches pour le cache', [['cursor', 'Cursor'], ['claude', 'Claude'], ['codex', 'Codex']], 'Le cache en mémoire est plus simple ; Redis devient utile dès que plusieurs instances tournent.'],
    ['a4', 12, 9, 'Traduis la page d’accueil en anglais', [['claude', 'Claude']], 'Voici la traduction, section par section, en conservant le ton d’origine.'],
  ];
  for (const [suffix, days, h, title, agents, answer] of seed) {
    const id = (suffix + '0'.repeat(16)).slice(0, 16).replace(/[^a-f0-9]/g, 'c');
    const turns = agents.map(([agent, label], i) => ({
      agent, label, mode: 'read', prompt: i ? 'Et ensuite ?' : title, answer, status: 'ok', ts: ago(days, h), durationMs: 2400,
    }));
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({ id, title, createdAt: ago(days, h), updatedAt: ago(days, h), cwd, turns, sessions: {} }),
      { mode: 0o600 }
    );
  }
  return { home, bin, cwd };
}

// ---------- pilotage ----------

async function main() {
  fs.mkdirSync(DOCS, { recursive: true });
  const { home, bin, cwd } = setupHome();
  const frames = path.join(home, 'frames');
  fs.mkdirSync(frames);
  // Le dossier de travail affiché : un projet, plutôt que l'espace temporaire.
  fs.mkdirSync(path.join(home, '.local', 'state', 'aska'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'state', 'aska', 'state.json'), JSON.stringify({ cwd }), { mode: 0o600 });

  const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, DEMO_TOOL_DELAY: '650' };
  for (const k of Object.keys(env)) if (/^XDG_/.test(k)) delete env[k];
  const args = ['--force-device-scale-factor=2', ROOT];
  if (process.env.ASKA_E2E_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  const app = await electron.launch({ executablePath: require(path.join(ROOT, 'node_modules', 'electron')), args, env, cwd: ROOT });
  const page = await app.firstWindow();
  await page.waitForSelector('.panel.in');
  await page.waitForTimeout(700);

  let n = 0;
  const frame = async (repeat = 1) => {
    const buf = await page.screenshot({ omitBackground: true });
    for (let i = 0; i < repeat; i++) fs.writeFileSync(path.join(frames, `f${String(n++).padStart(4, '0')}.png`), buf);
  };
  const still = async (name) => {
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(450);
      await page.screenshot({ path: path.join(DOCS, `${name}-${scheme}.png`), omitBackground: true });
    }
  };
  const type = async (text) => {
    for (const [i, ch] of [...text].entries()) {
      await page.keyboard.type(ch);
      if (i % 2 === 1) await frame();
    }
    await frame(4);
  };
  const run = async (capture) => {
    await page.keyboard.press('Enter');
    await page.waitForSelector('.panel[data-state="running"]');
    while (await page.$('.panel[data-state="running"]')) {
      if (capture) await frame();
      else await page.waitForTimeout(60);
    }
    await page.waitForTimeout(300);
  };

  try {
    // --- Démo animée (thème sombre) : question, réponse en flux, suite avec un autre agent.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(400);
    await frame(8);
    await type('Explique ce projet en trois points');
    await run(true);
    await frame(22);
    await page.keyboard.press('Tab'); // Codex
    await frame(3);
    await page.waitForTimeout(250);
    await frame(6);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab'); // Copilot
    await page.keyboard.press('Tab'); // Cursor
    await page.keyboard.press('Tab'); // Claude
    await page.waitForTimeout(250);
    await frame(4);
    await type('Et côté sécurité ?');
    await run(true);
    await frame(30);

    // --- Captures fixes, en clair et en sombre.
    await still('chat');

    await page.keyboard.press('Control+Shift+M');
    await page.waitForFunction(() => document.querySelectorAll('.model-opt').length >= 5);
    await still('modeles');
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+h');
    await page.waitForSelector('.hist-item');
    await page.keyboard.press('ArrowDown');
    await still('historique');
    await page.keyboard.press('Escape');

    // Accord avant écriture.
    await page.keyboard.press('Shift+Tab');
    await page.fill('#input', 'Ajoute un test pour parseDate');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#confirm:not([hidden])');
    await still('accord');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.panel[data-state="running"]');
    await page.waitForTimeout(150);
    // Réduit en pastille pendant que l'agent travaille.
    await page.keyboard.press('Control+m');
    await page.waitForTimeout(500);
    await still('pastille');
    await page.keyboard.press('Control+m');
    await page.waitForSelector('.panel[data-state="done"]', { timeout: 20000 });
    await page.waitForTimeout(400);
    await still('code');
  } finally {
    await app.close().catch(() => {});
  }

  // --- Assemblage du GIF : chaque image est posée sur un fond fixe, bord bas aligné.
  const composed = path.join(home, 'composed');
  fs.mkdirSync(composed);
  execFileSync('python3', ['-I', '-c', `
import glob, os, sys
from PIL import Image, ImageDraw
src, dst = sys.argv[1], sys.argv[2]
W, H, BOTTOM = 820, 560, 536
bg = Image.new('RGB', (W, H))
d = ImageDraw.Draw(bg)
for y in range(H):
    t = y / (H - 1)
    d.line([(0, y), (W, y)], fill=(int(30 + 22 * t), int(27 + 10 * t), int(48 + 36 * t)))
for f in sorted(glob.glob(os.path.join(src, '*.png'))):
    im = Image.open(f).convert('RGBA')
    im = im.resize((im.width // 2, im.height // 2), Image.LANCZOS)
    canvas = bg.copy()
    canvas.paste(im, ((W - im.width) // 2, BOTTOM - im.height), im)
    canvas.save(os.path.join(dst, os.path.basename(f)))
`, frames, composed]);
  const palette = path.join(home, 'palette.png');
  const input = ['-y', '-loglevel', 'error', '-framerate', '12', '-i', path.join(composed, 'f%04d.png')];
  execFileSync('ffmpeg', [...input, '-vf', 'palettegen=max_colors=128:stats_mode=diff', palette]);
  execFileSync('ffmpeg', [...input, '-i', palette, '-lavfi', 'paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', path.join(DOCS, 'demo.gif')]);

  fs.rmSync(home, { recursive: true, force: true });
  const kb = (f) => Math.round(fs.statSync(path.join(DOCS, f)).size / 1024);
  console.log(`${n} images → docs/demo.gif (${kb('demo.gif')} Ko)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
