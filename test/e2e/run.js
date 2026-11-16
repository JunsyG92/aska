'use strict';
// Test de bout en bout : lance la vraie app Electron avec de faux CLI d'agents.
// Usage : xvfb-run -a node test/e2e/run.js   (ASKA_E2E_NO_SANDBOX=1 si exécuté en root)
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-agent.js');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aska-e2e-'));
  const bin = path.join(home, 'bin');
  const callLog = path.join(home, 'calls.jsonl');
  fs.mkdirSync(bin, { mode: 0o755 });
  // Les faux CLI notent leurs arguments et leur stdin : on vérifie ce qu'Aska leur envoie vraiment.
  const wrap = (name, mode) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nFAKE_LOG="${callLog}" FAKE_MODE=${mode} FAKE_DELAY=\${FAKE_DELAY:-25} exec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  wrap('claude', 'stream');
  wrap('codex', ''); // comportement choisi par une balise [mode] dans le prompt
  fs.mkdirSync(path.join(home, '.config', 'aska'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'aska', 'config.json'), JSON.stringify({ shortcut: false }), { mode: 0o600 });
  const calls = () => fs.readFileSync(callLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, SECRET_TOKEN: 'ne-doit-pas-fuiter' };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME']) delete env[k];
  const args = [ROOT];
  if (process.env.ASKA_E2E_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  const app = await electron.launch({ executablePath: require(path.join(ROOT, 'node_modules', 'electron')), args, env, cwd: ROOT });
  const page = await app.firstWindow();
  const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png'), omitBackground: true });
  const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
  const send = async (text) => {
    await page.fill('#input', text);
    await page.keyboard.press('Enter');
  };
  const settled = (state) => page.waitForSelector(`.panel[data-state="${state}"]`, { timeout: 20000 });
  const turns = () => page.locator('.turn').count();

  try {
    await page.waitForSelector('.panel.in');
    await page.waitForTimeout(600);
    assert.equal(await page.textContent('#agent-name'), 'Claude');
    assert.equal(await page.textContent('#mode-name'), 'Lecture seule');
    assert.equal(await page.textContent('#model-name'), 'Modèle par défaut');
    assert.equal(await page.textContent('#cwd-name'), 'Espace temporaire');

    // L'interface est bien isolée de Node.
    assert.deepEqual(await page.evaluate(() => [typeof require, typeof process]), ['undefined', 'undefined']);
    // Le processus principal revalide tout ce que l'interface envoie.
    const bad = await page.evaluate(async () => [
      await window.aska.run({ agentId: '__proto__', mode: 'read', prompt: 'x' }),
      await window.aska.run({ agentId: 'claude', mode: 'auto', prompt: 'x', trust: 'always' }),
      await window.aska.run({ agentId: 'claude', mode: 'bypass', prompt: 'x' }),
      await window.aska.run({ agentId: 'claude', mode: 'read', prompt: 42 }),
      (await window.aska.setModel('claude', '--dangerously-skip-permissions')).agents.find((a) => a.id === 'claude').model,
      (await window.aska.openConversation('../../../etc/passwd')).conversation.turns.length,
    ]);
    assert.match(bad[0].error, /inconnu/);
    assert.match(bad[1].error, /autonome est désactivé/);
    assert.match(bad[2].error, /Mode inconnu/);
    assert.match(bad[3].error, /invalide/);
    assert.equal(bad[4], null);
    assert.equal(bad[5], 0);

    // Fenêtre fixe : elle reste affichée quand elle perd le focus, et épouse le panneau.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('blur'));
    await page.waitForTimeout(300);
    assert.equal(await visible(), true);
    const idle = await bounds();
    assert.equal(idle.width, 748);
    assert.ok(idle.height < 150, `hauteur au repos ${idle.height}`);
    await shot('1-idle-light');

    // 1er message : le champ se vide dès l'envoi et la demande rejoint le fil.
    await send('Résume main.js (deny)');
    await settled('running');
    assert.equal(await page.inputValue('#input'), '');
    assert.equal(await page.textContent('.turn .q'), 'Résume main.js (deny)');
    await page.waitForTimeout(600);
    await shot('2-running-light');
    await settled('done');
    assert.match(await page.textContent('.turn .output'), /trois points sur main\.js/);
    assert.equal(await page.locator('.turn .output pre code').textContent(), 'const ok = true;');
    assert.match(await page.textContent('.turn .notice'), /2 action\(s\) refusée\(s\).*Bash, Edit/);
    assert.match(await page.textContent('.turn .meta'), /Claude · fake-model-1 · Lecture seule · /);
    await page.waitForTimeout(400);
    const grown = await bounds();
    assert.ok(grown.height > 300, `hauteur avec réponse ${grown.height}`);
    assert.equal(grown.y + grown.height, idle.y + idle.height, 'le bord bas (la saisie) ne doit pas bouger');

    // 2e message : même fil, et Claude reprend sa session au lieu de repartir de zéro.
    await send('Et le fichier preload ?');
    await settled('running');
    await settled('done');
    assert.equal(await turns(), 2);
    assert.match(await page.locator('.turn .output').nth(1).textContent(), /Suite de la session : preload\.js/);
    let log = calls();
    assert.equal(log.length, 2);
    assert.ok(!log[0].args.includes('--resume') && !log[0].args.includes('--model'));
    assert.deepEqual(log[1].args.slice(-2), ['--resume', 'sess-0001-abcd']);
    assert.equal(log[1].stdin, 'Et le fichier preload ?');

    // Choix du modèle : proposé par agent, mémorisé, et transmis au CLI.
    await page.keyboard.press('Control+Shift+M');
    await page.waitForSelector('#model-menu:not([hidden])');
    assert.deepEqual(await page.locator('.model-opt').allTextContents(), ['Par défaut du CLI', 'opus', 'sonnet', 'haiku']);
    await page.waitForTimeout(250);
    await shot('3-model-light');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#model-menu', { state: 'hidden' });
    assert.equal(await page.textContent('#model-name'), 'opus');
    await send('Avec un autre modèle');
    await settled('running');
    await settled('done');
    log = calls();
    assert.deepEqual(log[2].args.slice(-4), ['--model', 'opus', '--resume', 'sess-0001-abcd']);
    assert.match(await page.locator('.turn .meta').nth(2).textContent(), /Claude · opus/);
    // Modèle saisi à la main (les noms évoluent plus vite que l'app).
    await page.click('#model');
    await page.fill('#model-custom', 'claude-custom-9');
    await page.keyboard.press('Enter');
    assert.equal(await page.textContent('#model-name'), 'claude-custom-9');
    await page.click('#model');
    assert.ok((await page.locator('.model-opt').allTextContents()).includes('claude-custom-9'));
    await page.keyboard.press('Escape');
    assert.equal(await visible(), true);

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(500);
    await shot('4-chat-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(400);
    await shot('4-chat-light');

    // Changement d'agent en cours de fil : Codex n'a pas la session, il reçoit le contexte.
    await page.keyboard.press('Tab');
    assert.equal(await page.textContent('#agent-name'), 'Codex');
    assert.equal(await page.textContent('#model-name'), 'Modèle par défaut');
    await send('<img src=x onerror=alert(1)> [echo]');
    await settled('running');
    await settled('done');
    log = calls();
    assert.deepEqual(log[3].args, ['exec', '--skip-git-repo-check', '--color', 'never', '--sandbox', 'read-only', '-']);
    assert.match(log[3].stdin, /<historique>[\s\S]*\[Utilisateur\]\nRésume main\.js \(deny\)[\s\S]*\[Assistant — Claude\][\s\S]*trois[\s\S]*Et le fichier preload \?[\s\S]*<\/historique>[\s\S]*Nouvelle demande de l'utilisateur :\n<img src=x onerror=alert\(1\)> \[echo\]$/);
    const lastOut = await page.locator('.turn .output').nth(3).textContent();
    assert.ok(!lastOut.includes('SECRET_TOKEN'), 'env non filtré');
    assert.ok(lastOut.includes(fs.realpathSync(path.join(home, '.local/share/aska/workspace'))));
    assert.equal(await page.locator('.thread img').count(), 0);

    // Échec remonté dans le fil, sans perdre la conversation.
    await send('plante [fail]');
    await settled('error');
    assert.match(await page.locator('.turn').nth(4).locator('.notice').textContent(), /code 3[\s\S]*auth error: not logged in/);
    assert.equal(await turns(), 5);

    // Mode édition : accord obligatoire ; le message n'est pas perdu si on renonce.
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.textContent('#mode-name'), 'Édition');
    await send('Corrige la faute dans le README [hang]');
    await page.waitForSelector('#confirm:not([hidden])');
    assert.match(await page.textContent('#confirm-text'), /Autoriser Codex à modifier des fichiers dans « Espace temporaire »/);
    await page.keyboard.press('Escape');
    assert.equal(await page.isHidden('#confirm'), true);
    assert.equal(await page.inputValue('#input'), 'Corrige la faute dans le README [hang]');
    assert.equal(await turns(), 5);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#confirm:not([hidden])');
    await page.keyboard.press('Enter'); // une fois
    await settled('running');
    assert.equal(await page.inputValue('#input'), '');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape'); // annule l'exécution, ne ferme pas
    await settled('error');
    assert.equal(await page.textContent('#status'), 'Annulé');
    assert.equal(await page.locator('.turn').nth(5).getAttribute('data-status'), 'cancel');
    assert.equal(await visible(), true);
    await page.keyboard.press('Shift+Tab');

    // Réduire en pastille (Ctrl+M), puis rétablir : le fil est toujours là.
    await page.keyboard.press('Control+m');
    await page.waitForTimeout(400);
    const small = await bounds();
    assert.ok(small.width < 400 && small.height < 90, `pastille ${JSON.stringify(small)}`);
    assert.equal(await page.textContent('#mini-status'), 'Annulé');
    await shot('5-mini-light');
    await page.click('#mini-btn');
    await page.waitForTimeout(500);
    assert.equal((await bounds()).width, 748);
    assert.equal(await turns(), 6);

    // Historique : nouvelle conversation, liste, réouverture, suppression.
    await page.keyboard.press('Control+n');
    await page.waitForFunction(() => document.querySelectorAll('.turn').length === 0);
    await send('Deuxième sujet [text]');
    await settled('done');
    await page.keyboard.press('Control+h');
    await page.waitForSelector('.hist-item');
    assert.deepEqual(await page.locator('.hist-title').allTextContents(), ['Deuxième sujet [text]', 'Résume main.js (deny)']);
    assert.match(await page.locator('.hist-sub').nth(1).textContent(), /Claude, Codex · 6 messages/);
    await page.waitForTimeout(300);
    await shot('6-history-light');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.turn').length === 6);
    assert.equal(await page.isHidden('#history'), true);
    assert.match(await page.locator('.turn .output').first().textContent(), /trois points sur main\.js/);

    // Reprise d'une ancienne conversation avec Claude : d'autres agents ont parlé
    // depuis, donc le contexte complet est réinjecté plutôt que la vieille session.
    await page.keyboard.press('Tab');
    assert.equal(await page.textContent('#agent-name'), 'Claude');
    await send('On reprend');
    await settled('running');
    await settled('done');
    log = calls();
    const lastCall = log[log.length - 1];
    assert.ok(!lastCall.args.includes('--resume'));
    assert.match(lastCall.stdin, /<historique>[\s\S]*plante \[fail\][\s\S]*Nouvelle demande de l'utilisateur :\nOn reprend$/);
    assert.equal(await turns(), 7);

    await page.keyboard.press('Control+h');
    await page.waitForSelector('.hist-item');
    await page.locator('.hist-item', { hasText: 'Deuxième sujet' }).focus();
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => document.querySelectorAll('.hist-item').length === 1);
    await page.keyboard.press('Escape');
    assert.equal(await visible(), true);
    const convDir = path.join(home, '.local/state/aska/conversations');
    const files = fs.readdirSync(convDir);
    assert.equal(files.length, 1);
    assert.equal(fs.statSync(path.join(convDir, files[0])).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(path.join(convDir, files[0]), 'utf8')).turns.length, 7);

    // Rappel des messages (↑) et journal d'audit privé.
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.inputValue('#input'), 'On reprend');
    await page.fill('#input', '');
    const logFile = path.join(home, '.local/state/aska/history.jsonl');
    const audit = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(audit.length, 8);
    assert.equal(audit[5].result, 'cancel');
    assert.equal(audit[5].mode, 'edit');
    assert.ok(audit.every((a) => !JSON.stringify(a.argv).includes('historique')));
    assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);

    // Échap masque la fenêtre ; une seconde instance (« aska --toggle ») la rouvre, fil intact.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    assert.equal(await visible(), false);
    await app.evaluate(({ app }) => app.emit('second-instance', {}, ['--toggle']));
    await page.waitForTimeout(400);
    assert.equal(await visible(), true);
    assert.equal(await turns(), 7);

    // Navigation et ouverture de fenêtre bloquées.
    await page.evaluate(() => { window.open('https://example.com'); location.href = 'https://example.com'; });
    await page.waitForTimeout(300);
    assert.match(page.url(), /^file:.*index\.html$/);
    assert.equal((await app.windows()).length, 1);

    console.log('E2E OK — captures dans', OUT);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
