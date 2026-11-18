'use strict';
// Identifiant du code qui tourne : empreinte des fichiers de src/. Il permet de
// reconnaître une instance d'Aska restée ouverte après une mise à jour (git pull),
// qui exécute donc toujours l'ancien code et ignore les nouveautés.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function listFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}

/** @param env  ASKA_BUILD_ID remplace l'identifiant (tests de remplacement d'instance) */
function buildId(root = path.join(__dirname, '..'), env = process.env) {
  if (env.ASKA_BUILD_ID) return String(env.ASKA_BUILD_ID).slice(0, 40);
  const h = crypto.createHash('sha1');
  try {
    for (const f of listFiles(root)) {
      h.update(path.relative(root, f).replace(/\\/g, '/'));
      h.update(fs.readFileSync(f));
    }
  } catch { /* sources illisibles : empreinte vide, jamais bloquant */ }
  return h.digest('hex').slice(0, 12);
}

/** L'instance d'Aska enregistrée comme active (fichier run.json), si son processus existe encore. */
function runningInstance(readJson, runFile) {
  const r = readJson(runFile);
  const d = r && r.data;
  if (!d || !Number.isInteger(d.pid)) return null;
  try {
    process.kill(d.pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return null; // processus disparu
  }
  return { pid: d.pid, build: String(d.build || '') };
}

module.exports = { buildId, runningInstance };
