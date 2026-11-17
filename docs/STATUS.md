# État de reprise

## Dernier point de contrôle
- Date et heure : 2026-11-17 ~06:15 (Africa/Abidjan)
- Branche : feat/sentinelle-demo
- Dernier commit pertinent : voir `git log` (« ci: … » après 7f87155)

## Objectif courant
- Jalon : application terminée (D-17 à D-20). Fonctions gelées.
- Critère de réussite suivant : vérification sur l'ordinateur Windows du porteur (docs/GUIDE.md § 2, docs/DEMO.md).

## Travail terminé
- Démo P0 (moteur R-B1, terrain hors connexion, console d'enquête, corrections, comparaison).
- Finition : mode authentifié, import CSV, corrections de mouvements, paramètres, historique, QR.
- IA : client Anthropic ou compatible OpenAI (Ollama/LM Studio), aide à la saisie, synthèse déterministe + reformulation IA vérifiée et conservée.
- Rapport d'enquête imprimable / PDF.
- Exploitation : sauvegarde/restauration, gestion des comptes, Dockerfile, CI GitHub Actions.
- Revue indépendante : 10 constats, tous corrigés et testés (D-19).
- Guide complet : docs/GUIDE.md.

## Vérifications
Environnement Claude (Linux, Node 22) :
- `pnpm -r typecheck` OK ; `pnpm -r test` : domain 33/33, api 46/46, web 6/6.
- `test:pg` sur un vrai PostgreSQL 16 local : 46/46.
- `pnpm e2e` : 13/13 (dont vrai hors ligne, mode authentifié, rapport PDF, déconnexion protégée).
- Essais réels : `pnpm demo`, migration d'une ancienne base, `demo:reset`, `user:create/list/disable`, `db:backup`, `db:restore`.
- Rapport PDF relu visuellement.
GitHub Actions (exécution 44028576691) : job tests vert (typage, tests, PostgreSQL serveur, 13 E2E) ; job Docker : image construite, démarrage en échec à cause du nom de conteneur (corrigé, résultat à relire dans l'exécution suivante).
**Non exécuté** : tout sous Windows ; appel à un vrai modèle d'IA (aucune clé, aucun Ollama ici) ; scan QR avec caméra ; lecteur d'écran ; deuxième appareil.

## Blocages et autorisations
- Règlement : autorisation du code préalable **non confirmée** → tout le code est à déclarer (docs/DEMO.md).
- Pas de mise en ligne : mode authentifié non prêt pour Internet (D-13, GUIDE § 7.5).

## Prochaine action
- Sur Windows : `git pull`, `pnpm install`, `pnpm demo`, dérouler docs/DEMO.md ; pour l'IA locale, suivre GUIDE § 5 option A.
