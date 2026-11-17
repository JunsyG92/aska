'use strict';
// Une instance d'Aska restée ouverte après une mise à jour doit être remplacée :
// sans cela, « aska » rouvre l'ancien processus et aucune nouveauté n'apparaît.
//   xvfb-run -a node test/e2e/instances.js   (ASKA_E2E_NO_SANDBOX=1 si exécuté en root)
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { _electron: electron } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const WIN = process.platform === 'win32';
const { paths } = require(path.join(ROOT, 'src', 'main', 'config'));
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aska-inst-'));
  const env = { ...process.env };
  const setVar = (k, v) => {
    for (const x of Object.keys(env)) if (x.toUpperCase() === k.toUpperCase()) delete env[x];
    if (v !== undefined) env[k] = v;
  };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME']) setVar(k);
  if (WIN) {
    setVar('USERPROFILE', home);
    setVar('APPDATA', path.join(home, 'AppData', 'Roaming'));
    setVar('LOCALAPPDATA', path.join(home, 'AppData', 'Local'));
  } else setVar('HOME', home);
  const P = paths(env, home);
  fs.mkdirSync(P.configDir, { recursive: true });
  fs.writeFileSync(P.config, JSON.stringify({ shortcut: false }), { mode: 0o600 });
  const flags = process.env.ASKA_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : [];
  const run = () => JSON.parse(fs.readFileSync(P.run, 'utf8'));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitFor = async (fn, what, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await fn()) return; } catch { /* on réessaie */ } await sleep(150); }
    throw new Error(`délai dépassé : ${what}`);
  };
  // Lance « aska <args> » comme le ferait le lanceur de l'utilisateur.
  const launch = (build, ...args) => spawn(ELECTRON, [...flags, ROOT, ...args], { env: { ...env, ASKA_BUILD_ID: build }, detached: true, stdio: 'ignore' }).unref();

  // 1. Une « ancienne version » tourne (identifiant de code différent).
  const old = await electron.launch({ executablePath: ELECTRON, args: [...flags, ROOT], env: { ...env, ASKA_BUILD_ID: 'ancien' } });
  const oldPage = await old.firstWindow();
  await oldPage.waitForSelector('.panel.in');
  await waitFor(() => fs.existsSync(P.run), 'fichier run.json');
  const oldPid = run().pid;
  assert.equal(run().build, 'ancien');

  // 2. Même code : « aska » ne fait que rouvrir l'instance en cours.
  launch('ancien', '--toggle');
  await sleep(2500);
  assert.equal(run().pid, oldPid, 'même version : l\'instance en cours est conservée');
  assert.ok(alive(oldPid));

  // 3. Code plus récent : l'ancienne instance est remplacée.
  launch('nouveau', '--hidden');
  await waitFor(() => fs.existsSync(P.run) && run().build === 'nouveau', 'remplacement par la nouvelle version', 30000);
  const newPid = run().pid;
  assert.notEqual(newPid, oldPid);
  await waitFor(() => !alive(oldPid), 'fermeture de l\'ancienne instance');
  assert.ok(alive(newPid));

  // 4. --restart force le remplacement, même à code identique.
  launch('nouveau', '--restart');
  await waitFor(() => fs.existsSync(P.run) && run().pid !== newPid && alive(run().pid), 'redémarrage forcé', 30000);
  const lastPid = run().pid;
  assert.equal(run().build, 'nouveau');
  await waitFor(() => !alive(newPid), 'fermeture de l\'instance remplacée');

  // 5. --quit arrête l'instance et nettoie le fichier.
  launch('nouveau', '--quit');
  await waitFor(() => !alive(lastPid), 'arrêt par --quit');
  await waitFor(() => !fs.existsSync(P.run), 'suppression de run.json');

  await old.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
  console.log('Instances OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
