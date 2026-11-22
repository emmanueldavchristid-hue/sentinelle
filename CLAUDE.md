# Sentinelle — instructions du dépôt

> **Direction en cours (21/11) : SENTINELLE VIVANT.** Lire `docs/BRIEF_SENTINELLE_VIVANT.md` (règles non négociables) et `docs/STATUS.md`.
> L'éleveur est le premier utilisateur ; l'application s'ouvre sur « Mon élevage aujourd'hui ». Branche de travail : `sentinelle-vivant`.

Démonstrateur de hackathon (SELAB 2026, Abidjan, 20–22/11) : relier un signalement
sanitaire bovin aux mouvements enregistrés, avec preuves, données manquantes et
correction. Données **entièrement synthétiques**. Prototype local, pas un service de production.

## Protocole REPRISE
Quand l'utilisateur écrit « REPRISE » :
1. Lire ce fichier puis `docs/STATUS.md`.
2. Vérifier la branche, `git status`, les derniers commits.
3. Examiner les fichiers de la tâche interrompue ; vérifier si un processus utile tourne encore.
4. Déterminer ce qui est terminé, partiel, non commencé. Le dépôt et les tests priment sur un STATUS périmé.
5. Répondre en 4 lignes max (point retrouvé, dernier résultat vérifié, prochaine action, blocage), puis poursuivre.

Après une coupure : ne rien supprimer de non commité, pas de reset ni de changement de branche destructif,
vérifier l'effet d'une commande interrompue avant de la relancer, ne pas relancer aveuglément migration
ou action externe. REPRISE n'autorise ni dépense, ni déploiement, ni action destructive.

## Points de contrôle
Mettre à jour `docs/STATUS.md` (format fixé dans le fichier) : avant une tâche importante, après chaque
sous-tâche significative ou test décisif, avant une opération longue, en fin de session.
Ne pas compter sur une sauvegarde de dernière seconde. Commits aux étapes cohérentes et vérifiées.

## Règles Git
- Branche de travail : `sentinelle-vivant` (la branche `feat/sentinelle-demo` garde la version du 20/11). Jamais de force-push. Jamais de fusion ni de push sans accord.
- La clé de l'assistant vit dans `sentinelle/.env` (ignoré par Git). Ne jamais l'afficher, la journaliser ni la recopier.
- Aucun secret, token ni `.env` versionné. Seul `.env.example` (sans valeurs sensibles).

## Règlement du concours
L'autorisation du développement avant le sprint n'est **pas confirmée** (D-01). Le porteur a décidé
de développer quand même (D-09) : tout le code est à **déclarer comme travail préalable** (docs/DEMO.md).
Ne jamais marquer cette autorisation comme acquise.

## Architecture prévue (D-02)
```
apps/web          React + Vite + Tailwind, Dexie (brouillons + outbox), PWA
apps/api          Fastify, Zod, PostgreSQL (schéma/migrations : une seule solution)
packages/domain   moteur pur, déterministe, sans LLM ni I/O
packages/contracts schémas Zod partagés
docs/             produit, domaine, décisions, état, démo, tests, maquettes
```
Démo cible : un seul ordinateur Windows ; PostgreSQL embarqué (PGlite) par défaut, serveur PostgreSQL via `DATABASE_URL` (D-06, D-10).
Scripts portables (Node/pnpm), pas de bash obligatoire.

