# Test manuel de la PR #28 : limite de la ligne de commande

Date : 2026-11-25. Branche `fix/cmdline-limit`, commit `1069b57`.

## Conclusion

La PR fait ce qu'elle annonce sous Linux. L'historique est réduit quand la commande dépasserait la limite. Une demande trop longue à elle seule renvoie l'erreur `errors.promptTooLong` au lieu de E2BIG. La limite calculée correspond à l'octet près à celle du noyau (131 071 octets par argument, un « é » comptant pour 2 octets).

## Environnement

- Ubuntu 24.04.5 LTS (Noble Numbat)
- Node v24.17.0
- GNOME Shell 46.0 sous Wayland (XWayland disponible)

## Tests automatiques

`npm ci` puis `npm run check` : **66 tests réussis, 0 en échec**.

## Test réel, sans interface

Un faux agent `~/.local/bin/aska-echoarg` reçoit la demande en argument et affiche sa taille et le nombre de tours d'historique :

```js
#!/usr/bin/env node
const p = process.argv[process.argv.length - 1];
const turns = (p.match(/^\[User\]$/gm) || []).length;
console.log(`Reçu ${p.length} caractères (${Buffer.byteLength(p)} octets), ${turns} tour(s) d'historique.`);
```

Il est déclaré dans `~/.config/aska/config.json` :

```json
"agents": {
  "echoarg": { "bin": "<chemin absolu>", "label": "EchoArg", "prompt": "arg", "output": "text", "modes": { "read": [] } }
}
```

Un script Node charge l'agent comme `loadEverything()` (`resolveAgents`, `resolveBinary`, `resolveLaunch`). Il calcule la taille de la commande comme `startRun()` (`fitInvocation`, `buildContextPrompt`, `commandLineExcess` avec l'environnement de l'agent), puis lance réellement l'agent avec `spawnSync`. Chaque tour de la conversation contient une question et une réponse de 30 000 « é ».

| Cas | Sans réduction | Après `fitInvocation` | Résultat |
|---|---|---|---|
| 3 tours + demande de 30 000 « é » | 2 tours, 100 293 octets | identique, rien à réduire | lancement réussi |
| 3 tours + demande de 60 000 « é » | 2 tours, 160 293 octets : E2BIG | 0 tour, 120 000 octets | lancement réussi, historique réduit |
| Demande seule de 70 000 « é » (140 000 octets) | E2BIG | `errors.promptTooLong` | erreur claire, pas E2BIG |
| 70 000 « é » + 3 tours | E2BIG | `errors.promptTooLong` | erreur claire, pas E2BIG |

Limite exacte, en ASCII comme avec des « é » : 131 071 octets passent et 131 072 échouent avec E2BIG. Le dépassement calculé par `commandLineExcess` vaut 0 puis 1.

## Remarques

- Avec une demande de 30 000 « é », rien n'est réduit. Ce n'est pas un défaut : le code existant borne déjà l'historique (4 000 caractères par question, 6 000 par réponse, `HISTORY_CHARS` = 24 000 au total), ce qui ne laisse que 2 tours et environ 40 Ko.
- Avec une demande de 60 000 « é », supprimer tout l'historique est correct : un seul tour (environ 20 Ko) ferait déjà dépasser la limite.
- Non testé ici : Windows (limite de 32 767 unités UTF-16, 8 191 via cmd.exe) et macOS (1 Mio pour les arguments et l'environnement).
