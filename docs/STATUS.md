# État de reprise

## Dernier point de contrôle
- Date et heure : 2026-11-15 ~21:20 (Africa/Abidjan)
- Branche : feat/sentinelle-demo
- Dernier commit pertinent : 4890af9 « feat: finition — authentification, import CSV, aide IA optionnelle… »

## Objectif courant
- Jalon : M6/M7 terminés (finition, D-12). Fonctions gelées.
- Critère de réussite suivant : vérification sur l'ordinateur Windows du porteur (`pnpm install`, `pnpm demo`, script docs/DEMO.md).

## Travail terminé
- P0 (démo) : moteur R-B1, API, terrain hors connexion, console d'enquête, correction, comparaison — inchangé fonctionnellement.
- Finition : mode authentifié (D-13), import CSV (D-14), aide IA désactivée par défaut (D-15), correction des mouvements, paramètres d'analyse modifiables, historique du dossier, QR (D-16), en-têtes de sécurité, schéma plafonné en grand écran.

## Vérifications (environnement Claude, Linux, Node 22)
- `pnpm -r typecheck` : OK (4 paquets).
- `pnpm -r test` : domain 25/25, api 36/36, web 6/6.
- `CHROME_PATH=/usr/bin/google-chrome pnpm e2e` : 11/11 — parcours principal, vrai hors ligne (navigateur coupé + service worker), import CSV, correction d'anomalie + historique + paramètres, 1920 px + surlignage croisé + mouvement réduit, QR (repli), IA désactivée, 360 px, clavier, accès refusé, mode authentifié.
- `pnpm demo` réel (build + serveur, base sur disque) : OK ; migration 002 appliquée sur une base de la version précédente sans perte.
- **Non exécuté** : tout sur Windows ; Docker / PostgreSQL serveur ; appel IA réel (aucune clé) ; scan QR avec caméra ; lecteur d'écran ; deuxième appareil ; e2e du mode authentifié sous Windows (commande POSIX, ignoré).

## Blocages et autorisations
- Règlement : autorisation du code préalable **non confirmée** → tout le code est à déclarer (docs/DEMO.md).
- Aucune mise en ligne : le mode authentifié n'est pas prêt pour la production (HTTPS, revue de sécurité, sauvegardes — D-13).

## Prochaine action
- Sur Windows : `git pull`, `pnpm install`, `pnpm demo`, dérouler docs/DEMO.md ; noter les écarts ici.
