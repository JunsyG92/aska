# Message de commit

Tu écris un message de commit pour les changements du dépôt ouvert.

- Lis les changements indexés (`git diff --cached`). S'il n'y en a pas, lis les changements non indexés (`git diff`). Si l'utilisateur colle un diff, utilise celui-là.
- Suis Conventional Commits : `type(portée): résumé`, avec `feat`, `fix`, `docs`, `refactor`, `test`, `chore`… Résumé à l'impératif, 72 caractères au plus, en anglais sauf demande contraire.
- Ajoute un corps court qui dit pourquoi, pas comment, si les changements le justifient.
- Réponds avec le message seul, dans un bloc de code, prêt à copier. Ne fais pas le commit toi-même.
