# Sentinelle — démonstrateur

> Du signalement à l’enquête, chaque mouvement compte.

Démonstrateur préparé pour le Hackathon SELAB 2026 (Abidjan). Il aide un professionnel habilité à relier un signalement sanitaire bovin aux **mouvements enregistrés** d’un animal, à examiner des **liens potentiels** selon une règle explicite et à voir **ce que les données ne permettent pas de conclure**.

**Données entièrement synthétiques. Prototype local, pas un service de production.** Pas d’outil de diagnostic, pas de prédiction, pas de connexion à un système officiel.

## Démarrage (Windows, macOS ou Linux)

Prérequis : **Node.js 20.19+ ou 22.12+** et **pnpm** (`npm install -g pnpm` ou `corepack enable`). Docker n’est **pas** nécessaire.

```bash
pnpm install
pnpm demo          # compile l'interface puis démarre http://localhost:3000
```

Au premier démarrage, la base PostgreSQL embarquée (PGlite) est créée dans `data/pglite` et le scénario B-017 est chargé.

| Commande | Rôle |
|---|---|
| `pnpm demo` | Compile l’interface et lance le serveur unique (API + interface) |
| `pnpm dev` | Développement : API (port 3000) + Vite (port 5173) |
| `pnpm demo:reset` | Réinitialise les données de démonstration (destructif, mode démo uniquement). Option : `pnpm demo:reset --avec-signalement` |
| `pnpm test` | Tests unitaires et d’intégration (moteur, API, file locale) |
| `pnpm typecheck` | Vérification des types |
| `pnpm e2e` | Parcours navigateur (Playwright). Nécessite Chrome installé (`PW_CHANNEL=chrome`) ou `npx playwright install chromium` |

### PostgreSQL serveur (optionnel)
```bash
docker compose up -d
# PowerShell : $env:DATABASE_URL="postgres://sentinelle:sentinelle-demo@localhost:5432/sentinelle"; pnpm demo
# bash       : DATABASE_URL=postgres://sentinelle:sentinelle-demo@localhost:5432/sentinelle pnpm demo
```
Cette voie n’a **pas** été exécutée dans l’environnement de développement (démon Docker indisponible) : à vérifier sur la machine de démonstration.

## Architecture

```
packages/domain     moteur pur et déterministe (règle R-B1), scénario B-017, comparaison d'analyses
packages/contracts  schémas Zod partagés (validation serveur)
apps/api            Fastify + PostgreSQL (PGlite ou serveur), migrations SQL, révisions en ajout seul
apps/web            React + Vite + Tailwind, IndexedDB (Dexie) pour brouillons et file d'envoi, service worker
docs/               produit, domaine, décisions, état, démo, design, tests, maquettes
```

## Documentation
- [docs/DEMO.md](docs/DEMO.md) — script de démonstration, préparation, secours, limites
- [docs/DOMAIN.md](docs/DOMAIN.md) — règles temporelles, statuts, scénario de référence
- [docs/PRODUCT.md](docs/PRODUCT.md) — périmètre, utilisateurs, exclusions
- [docs/DECISIONS.md](docs/DECISIONS.md) — décisions
- [docs/STATUS.md](docs/STATUS.md) — état et vérifications réellement exécutées

## Limites importantes
- **Mode démonstration** : sélecteur de rôle, **pas d’authentification sécurisée**. Ne pas mettre en ligne.
- La règle R-B1 (chevauchement de présence) est une **règle de démonstration à valider** par des vétérinaires.
- « Exclu par cette recherche » ne signifie pas « sans risque sanitaire ».
- Le hors connexion suppose que l’application a déjà été chargée une fois avec le réseau.
