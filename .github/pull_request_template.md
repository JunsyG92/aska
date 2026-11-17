<!--
Le titre de la PR devient le message du commit sur main : il doit suivre
Conventional Commits, par exemple « feat(notifications): son facultatif » ou
« fix(windows): lanceur .cmd introuvable ». Voir CONTRIBUTING.md.
-->

## Quoi et pourquoi

<!-- Le changement en quelques lignes, et le besoin qu'il couvre. « Closes #123 » si une issue existe. -->

## Comment c'est vérifié

<!-- Tests ajoutés ou modifiés, essais manuels (système, agent, bureau). -->

## Captures

<!-- Pour tout changement visible : avant / après, en clair et en sombre si possible. -->

## Points d'attention

- [ ] Sécurité : ce changement touche-t-il au lancement des agents, aux permissions, aux dossiers ou à l'environnement transmis ? Si oui, expliquez.
- [ ] Les tests passent en local (`npm run check`, et `npm run test:e2e` pour l'interface).
- [ ] Documentation à jour (README, `aska --help`) si le comportement change.