## Commandes
- `pnpm install` · `pnpm demo` (build web + serveur unique http://localhost:3000) · `pnpm dev` (API 3000 + Vite 5173)
- `pnpm test` (Vitest : domain, api avec PGlite en mémoire, web/outbox avec fake-indexeddb) · `pnpm typecheck`
- `pnpm e2e` (build + Playwright ; ici : `CHROME_PATH=/usr/bin/google-chrome`, Chromium non téléchargeable)
- `pnpm demo:reset [--avec-signalement]` (destructif, DEMO_MODE uniquement) · `pnpm user:create …` (mode authentifié)
- `pnpm assistant:check` (appels réels à Gemini : liste des modèles, appel minimal, appel de fonction ; n'affiche jamais la clé)
- `ASSISTANT_AI=off` coupe l'assistant IA (lecture directe des données) ; les tests de navigateur tournent ainsi.
- Sous Windows : `PW_CHANNEL=chrome pnpm e2e` (Chrome installé). Après `pnpm build`, redémarrer le serveur (les fichiers compilés sont listés au démarrage).
- Conversation en direct, appels réels à l'API Live avec un faux micro : `DIRECT=1 PW_CHANNEL=chrome pnpm --filter @sentinelle/web exec playwright test --project=direct --project=direct-question --project=direct-confirme --project=direct-incident`.
- Tester sans toucher la version servie : compiler ailleurs (`vite build --outDir <dossier>`) et lancer Playwright avec `WEB_DIST=<dossier>`. Version servie : `GET /api/health` (`version`). Version de secours : étiquette `stable-2026-11-21`, dossier voisin `sentinelle-secours`, `lancer-secours.bat`.
- `pnpm db:backup` / `db:restore` (serveur arrêté) · `pnpm user:list|disable|enable` · `pnpm --filter @sentinelle/api test:pg` (TEST_DATABASE_URL)
- CI : `.github/workflows/ci.yml` · Docker : `Dockerfile`
- E2E : projets `desktop` (démo, port 3100) et `auth` (DEMO_MODE=false, port 3101, ignoré sous Windows)
- Base : PGlite dans `data/pglite` par défaut ; `DATABASE_URL` pour un serveur PostgreSQL ; `DATA_DIR=memory` pour une base volatile.
- Migrations : `apps/api/src/migrations/NNN_*.sql`, appliquées au démarrage (table `schema_migrations`).

## Invariants métier (détails : docs/DOMAIN.md)
- Niveau A (parcours du même animal) ≠ niveau B (liens potentiels selon règle) ≠ conclusions impossibles.
- Statuts : Mouvement enregistré · Lien potentiel selon les paramètres · Information insuffisante ·
  Chemin exclu par cette recherche · Anomalie de données.
- « Exclu » ≠ « sans risque ». Chevauchement ≠ contact ≠ transmission. Absence d'enregistrement ≠ absence de contact.
- Temps : UTC stocké, affichage `Africa/Abidjan`, intervalles `[début, fin)`, précision explicite,
  jamais de minuit implicite, heure d'événement ≠ heure de saisie.
- Moteur : mêmes données + paramètres → mêmes résultats ; cycles, profondeur, plafond, déduplication.
- Assistant : faits issus des fonctions de `farm.ts` uniquement, cinq natures d'information étiquetées, trois dates distinguées, aucune écriture sans brouillon puis confirmation, aucun faux temps réel.
- Balises : toujours « la balise associée à tel animal », jamais « l'animal s'évade » ; source de la mesure (GPS du téléphone ou simulée) affichée partout ; aucune notification externe. Un éloignement ouvre un seul incident par épisode ; la distance vient du téléphone, pas d'une mesure radio.
- Conversation en direct : semi-duplex ; le modèle n'écrit rien ; « je confirme » est jugé par une règle fixe sur la phrase entendue, pour un brouillon précis, une seule fois ; ne jamais dire que la parole en direct est validée phrase par phrase.
- Chaque analyse stocke paramètres, `engineVersion`, instantané des données et `snapshotHash` (D-03).
- Corrections = nouvelles révisions, jamais d'écrasement. Pas de score de contamination.
- Pas de durée d'incubation codée ; fenêtre choisie par l'enquêteur ; règles marquées « à valider ».

## Conventions
- Interface et docs en français (accents corrects) ; code et identifiants en anglais.
- Statuts jamais portés par la seule couleur. Mention « données synthétiques » visible.
- « Mode démonstration » pour le sélecteur de rôle — jamais « authentification sécurisée » (D-04).
- IA produit : désactivée par défaut ; fournisseur réel seulement si une clé est configurée côté serveur ; aucun faux appel (D-05, D-15).
- Ne jamais déclarer un test exécuté sans l'avoir exécuté ; sinon écrire « non exécuté » + commande.
- Distinguer vérifications faites dans l'environnement Claude et celles à refaire sur Windows.

## Documents
- `docs/BRIEF_SENTINELLE_VIVANT.md` — direction, règles non négociables, parcours d'acceptation en 16 étapes
- `docs/STATUS.md` — point de reprise (court)
- `docs/PRODUCT.md` — périmètre, utilisateurs, parcours, exclusions
- `docs/DOMAIN.md` — règles temporelles, statuts, scénario B-017 et résultats attendus
- `docs/TEST_CASES.md` — cas de tests en langage naturel
- `docs/DECISIONS.md` — décisions courtes
- `docs/mockups/` — maquette statique initiale
- `docs/DEMO.md` — script, préparation, secours, limites, pitch, travaux à déclarer
- `docs/DESIGN.md` — tokens, contrastes mesurés, principes
- `docs/GUIDE.md` — guide complet : installation, utilisation, IA, import, administration, dépannage

## Modules API
`live.ts` (conversation en direct : relais WebSocket `/api/assistant/live` vers l'API Live de Gemini, confirmation liée au brouillon, bornes de consommation) · `beacons.ts` (balises de démonstration : un téléphone transmet sa distance à un repère ; routes `/api/farm/devices` et `/api/devices/:id/*`) · `farm.ts` (SENTINELLE VIVANT : lecture de l'exploitation, brouillon d'observation, routes `/api/farm/*`) · `assistant.ts` (conversation : mode direct sans IA, mode IA par fonctions) · `gemini.ts` (client REST) · `seed-living.ts` (jeu vivant daté relativement à la réinitialisation) · `app.ts` (cœur, enquêtes, corrections, historique) · `auth.ts` (D-13) · `import.ts` (D-14) · `assist.ts` + `llm.ts` (D-15, D-18) · `idempotency.ts` (D-19) · `http.ts` · `db-tools.ts`, `users.ts`, `user-create.ts` (CLI)
