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
| `pnpm user:create --id ID --username IDENTIFIANT --name "Nom" --role AGENT\|VET --org ORG-DEMO` | Crée un compte pour le mode authentifié (mot de passe demandé, 12 caractères minimum) |
| `pnpm demo:reset` | Réinitialise les données de démonstration (destructif, mode démo uniquement). Option : `pnpm demo:reset --avec-signalement` |
| `pnpm db:backup` / `pnpm db:restore fichier` | Sauvegarde / restauration de la base embarquée (serveur arrêté) |
| `pnpm user:list` / `user:disable` / `user:enable` | Gestion des comptes du mode authentifié |
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

## Fonctionnalités

- **Terrain (agent)** : recherche manuelle ou QR code (raccourci, sans valeur de preuve), fiche animale consultable hors connexion, déclaration avec brouillon persistant, file d’envoi explicite et sans doublon, correction des présences et des mouvements demandée par l’enquêteur.
- **Enquête (vétérinaire)** : examen humain du signalement, analyse déterministe (parcours enregistré / liens potentiels / conclusions impossibles), synthèse citant ses preuves, explication et calcul de chaque résultat, informations à vérifier, versions d’analyse et comparaison expliquée, paramètres modifiables, historique du dossier, rapport imprimable / PDF.
- **Import CSV** avec prévisualisation, erreurs ligne par ligne et import tout-ou-rien.
- **Aide IA facultative** à la structuration d’une observation : désactivée par défaut, proposition à confirmer.

## Deux modes d’accès

| | Mode démonstration (`DEMO_MODE=true`, défaut) | Mode authentifié (`DEMO_MODE=false`) |
|---|---|---|
| Accès | sélecteur de rôle, **pas d’authentification** | identifiant + mot de passe, cookie de session httpOnly |
| Réinitialisation | possible | refusée |
| Usage | démonstration locale | base d’un pilote — **pas encore prêt pour une mise en ligne** (voir D-13) |

```bash
# PowerShell
$env:DEMO_MODE="false"; pnpm user:create --id U-VET-1 --username dr.exemple --name "Dr Exemple" --role VET --org ORG-DEMO
$env:DEMO_MODE="false"; pnpm demo
```

## IA (facultative)
Désactivée par défaut : tout fonctionne sans elle. Activable côté serveur avec un modèle **local gratuit** (Ollama, LM Studio) ou un service en ligne (Anthropic, OpenAI…). Deux usages : aide à la saisie d’une observation et reformulation de la synthèse d’enquête, toujours vérifiée contre les preuves. Le moteur d’analyse n’utilise jamais l’IA. Configuration : [docs/GUIDE.md § 5](docs/GUIDE.md).

## Architecture

```
packages/domain     moteur pur et déterministe (règle R-B1), scénario B-017, comparaison d'analyses
packages/contracts  schémas Zod partagés (validation serveur)
apps/api            Fastify + PostgreSQL (PGlite ou serveur), migrations SQL, révisions en ajout seul
apps/web            React + Vite + Tailwind, IndexedDB (Dexie) pour brouillons et file d'envoi, service worker
docs/               produit, domaine, décisions, état, démo, design, tests, maquettes
```

## Documentation
- [docs/GUIDE.md](docs/GUIDE.md) — **guide complet** (utilisation, IA, import, administration, dépannage)
- [docs/DEMO.md](docs/DEMO.md) — script de démonstration, préparation, secours, limites
- [docs/DOMAIN.md](docs/DOMAIN.md) — règles temporelles, statuts, scénario de référence
- [docs/PRODUCT.md](docs/PRODUCT.md) — périmètre, utilisateurs, exclusions
- [docs/DECISIONS.md](docs/DECISIONS.md) — décisions
- [docs/STATUS.md](docs/STATUS.md) — état et vérifications réellement exécutées

## Limites importantes
- **Mode démonstration** : sélecteur de rôle, **pas d’authentification sécurisée**. Ne pas mettre en ligne.
- La règle R-B1 (chevauchement de présence) est une **règle de démonstration à valider** par des vétérinaires.
- « Exclu par cette recherche » ne signifie pas « sans risque sanitaire ».
- Le hors connexion suppose que l’application a déjà été chargée une fois avec le réseau ; la correction d’un enregistrement nécessite le serveur.
- Le scan QR dépend de l’API BarcodeDetector du navigateur (Chrome/Edge Android notamment) ; non testé avec une vraie caméra.
