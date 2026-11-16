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
const WIN = process.platform === 'win32';
const POSIX = !WIN;
const { paths } = require(path.join(ROOT, 'src', 'main', 'config'));
const samePath = (a, b) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aska-e2e-'));
  const bin = path.join(home, 'bin');
  const callLog = path.join(home, 'calls.jsonl');
  fs.mkdirSync(bin, { mode: 0o755 });
  // Les faux CLI notent leurs arguments et leur stdin : on vérifie ce qu'Aska leur envoie vraiment.
  // Chaque faux CLI est un petit script node, lancé comme le serait le vrai :
  // via un script shell sous Linux, via un lanceur npm (.cmd) sous Windows.
  const pkg = path.join(bin, 'node_modules', 'fake-agents');
  fs.mkdirSync(pkg, { recursive: true });
  const wrap = (name, mode) => {
    const entry = path.join(pkg, `${name}.js`);
    fs.writeFileSync(entry, [
      `process.env.FAKE_LOG = ${JSON.stringify(callLog)};`,
      `process.env.FAKE_MODE = ${JSON.stringify(mode)};`,
      "process.env.FAKE_DELAY = process.env.FAKE_DELAY || '25';",
      `require(${JSON.stringify(FAKE)});`,
    ].join('\n'));
    if (WIN) {
      // Format exact des lanceurs générés par npm (cmd-shim).
      fs.writeFileSync(path.join(bin, `${name}.cmd`), [
        '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
        'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
        `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-agents\\${name}.js" %*`, '',
      ].join('\r\n'));
    } else {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`, { mode: 0o755 });
    }
  };
  wrap('claude', 'stream');
  wrap('cursor-agent', 'stream');
  wrap('codex', ''); // comportement choisi par une balise [mode] dans le prompt
  const calls = () => fs.readFileSync(callLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  // Environnement de l'app : dossier personnel et PATH isolés (Windows : profil et AppData).
  const env = { ...process.env, SECRET_TOKEN: 'ne-doit-pas-fuiter' };
  const setVar = (k, v) => {
    for (const x of Object.keys(env)) if (x.toUpperCase() === k.toUpperCase()) delete env[x];
    if (v !== undefined) env[k] = v;
  };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME']) setVar(k);
  if (WIN) {
    const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    setVar('USERPROFILE', home);
    setVar('APPDATA', path.join(home, 'AppData', 'Roaming'));
    setVar('LOCALAPPDATA', path.join(home, 'AppData', 'Local'));
    setVar('PATH', [bin, path.dirname(process.execPath), sys32].join(';'));
  } else {
    setVar('HOME', home);
    setVar('PATH', `${bin}:/usr/bin:/bin`);
  }
  const P = paths(env, home);
  fs.mkdirSync(P.configDir, { recursive: true });
  fs.writeFileSync(P.config, JSON.stringify({ shortcut: false }), { mode: 0o600 });
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
    // La liste vient du CLI lui-même (ici son aide), ajoutée aux alias connus.
    await page.waitForFunction(() => document.querySelectorAll('.model-opt').length === 5);
    assert.deepEqual(await page.locator('.model-opt').allTextContents(), ['Par défaut du CLI', 'opus', 'sonnet', 'haiku', 'fable']);
    await page.waitForTimeout(250);
    await shot('3-model-light');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#model-menu', { state: 'hidden' });
    assert.equal(await page.textContent('#model-name'), 'opus');
    await send('Avec un autre modèle');
    await settled('running');
    await settled('done');
    log = calls();
    assert.deepEqual(log[2].args.slice(-4), ['--model', 'opus', '--resume', 'sess-0001-abcd']);
    assert.match(await page.locator('.turn .meta').nth(2).textContent(), /Claude · opus/);
    // Filtrer au clavier, puis choisir.
    await page.click('#model');
    await page.waitForFunction(() => document.querySelectorAll('.model-opt').length === 5);
    await page.keyboard.type('fab');
    assert.deepEqual(await page.locator('.model-opt').allTextContents(), ['fable']);
    await page.keyboard.press('Enter');
    assert.equal(await page.textContent('#model-name'), 'fable');
    // Un nom absent de la liste reste utilisable.
    await page.click('#model');
    await page.keyboard.type('claude-custom-9');
    assert.deepEqual(await page.locator('.model-opt').allTextContents(), ['Utiliser « claude-custom-9 »']);
    await page.keyboard.press('Enter');
    assert.equal(await page.textContent('#model-name'), 'claude-custom-9');
    await page.click('#model');
    await page.waitForFunction(() => document.querySelectorAll('.model-opt').length === 6);
    await page.keyboard.press('Escape');
    assert.equal(await visible(), true);
    // Cursor publie sa liste complète, avec des libellés.
    const cursorModels = await page.evaluate(() => window.aska.listModels('cursor'));
    assert.deepEqual(cursorModels.models.slice(0, 2), [{ id: 'auto', label: 'Auto' }, { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' }]);
    assert.equal(cursorModels.models.length, 3);
    assert.equal((await page.evaluate(() => window.aska.listModels('__proto__'))).models.length, 0);

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
    assert.ok(!log[3].env.includes('SECRET_TOKEN'), 'env non filtré');
    assert.ok(samePath(log[3].cwd, fs.realpathSync(P.workspace)), `dossier de travail : ${log[3].cwd}`);
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
    assert.equal(await page.isVisible('#hist-btn'), false);
    assert.equal(await page.isVisible('#new-btn'), false);
    assert.ok(small.width < 300, `pastille trop large : ${small.width}`);
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

    // Markdown complet dans le fil, sans jamais interpréter de HTML.
    await send('Montre du markdown [md]');
    await settled('running');
    await settled('done');
    const md = page.locator('.turn').nth(1).locator('.output');
    assert.equal(await md.locator('h4').textContent(), 'Comparatif');
    assert.deepEqual(await md.locator('p').first().locator('em, strong, del, code').allTextContents(), ['italique', 'gras', 'barré', 'du code']);
    assert.deepEqual(await md.locator('th').allTextContents(), ['Agent', 'Bac à sable', 'Note']);
    assert.deepEqual(await md.locator('tbody tr').nth(0).locator('td').allTextContents(), ['Codex', 'oui', '9']);
    assert.equal(await md.locator('td').nth(2).getAttribute('data-align'), 'right');
    assert.equal(await md.locator('blockquote p').textContent(), 'Une citation\nsur deux lignes');
    assert.deepEqual(await md.locator('ol > li > ul > li').allTextContents(), ['sous-point a', 'sous-point b']);
    assert.equal(await md.locator('ol > li').count(), 2);
    assert.equal(await md.locator('li.task .check.on').count(), 1);
    assert.equal(await md.locator('li.task').count(), 2);
    assert.equal(await md.locator('hr').count(), 1);
    assert.equal(await md.locator('.code-lang').textContent(), 'bash');
    assert.deepEqual(await md.locator('a.md-link').allTextContents(), ['lien vers la doc', 'https://example.org/page']);
    assert.equal(await md.locator('b').count(), 0);
    // Un lien non http(s) reste du texte, tout comme le HTML.
    assert.match(await md.textContent(), /Piège : clic\)? et <b>pas de HTML<\/b>/);
    // Un lien s'ouvre dans le navigateur (http/https seulement), pas dans la fenêtre.
    await app.evaluate(({ shell }) => { global.__opened = []; shell.openExternal = async (u) => { global.__opened.push(u); }; });
    await md.locator('a.md-link').first().click();
    await page.evaluate(() => Promise.all([window.aska.openUrl('file:///etc/passwd'), window.aska.openUrl('javascript:alert(1)')]));
    assert.deepEqual(await app.evaluate(() => global.__opened), ['https://example.com/doc?a=1']);
    assert.match(page.url(), /^file:.*index\.html$/);
    await md.locator('.code-copy').click();
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'npm test   # tout passe');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(500);
    await shot('7-markdown-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(300);
    await shot('7-markdown-light');
    await page.focus('#input');

    await page.keyboard.press('Control+h');
    await page.waitForSelector('.hist-item');
    assert.deepEqual(await page.locator('.hist-title').allTextContents(), ['Deuxième sujet [text]', 'Résume main.js (deny)']);
    assert.match(await page.locator('.hist-sub').nth(1).textContent(), /Claude, Codex · 6 messages · Espace temporaire/);
    assert.equal(await page.locator('.hist-item').nth(1).locator('.dots i').count(), 2);
    assert.equal(await page.textContent('.hist-group'), "Aujourd'hui");
    assert.equal(await page.textContent('#hist-count'), '2 conversations');
    assert.match(await page.locator('.hist-time').first().textContent(), /^\d\d:\d\d$/);
    // L'aperçu reprend la dernière réponse, sans syntaxe Markdown.
    assert.match(await page.locator('.hist-preview').first().textContent(), /^Comparatif Un texte en italique, en gras, barré, avec du code et un lien vers la doc\./);
    assert.ok(await page.locator('.hist-item.current').first().evaluate((n) => n.classList.contains('active')));
    // La mise en page tient : chaque ligne occupe toute la largeur, sans débordement.
    const box = await page.locator('.hist-item').first().boundingBox();
    assert.ok(box.width > 650 && box.height < 90, `ligne d'historique ${JSON.stringify(box)}`);
    // Recherche : dans les titres, les aperçus et les agents.
    await page.keyboard.type('claude');
    assert.deepEqual(await page.locator('.hist-title').allTextContents(), ['Résume main.js (deny)']);
    assert.equal(await page.textContent('#hist-count'), '1 sur 2');
    await page.fill('#hist-search', 'zzz');
    assert.match(await page.textContent('.hist-empty'), /Aucun résultat/);
    await page.keyboard.press('Escape'); // vide la recherche, ne ferme pas la liste
    assert.equal(await page.locator('.hist-item').count(), 2);
    await page.waitForTimeout(300);
    await shot('6-history-light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(450);
    await shot('6-history-dark');
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowUp');
    await page.emulateMedia({ colorScheme: 'light' });
    assert.equal(await page.isVisible('#mode'), false);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.turn').length === 6);
    assert.equal(await page.isHidden('#history'), true);
    assert.match(await page.locator('.turn .output').first().textContent(), /trois points sur main\.js/);

    // Reprise d'une ancienne conversation avec Claude : d'autres agents ont parlé
    // depuis, donc le contexte complet est réinjecté plutôt que la vieille session.
    await page.keyboard.press('Tab');
    assert.equal(await page.textContent('#agent-name'), 'Cursor');
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
    // Suppression en deux temps, annulable.
    await page.keyboard.type('Deuxième');
    await page.keyboard.press('Delete');
    assert.equal(await page.textContent('.hist-item.arming .hist-del'), 'Confirmer la suppression');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.hist-item.arming').count(), 0);
    assert.equal(await page.locator('.hist-item').count(), 1);
    await page.keyboard.press('Delete');
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => document.querySelector('#hist-count').textContent === '0 sur 1');
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.locator('.hist-title').allTextContents(), ['Résume main.js (deny)']);
    await page.keyboard.press('Escape');
    assert.equal(await visible(), true);
    const convDir = P.conversations;
    const files = fs.readdirSync(convDir);
    assert.equal(files.length, 1);
    if (POSIX) assert.equal(fs.statSync(path.join(convDir, files[0])).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(path.join(convDir, files[0]), 'utf8')).turns.length, 7);

    // Rappel des messages (↑) et journal d'audit privé.
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.inputValue('#input'), 'On reprend');
    await page.fill('#input', '');
    const logFile = P.audit;
    const audit = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(audit.length, 9);
    assert.equal(audit[5].result, 'cancel');
    assert.equal(audit[5].mode, 'edit');
    assert.ok(audit.every((a) => !JSON.stringify(a.argv).includes('historique')));
    if (POSIX) assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);

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

    // Cursor exige --trust sans interface : accordé d'office dans le dossier vide d'Aska.
    const before = calls().length;
    assert.equal((await page.evaluate(() => window.aska.run({ agentId: 'cursor', mode: 'read', prompt: 'salut' }))).ok, true);
    await page.waitForTimeout(1500);
    const cur = calls()[before];
    assert.deepEqual(cur.args.slice(0, 6), ['-p', '--output-format', 'stream-json', '--mode', 'ask', '--trust']);

    console.log('E2E OK — captures dans', OUT);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
