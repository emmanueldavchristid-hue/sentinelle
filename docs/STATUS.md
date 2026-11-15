# État de reprise

## Dernier point de contrôle
- Date et heure : 2026-11-15 ~20:05 (Africa/Abidjan)
- Branche : feat/sentinelle-demo
- Dernier commit pertinent : db23f7f « feat: démonstrateur P0 complet… »

## Objectif courant
- Jalon : M6/M7 — finition demandée par le porteur le 15/11 21:04 (démo P0 jugée prête). En cours : authentification réelle, import CSV, aide IA optionnelle, corrections de mouvements, historique, QR, tests manquants.
- Critère de réussite suivant : `pnpm install && pnpm demo` et le script docs/DEMO.md réussis sur l'ordinateur Windows du porteur.

## Travail terminé
- Moteur pur R-B1 + scénario B-017 + comparaison d'analyses (`packages/domain`).
- API Fastify + PostgreSQL (PGlite par défaut, `DATABASE_URL` sinon) : révisions en ajout seul, instantané par analyse, synchronisation idempotente, conflits 409, rôles et isolation des organisations, réinitialisation démo.
- Interface : recherche/fiche, déclaration avec brouillon persistant, file d'envoi (À transmettre → En cours → Reçu / Échec + Réessayer), simulation de coupure nommée, examen du signalement, console d'enquête (schéma SVG, liste, « Pourquoi ce résultat ? », informations à vérifier, versions, comparaison, impression), correction par l'agent, service worker.
- Docs : README, DEMO (script, secours, pitch, travaux à déclarer), DESIGN (contrastes), DECISIONS D-01→D-11.

## Vérifications (environnement Claude, Linux, Node 22)
- `pnpm -r typecheck` : OK (4 paquets).
- `pnpm -r test` : domain 25/25, api 18/18, web 6/6.
- `CHROME_PATH=/usr/bin/google-chrome pnpm --filter @sentinelle/web e2e` : 4/4 (parcours principal complet en 10 étapes, accès refusé, 360 px sans débordement, clavier partiel).
- Démarrage réel du serveur avec base sur disque : écriture, redémarrage, relecture OK. `pnpm demo:reset --avec-signalement` OK.
- Captures relues : console (analyses 1 et 2), déclaration mobile ; schéma corrigé après relecture.
- Contrastes calculés (docs/DESIGN.md).
- **Non exécuté** : tout sur Windows ; voie Docker / PostgreSQL serveur (démon Docker indisponible ici) ; vrai mode avion ; 1920 px ; lecteur d'écran ; `prefers-reduced-motion` ; deuxième appareil. Test de performance du moteur exécuté (2 000 animaux, seuil < 2 s respecté), durée exacte non relevée.

## Blocages et autorisations
- Règlement : autorisation du code préalable **non confirmée** → code à déclarer (docs/DEMO.md, « Travaux préalables »).
- Branche poussée sur GitHub ; aucune branche `main`, aucune fusion.

## Prochaine action
- Sur Windows : `git clone`, `git checkout feat/sentinelle-demo`, `pnpm install`, `pnpm demo`, dérouler docs/DEMO.md ; noter tout écart ici.
- Ensuite, si P0 stable : un bonus P1 au choix (import CSV, ou saisie assistée par IA via l'interface `StructuringProvider`, sans API payante).
