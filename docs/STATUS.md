# État de reprise

## Dernier point de contrôle
- Date et heure : 2026-11-15 ~17:30 (Africa/Abidjan)
- Branche : feat/sentinelle-demo
- Dernier commit pertinent : « docs: cadrage M0 et scénario de référence M1a » (voir `git log`)

## Objectif courant
- Jalon : M1b→M5 (développement lancé par décision D-09)
- Critère de réussite M1b : tests ENG-01 à ENG-21 (docs/TEST_CASES.md) verts sur le scénario B-017

## Travail terminé
- CLAUDE.md (avec protocole REPRISE), docs/PRODUCT.md, docs/DOMAIN.md (règle R-B1, scénario B-017, résultats attendus analyses 1 et 2), docs/TEST_CASES.md, docs/DECISIONS.md (D-01 à D-08).
- Maquette statique docs/mockups/enquete.html (écran d'enquête, résultat B-052 sélectionné).

## Travail en cours
- Aucun fichier modifié partiellement.

## Vérifications
- Environnement Claude (Linux) : maquette ouverte dans Chrome headless via Playwright (script hors dépôt) à 1440 px et 375 px ; débordement horizontal mesuré = 0 px dans les deux cas ; captures relues visuellement, chevauchements de libellés corrigés.
- Calculs du scénario : vérifiés à la main dans DOMAIN.md §5 (pas de code).
- Non exécuté : contrastes mesurés, navigation clavier, lecteur d'écran, rendu sous Windows.
- Limite connue de la maquette : sur mobile, le tableau défile horizontalement à l'intérieur de sa carte (la page ne déborde pas). La version finale prévoit une liste en cartes.

## Blocages et autorisations
- Autorisation du développement avant le sprint : **non confirmée** → aucun code destiné au concours.
- Ordinateur de démo : Windows, Docker déclaré installé (fonctionnement non vérifié).
- Actions externes : push de la branche feat/sentinelle-demo vers GitHub (vérifier avec `git ls-remote origin`).

## Prochaine action
- Initialiser le monorepo, moteur + tests, API, web.
- Sinon : rédiger docs/DEMO.md (script de 3 min) et la maquette mobile « fiche + déclaration hors connexion ».
