# Politique de sécurité

Aska lance des agents IA capables de lire et de modifier des fichiers, et de
lancer des commandes. La sécurité de ce lancement est au cœur du projet : merci
de nous aider à la garder solide.

## Signaler une faille

**N'ouvrez pas d'issue publique.** Utilisez le signalement privé de GitHub :
[Security → Report a vulnerability](https://github.com/JunsyG92/aska/security/advisories/new).

Indiquez si possible :

- la version (`aska --version`), le système et l'agent concerné ;
- les étapes pour reproduire, et ce qu'un attaquant peut obtenir ;
- une proposition de correction, si vous en avez une.

## Ce qui nous intéresse en priorité

- Un texte de demande, une réponse d'agent ou un fichier de projet qui mène à
  l'exécution d'une commande non voulue (injection de shell, d'options, `cmd.exe`).
- Un contournement des modes de permission (écriture en lecture seule, mode
  autonome sans `allowAutoMode`, écriture hors du dossier autorisé).
- Une fuite de variables d'environnement ou de jetons vers un agent qui ne
  devrait pas les recevoir.
- Du contenu d'agent qui exécute du code dans l'interface (HTML, liens, navigation).
- Un binaire d'agent ou une configuration qu'un autre utilisateur de la machine
  pourrait remplacer.

Les failles des CLI d'agents eux-mêmes (Claude Code, Codex, Copilot, Cursor) sont
à signaler à leurs éditeurs ; prévenez-nous aussi si Aska peut en limiter l'effet.

## Notre engagement

| Étape | Délai visé |
| --- | --- |
| Accusé de réception | 3 jours ouvrés |
| Première évaluation | 7 jours |
| Correctif pour une faille grave | 30 jours |

Nous publions un avis de sécurité avec la version corrigée, et nous créditons
l'auteur du signalement s'il le souhaite.

## Versions prises en charge

Seule la dernière version publiée reçoit des correctifs de sécurité.
