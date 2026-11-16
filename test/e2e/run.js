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
  fs.mkdirSync(bin, { mode: 0o755 });
  const wrap = (name, mode) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nFAKE_MODE=${mode} FAKE_DELAY=\${FAKE_DELAY:-25} exec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  wrap('claude', 'stream');
  wrap('codex', ''); // comportement choisi par une balise [mode] dans le prompt
  fs.mkdirSync(path.join(home, '.config', 'aska'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'aska', 'config.json'), JSON.stringify({ shortcut: false }), { mode: 0o600 });

  const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, SECRET_TOKEN: 'ne-doit-pas-fuiter' };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME']) delete env[k];
  const args = [ROOT];
  if (process.env.ASKA_E2E_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  const app = await electron.launch({ executablePath: require(path.join(ROOT, 'node_modules', 'electron')), args, env, cwd: ROOT });
  const page = await app.firstWindow();
  const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png'), omitBackground: true });
  const size = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
  const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());

  try {
    await page.waitForSelector('.panel.in');
    await page.waitForTimeout(600);
    assert.equal(await page.textContent('#agent-name'), 'Claude');
    assert.equal(await page.textContent('#mode-name'), 'Lecture seule');
    assert.equal(await page.textContent('#cwd-name'), 'Espace temporaire');

    // L'interface est bien isolée de Node.
    assert.deepEqual(
      await page.evaluate(() => [typeof require, typeof process, Object.keys(window.aska).sort().join()]),
      ['undefined', 'undefined', 'cancel,copy,getState,hide,onRunEvent,onShown,onWillHide,pickDir,resetDir,resize,run,setMini']
    );
    // Le processus principal revalide tout ce que l'interface envoie.
    const bad = await page.evaluate(async () => [
      await window.aska.run({ agentId: '__proto__', mode: 'read', prompt: 'x' }),
      await window.aska.run({ agentId: 'claude', mode: 'auto', prompt: 'x', trust: 'always' }),
      await window.aska.run({ agentId: 'claude', mode: 'bypass', prompt: 'x' }),
      await window.aska.run({ agentId: 'claude', mode: 'read', prompt: 42 }),
    ]);
    assert.match(bad[0].error, /inconnu/);
    assert.match(bad[1].error, /autonome est désactivé/);
    assert.match(bad[2].error, /Mode inconnu/);
    assert.match(bad[3].error, /invalide/);

    // Fenêtre fixe : elle reste affichée quand elle perd le focus, et épouse le panneau.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('blur'));
    await page.waitForTimeout(300);
    assert.equal(await visible(), true);
    const idle = await size();
    assert.equal(idle[0], 748);
    assert.ok(idle[1] < 150, `hauteur au repos ${idle[1]}`);

    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(150);
      await shot(`1-idle-${scheme}`);
    }

    // Exécution en flux (mode lecture seule) avec refus de permissions simulés.
    await page.fill('#input', 'Résume main.js (deny)');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.panel[data-state="running"]');
    await page.waitForTimeout(700);
    await shot('2-running-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await shot('2-running-light');
    await page.waitForSelector('.panel[data-state="done"]', { timeout: 20000 });
    await page.waitForTimeout(400);
    assert.match(await page.textContent('#output'), /trois points sur main\.js/);
    assert.equal(await page.locator('#output pre code').textContent(), 'const ok = true;');
    assert.equal(await page.locator('#output strong').textContent(), 'trois');
    assert.match(await page.textContent('#notice'), /2 action\(s\) refusée\(s\).*Bash, Edit/);
    assert.match(await page.textContent('#status'), /Terminé en/);
    await shot('3-done-light');
    const full = await size();
    assert.ok(full[1] > 300, `hauteur avec réponse ${full[1]}`);

    // Réduire en pastille (Ctrl+M), puis rétablir : la réponse est toujours là.
    await page.keyboard.press('Control+m');
    await page.waitForTimeout(400);
    const small = await size();
    assert.ok(small[0] < 400 && small[1] < 90, `pastille ${small}`);
    assert.match(await page.textContent('#mini-status'), /Terminé en/);
    await shot('3-mini-light');
    await page.click('#mini-btn');
    await page.waitForTimeout(500);
    assert.deepEqual(await size(), full);
    assert.match(await page.textContent('#output'), /trois points/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot('3-done-dark');

    // Mode édition : confirmation de confiance obligatoire avant de lancer.
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.textContent('#mode-name'), 'Édition');
    await page.keyboard.press('Shift+Tab'); // « auto » désactivé : on revient en lecture seule
    assert.equal(await page.textContent('#mode-name'), 'Lecture seule');
    await page.keyboard.press('Shift+Tab');
    await page.fill('#input', 'Corrige la faute dans le README');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#confirm:not([hidden])');
    assert.match(await page.textContent('#confirm-text'), /Autoriser Claude à modifier des fichiers dans « Espace temporaire »/);
    await page.waitForTimeout(300);
    await shot('4-trust-dark');
    await page.keyboard.press('Escape');
    assert.equal(await page.isHidden('#confirm'), true);
    assert.equal(await visible(), true);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#confirm:not([hidden])');
    await page.keyboard.press('Enter'); // une fois
    await page.waitForSelector('.panel[data-state="running"]');
    await page.keyboard.press('Escape'); // annule l'exécution, ne ferme pas
    await page.waitForSelector('.panel[data-state="error"]');
    assert.equal(await page.textContent('#status'), 'Annulé');
    assert.equal(await visible(), true);

    // Autre agent (sortie texte), puis échec remonté proprement.
    await page.keyboard.press('Tab');
    assert.equal(await page.textContent('#agent-name'), 'Codex');
    assert.equal(await page.textContent('#mode-name'), 'Édition');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.textContent('#mode-name'), 'Lecture seule');
    await page.fill('#input', '<img src=x onerror=alert(1)> [echo]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.panel[data-state="done"]');
    const echoed = JSON.parse(await page.textContent('#output'));
    assert.deepEqual(echoed.args, ['exec', '--skip-git-repo-check', '--color', 'never', '--sandbox', 'read-only', '-']);
    assert.equal(echoed.stdin, '<img src=x onerror=alert(1)> [echo]');
    assert.ok(!echoed.env.includes('SECRET_TOKEN'), 'env non filtré');
    assert.equal(echoed.cwd, fs.realpathSync(path.join(home, '.local/share/aska/workspace')));
    assert.equal(await page.locator('#output img').count(), 0);
    await shot('5-codex-dark');

    await page.fill('#input', 'plante [fail]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.panel[data-state="error"]');
    assert.match(await page.textContent('#notice'), /code 3[\s\S]*auth error: not logged in/);
    await shot('6-error-dark');

    // Historique (↑) et journal d'audit privé.
    await page.fill('#input', '');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.inputValue('#input'), 'plante [fail]');
    const logFile = path.join(home, '.local/state/aska/history.jsonl');
    const log = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.length, 4);
    assert.deepEqual(log.map((l) => l.result), ['exit', 'cancel', 'exit', 'exit']);
    assert.equal(log[1].mode, 'edit');
    assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);

    // Échap referme le lanceur ; une seconde instance (« aska --toggle ») le rouvre.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    assert.equal(await visible(), false);
    await app.evaluate(({ app }) => app.emit('second-instance', {}, ['--toggle']));
    await page.waitForTimeout(400);
    assert.equal(await visible(), true);

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
