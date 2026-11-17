# Contribuer à Aska

Merci de votre intérêt ! Ce guide décrit comment le projet est organisé, pour que
chaque contribution arrive sur `main` de la même façon : relue, testée, et versionnée.

## En bref

1. Créez une branche depuis `main` : `feat/notifications-son`, `fix/windows-lanceur`…
2. Codez, avec des tests. Vérifiez en local : `npm run check`.
3. Ouvrez une PR vers `main` avec un titre [Conventional Commits](https://www.conventionalcommits.org/fr/) :
   `feat(notifications): son facultatif`.
4. La CI doit être verte et un relecteur (voir `CODEOWNERS`) doit approuver.
5. La PR est fusionnée en **squash** : un commit par PR sur `main`, avec le titre de la PR.
6. La version et le CHANGELOG sont mis à jour automatiquement (voir [Versions](#versions-et-releases)).

## Branches

Le projet suit **GitHub Flow** : une seule branche permanente, `main`, toujours
stable et protégée. Tout le reste passe par des branches courtes et des PR.

| Branche | Rôle |
| --- | --- |
| `main` | Branche par défaut, protégée : pas de push direct, pas de force-push, historique linéaire. |
| `feat/…`, `fix/…`, `docs/…`, `refactor/…`, `ci/…`, `chore/…` | Branches de travail, une par sujet, supprimées après fusion. |
| `release-please--…` | Créée par le robot de release, ne pas modifier à la main. |

Gardez les branches courtes (quelques jours) et rebasez-les sur `main` si elles
divergent : la protection exige une branche à jour avant fusion.

## Titres de PR et messages de commit

Le titre de la PR devient le message du commit sur `main`, et c'est lui qui
détermine le prochain numéro de version et la ligne du CHANGELOG. La CI vérifie
son format : `<type>(<portée facultative>): <description>`.

| Type | Quand | Effet sur la version |
| --- | --- | --- |
| `feat` | nouvelle fonctionnalité | version mineure |
| `fix` | correction de bug | correctif |
| `perf` | amélioration de performance | correctif |
| `refactor` | réorganisation sans changement de comportement | aucun |
| `docs` | documentation | aucun |
| `test` | tests seuls | aucun |
| `build` | dépendances, outillage | aucun |
| `ci` | GitHub Actions | aucun |
| `chore` | divers | aucun |
| `revert` | annulation d'un changement | correctif |

Un changement **incompatible** (configuration renommée, comportement par défaut
modifié…) prend un `!` : `feat(config)!: renomme "notify" en "notifications"`, et
la description de la PR explique la migration.

Portées courantes : `ui`, `agents`, `notifications`, `historique`, `modeles`,
`securite`, `windows`, `linux`, `install`, `ci`, `docs`.

## Relecture

- Au moins **une approbation** est requise ; `CODEOWNERS` désigne les relecteurs.
- Une nouvelle modification après approbation annule l'approbation (relecture à refaire).
- Toutes les conversations de relecture doivent être résolues avant la fusion.
- Les changements qui touchent au **lancement des agents** (`src/main/launch.js`,
  `runner.js`, `security.js`), aux **modes de permission** ou à l'**environnement
  transmis** demandent une attention particulière : expliquez-les dans la PR.

## Développer

Prérequis : Node.js ≥ 20 (`.nvmrc` indique la version de la CI).

```sh
npm install
npm start                     # lance l'application
npm run lint                  # ESLint
npm test                      # tests unitaires
xvfb-run -a npm run test:e2e  # test de bout en bout (Linux) ; sous macOS et Windows : npm run test:e2e
npm run check                 # lint + tests unitaires, avant chaque push
```

Deux tests complètent celui-ci : `test/e2e/instances.js` (remplacement d'une
ancienne instance d'Aska) et, sous Linux seulement, `npm run test:click` (vrai
clic sur une autre fenêtre, sous Openbox ; demande `openbox`, `xdotool` et `xterm`).

Le test de bout en bout lance la vraie application avec de faux CLI d'agents
(`test/fixtures/fake-agent.js`) : il n'a besoin d'aucun compte ni d'aucune clé.

Si votre changement modifie l'interface, régénérez les images du README :

```sh
xvfb-run -a -s "-screen 0 3200x2000x24" node scripts/readme-media.js
```

### Règles du code

- **Jamais de shell** pour lancer un agent : arguments en tableau, demande sur
  stdin ou en argument unique (voir `src/main/launch.js`).
- L'interface reste en bac à sable : pas de Node dans `src/renderer/`, pas
  d'`innerHTML` sur du contenu venant d'un agent.
- Tout appel de l'interface est revalidé dans le processus principal.
- Textes de l'interface et documentation en français.
- Une correction de bug arrive avec le test qui l'aurait détecté.

## Intégration continue

Chaque PR lance :

| Contrôle | Contenu |
| --- | --- |
| **Lint** | ESLint |
| **Titre de la PR** | format Conventional Commits |
| **Tests (ubuntu-latest)** | tests unitaires, test de bout en bout |
| **Tests (windows-latest)** | tests unitaires, test de bout en bout, installation |
| **CI** | résumé des contrôles ci-dessus : c'est le contrôle obligatoire |
| **CodeQL** | analyse de sécurité du code |

Les captures d'écran du test de bout en bout sont téléchargeables dans l'onglet
**Actions**, sur chaque exécution. Dependabot ouvre chaque semaine les mises à
jour de dépendances et d'actions (toutes épinglées sur un commit précis).

## Versions et releases

Le projet suit le [versionnement sémantique](https://semver.org/lang/fr/). Avant
la 1.0, un changement incompatible incrémente la version mineure.

Les releases sont automatisées par [release-please](https://github.com/googleapis/release-please) :

1. À chaque fusion sur `main`, une PR « chore(main): release x.y.z » est créée ou
   mise à jour, avec le CHANGELOG et le numéro de version dans `package.json`.
2. Quand on veut publier, un mainteneur fusionne cette PR.
3. Le tag `vX.Y.Z` et la release GitHub sont créés, avec l'archive des sources et
   son empreinte SHA-256.

Les tags `v*` sont protégés : seuls la release automatique et les administrateurs
peuvent les créer.

> **Jeton de release (facultatif).** Avec le jeton par défaut de GitHub Actions,
> la CI ne se lance pas sur la PR de release : seul un administrateur peut alors la
> fusionner. Pour qu'elle soit testée comme les autres, créez un jeton à
> granularité fine (droits *Contents* et *Pull requests* en écriture sur ce
> dépôt) et enregistrez-le comme secret `RELEASE_TOKEN`.

## Mise en place du dépôt (mainteneurs)

La protection de `main`, la fusion en squash, les alertes de sécurité et les
étiquettes se règlent une fois, avec un compte administrateur :

```sh
gh auth login
./scripts/setup-github.sh --dry-run   # affiche ce qui sera fait
./scripts/setup-github.sh
```

Les règles de protection sont aussi dans `.github/rulesets/` : elles peuvent être
importées à la main (Settings → Rules → Rulesets → Import a ruleset).

## Signaler un problème

- Bug ou idée : ouvrez une issue avec le modèle correspondant.
- Faille de sécurité : **jamais en public**, voir [SECURITY.md](SECURITY.md).

En contribuant, vous acceptez que votre contribution soit publiée sous la
[licence MIT](LICENSE) du projet, et vous vous engagez à respecter le
[code de conduite](CODE_OF_CONDUCT.md).
