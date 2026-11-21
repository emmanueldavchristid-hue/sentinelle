# Guide de Sentinelle

Ce guide explique comment installer, utiliser et administrer Sentinelle. Toutes les données fournies sont **synthétiques**.

## 1. En deux phrases

Un agent de terrain enregistre une observation sur un bovin, même sans réseau. Un vétérinaire examine ce signalement, lance une enquête qui retrouve les mouvements enregistrés de l’animal, signale les autres animaux présents au même endroit au même moment selon une règle explicite, et montre ce que les données ne permettent pas de conclure ; les informations manquantes sont demandées à l’agent, corrigées, puis l’analyse est relancée et le changement expliqué.

## 2. Installation (Windows, macOS, Linux)

Prérequis : **Node.js 22** (ou 20.19+) et **pnpm** (`corepack enable`, ou `npm install -g pnpm`).

```bash
git clone https://github.com/emmanueldavchristid-hue/sentinelle.git
cd sentinelle
git checkout feat/sentinelle-demo
pnpm install
pnpm demo
```

Ouvrir **http://localhost:3000**. Au premier démarrage, la base (PostgreSQL embarqué) est créée dans `data/pglite` avec le scénario de démonstration B-017. Arrêt : `Ctrl+C`. Les données restent dans `data/`.

## 3. Utilisation

### 3.0 Mon élevage aujourd’hui (SENTINELLE VIVANT, branche `sentinelle-vivant`)
L’application s’ouvre sur cet écran avec l’éleveur de démonstration. Il réunit :
- le **registre** : ce qui est enregistré, ce qui a été reçu depuis hier, ce qui reste à compléter, la dernière réception par le serveur (chaque case pose la question correspondante) ;
- la **constellation** : sites, animaux avec une présence ouverte, déplacements enregistrés ; vue « Liste » équivalente, seule vue sur téléphone ;
- la **chronologie**, avec pour chaque événement sa date, sa saisie et sa réception ;
- **Parler à mon élevage** : une question en texte, une réponse dont chaque phrase porte sa nature (fait enregistré, résultat calculé, donnée absente, suggestion) et ses sources cliquables.

Ajouter une observation : écrire « Ajoute une observation sur B-017 : … » ou cliquer « Ajouter une observation ». Un **brouillon** apparaît ; rien n’est enregistré avant « Confirmer et enregistrer » ; le **reçu** vient du serveur. Reposer ensuite la même question montre la réponse mise à jour, et « Pourquoi ta réponse a changé ? » montre l’enregistrement ajouté entre les deux états.

**Dicter** : sous la zone de question, « Dicter » ouvre le micro (le navigateur demande l'autorisation la première fois). Parlez, puis « Arrêter et transcrire » : le texte apparaît dans la zone de question, à relire avant « Demander ». « Annuler » n'envoie rien. La dictée demande l'assistant IA, une connexion, et une page en https ou sur localhost ; l'enregistrement est limité à 30 secondes et n'est pas conservé. « Écouter la réponse » lit une réponse avec la voix de synthèse de l'appareil.

Sans assistant IA configuré, quelques formulations sont reconnues par des règles fixes (elles sont proposées à l’écran) et la saisie manuelle reste complète. Configuration de l’assistant : § 5.

### 3.1 Choisir un rôle (mode démonstration)
Accessible par « Changer de rôle » ou l’adresse `/#/roles`. L’écran propose quatre comptes fictifs (éleveur, agent de terrain, vétérinaire enquêteur, vétérinaire d’une autre organisation, pour montrer l’isolation). « Changer de rôle » efface les données locales de l’utilisateur ; s’il reste des déclarations non transmises, une confirmation est demandée.

### 3.2 Agent de terrain
1. **Rechercher** un animal par identifiant (ex. B-017), ou **scanner son QR code** si le navigateur le permet (Chrome/Edge sur Android). Le QR n’est qu’un raccourci : il ne prouve pas l’identité de l’animal.
2. **Fiche** : lieu actuel enregistré, présences, observations transmises, QR de la fiche. Consultable hors connexion une fois chargée.
3. **Nouvelle observation** : lieu, moment avec sa **précision** (date et heure / jour seulement / inconnue — aucune heure n’est jamais supposée), description. La saisie est enregistrée sur l’appareil à chaque frappe : fermer l’onglet ne perd rien.
4. **Déclarations** : file d’envoi. États : Brouillon local → À transmettre → En cours → Reçu par le serveur, ou Échec avec « Réessayer ». L’envoi est **explicite** (bouton « Transmettre ») ; un envoi répété ne crée jamais de doublon.
5. **Vérifications** : informations demandées par l’enquêteur. « Compléter » corrige une présence (arrivée/départ) ou un mouvement (départ/arrivée) en indiquant la source. Chaque correction crée une **nouvelle révision** ; l’ancienne reste consultable. Nécessite la connexion au serveur.
6. **Aide à la saisie (IA)** dans le formulaire : seulement si un fournisseur est configuré (§ 5). Elle propose un remplissage à partir d’une phrase ; rien n’est enregistré sans votre validation.

### 3.3 Vétérinaire enquêteur
1. **Signalements** : liste des observations reçues. « Examiner » affiche l’observation, son heure d’événement, son heure de saisie et son heure de réception.
2. **Ouvrir l’enquête** : fenêtre de recherche proposée par défaut (15 jours avant l’observation, jusqu’au lendemain), modifiable — ce n’est pas une durée d’incubation — et profondeur (1 : animaux en présence chevauchante ; 2 : lieux où ils sont allés ensuite). Ou « Classer » avec un motif.
3. **Console d’enquête** :
   - **Synthèse** : texte calculé sans IA, chaque paragraphe cite ses preuves. Si un fournisseur IA est configuré, « Reformuler avec l’IA » produit une version plus fluide, **vérifiée automatiquement** (aucun identifiant inventé, preuves existantes, aucun vocabulaire de conclusion sanitaire) ; si la vérification échoue, la reformulation est rejetée.
   - **Schéma** des lieux (coordonnées fictives) et **liste** équivalente, en trois groupes : parcours enregistré ; liens potentiels selon la règle R-B1 ; ce que les données ne permettent pas de conclure.
   - **Pourquoi ce résultat ?** : explication, calcul, preuves telles qu’elles étaient au moment de l’analyse, règle, limites.
   - **Informations à vérifier** : « Demander à un agent ».
   - **Relancer l’analyse** (mêmes paramètres) ou **Modifier les paramètres et relancer**. Chaque analyse est conservée ; **Comparer les analyses** affiche ce qui a changé et pourquoi.
   - **Historique du dossier** et **Rapport imprimable** (impression ou PDF depuis le navigateur).
4. **Import** : chargement CSV de présences et de mouvements (§ 6).

### 3.4 Lire les résultats
| Statut | Signification |
|---|---|
| → Mouvement enregistré | Déplacement de l’animal signalé, tel qu’enregistré. |
| ≈ Lien potentiel selon les paramètres | Les présences enregistrées se chevauchent selon la règle R-B1. Piste de vérification, **pas** une preuve de contact ni de transmission. |
| ? Information insuffisante | La précision des données ne permet ni d’établir ni d’exclure. |
| ∅ Chemin exclu par cette recherche | Pas de chevauchement selon la règle. **Ne signifie pas « sans risque »**. |
| ! Anomalie de données | Enregistrement incohérent, non utilisé. Pas un signal sanitaire. |

Règle R-B1 (démonstration, **à valider** par des vétérinaires) : deux présences dans un même lieu, intervalles `[début, fin)` ; chevauchement certain → lien potentiel ; absence certaine → exclu ; sinon → information insuffisante. Le transport et la persistance d’un agent dans un lieu ne sont pas modélisés.

## 4. Démonstration
Voir [DEMO.md](DEMO.md) : script de 3 minutes, préparation, solutions de secours. Réinitialiser : page d’accueil → « Préparation de la démonstration », ou `pnpm demo:reset` (`--avec-signalement` pour sauter la partie terrain).

## 5. Intelligence artificielle (facultative)

Sans configuration, l’IA est **désactivée** et tout fonctionne : saisie manuelle complète, synthèse déterministe. Deux fonctions utilisent l’IA si elle est activée : l’aide à la saisie d’une observation et la reformulation de la synthèse d’enquête. Le moteur d’analyse, lui, n’utilise **jamais** l’IA.

### Assistant « Parler à mon élevage » (Gemini)
Cet assistant est distinct des deux fonctions ci-dessus. Il se configure dans un fichier local, jamais versionné :

1. Copier `.env.example` en `.env` dans le dossier `sentinelle` (à côté de `package.json`).
2. Créer une clé dans Google AI Studio et l’écrire sur la ligne `GEMINI_API_KEY=` du fichier `.env`. Ne la coller nulle part ailleurs (ni conversation, ni capture, ni Git). Ne pas définir aussi `GOOGLE_API_KEY`.
3. Lancer `pnpm assistant:check` : la commande liste les modèles réellement disponibles avec la clé, sans jamais afficher celle-ci.
4. Recopier un nom de modèle sur la ligne `GEMINI_MODEL=`, relancer `pnpm assistant:check` (appel minimal puis appel de fonction), puis `pnpm demo`.

Repères mesurés le 21/11/2026 avec la clé du projet : `gemini-3.5-flash-lite` répond en 1 à 6 secondes ; `gemini-3.6-flash` peut mettre près de 40 secondes ; `gemini-3.8-flash` et `gemini-4-hydrogen` renvoyaient « surchargé » (503). `GEMINI_FALLBACK_MODEL` désigne un modèle de secours en cas de 503. `ASSISTANT_AI=off` coupe l’assistant sans retirer la clé.

À savoir : les appels sont décomptés du quota du projet Google rattaché à la clé ; vérifier sur la page des tarifs de Google que le modèle retenu est dans le palier gratuit, et que la facturation n’est pas activée par erreur. Sur le palier gratuit, le contenu envoyé peut servir à améliorer les produits de Google. Les questions et les résultats de lecture quittent donc l’ordinateur : n’y mettre que des données de démonstration.

Garde-fous propres à cet assistant : il n’agit que par les fonctions de `apps/api/src/farm.ts` (aucun SQL libre, aucune écriture hors brouillon) ; un identifiant de source cité qui ne vient pas d’une lecture fait écarter la réponse ; délai maximal `ASSISTANT_TIMEOUT_MS`, nombre de demandes par session `ASSISTANT_MAX_REQUESTS_PER_SESSION` ; en cas d’échec, lecture directe des données, annoncée comme telle.

### Option A — modèle local gratuit (Ollama)
1. Installer Ollama (https://ollama.com), puis : `ollama pull llama3.1` (ou un autre modèle).
2. Lancer Sentinelle avec :
```powershell
$env:AI_PROVIDER="openai-compatible"; $env:AI_BASE_URL="http://localhost:11434/v1"; $env:AI_MODEL="llama3.1"; pnpm demo
```
Aucune donnée ne quitte l’ordinateur. La qualité dépend du modèle : les petits modèles produisent plus souvent des réponses rejetées par la vérification (la synthèse déterministe reste alors affichée). LM Studio fonctionne de la même façon (`AI_BASE_URL=http://localhost:1234/v1`).

### Option B — Anthropic (Claude)
```powershell
$env:AI_PROVIDER="anthropic"; $env:AI_API_KEY="votre-clé"; pnpm demo
```
Modèle par défaut `claude-haiku-5-5` (modifiable avec `AI_MODEL`). L’usage est **facturé par le fournisseur** sur votre compte API (un abonnement à l’application Claude ne fournit pas de clé API). Les textes envoyés quittent l’ordinateur.

### Option C — autre service compatible OpenAI
`AI_PROVIDER=openai-compatible`, `AI_BASE_URL` (ex. `https://api.openai.com/v1`), `AI_MODEL`, `AI_API_KEY`.

### Garde-fous
- Clé uniquement côté serveur, jamais dans le navigateur ni dans Git (fichier `.env` ignoré).
- Texte saisi traité comme une donnée non fiable, encadré, limité à 1 000 caractères ; le modèle ne voit ni la base ni les secrets.
- Délai maximal (`AI_TIMEOUT_MS`, 15 s), plafond quotidien par utilisateur (`AI_MAX_CALLS_PER_DAY`, 100) et global (10 fois plus).
- Réponses validées par un schéma strict ; valeurs hors périmètre écartées ; synthèse reformulée vérifiée contre les preuves.
- Statut affiché au démarrage du serveur (« IA : activée — … » ou « désactivée ») et dans l’interface.

## 6. Import CSV
Écran **Import** (vétérinaire). Colonnes : `type;id;animal;lieu;lieu_arrivee;debut;fin;source` (séparateur « ; » ou « , »). Modèle téléchargeable sur l’écran.
- `type` : `presence` ou `mouvement`.
- Dates (heure d’Abidjan) : `2026-03-01T08:00`, `2026-03-01` (jour seulement), `2026-03-01T08:00/2026-03-01T10:00` (intervalle), vide = inconnue, `en cours` = présence non terminée.
- Prévisualisation obligatoire, erreurs ligne par ligne. Import **tout ou rien**. Un identifiant existant est refusé (il se corrige par révision). Animal inconnu : créé avec avertissement. Lieu inconnu : erreur.

## 7. Administration

### 7.1 Mode authentifié (comptes réels)
```powershell
$env:DEMO_MODE="false"
pnpm user:create --id U-VET-1 --username dr.exemple --name "Dr Exemple" --role VET --org ORG-DEMO
pnpm demo
```
Le mot de passe (12 caractères minimum) est demandé dans le terminal. Autres commandes : `pnpm user:list`, `pnpm user:disable --username X` (révoque les sessions), `pnpm user:enable --username X`. Dans ce mode : connexion par identifiant et mot de passe, session de 8 h, verrouillage 15 min après 5 échecs, sélecteur de rôle et réinitialisation désactivés. Une session expirée renvoie à l’écran de connexion **sans effacer** les déclarations non transmises.

### 7.2 Sauvegarde et restauration
Base embarquée (par défaut) — **arrêter le serveur d’abord** :
```bash
pnpm db:backup                       # écrit backups/sentinelle-AAAA-MM-JJ-HH-MM.tar.gz
pnpm db:restore backups/fichier.tar.gz   # la base actuelle est conservée à côté, jamais supprimée
```
Serveur PostgreSQL : `pg_dump -Fc -d "$DATABASE_URL" -f sentinelle.dump` et `pg_restore -c -d "$DATABASE_URL" sentinelle.dump`.

### 7.3 PostgreSQL serveur
`docker compose up -d` (fichier fourni), puis `DATABASE_URL=postgres://sentinelle:sentinelle-demo@localhost:5432/sentinelle`. Les migrations s’appliquent au démarrage.

### 7.4 Image Docker
```bash
docker build -t sentinelle .
docker run -p 3000:3000 -v sentinelle-data:/data sentinelle
```
Variables utiles : `DEMO_MODE`, `DATABASE_URL`, `COOKIE_SECURE`, `AI_*` (voir `.env.example`).

### 7.5 Avant toute mise en ligne
Le mode authentifié est une base de pilote, **pas** un service prêt pour Internet. Il faut au minimum : HTTPS (proxy inverse) et `COOKIE_SECURE=true`, `DEMO_MODE=false`, PostgreSQL serveur sauvegardé, revue de sécurité externe, politique de comptes (renouvellement de mot de passe), hébergement et conditions d’usage des données validés.

## 8. Pour les développeurs
| Commande | Rôle |
|---|---|
| `pnpm dev` | API (3000) + interface Vite (5173) avec rechargement |
| `pnpm test` | Tests moteur, API (PGlite en mémoire), file locale |
| `pnpm --filter @sentinelle/api test:pg` | Tests d’API sur un vrai PostgreSQL (`TEST_DATABASE_URL`) |
| `pnpm e2e` | Tests navigateur (Playwright) |
| `pnpm typecheck` | Typage |

Architecture : `packages/domain` (moteur pur et synthèse), `packages/contracts` (schémas Zod), `apps/api` (Fastify, modules `app`, `auth`, `import`, `assist`, `llm`, `idempotency`), `apps/web` (React). Décisions : [DECISIONS.md](DECISIONS.md). Règles métier : [DOMAIN.md](DOMAIN.md). Intégration continue : `.github/workflows/ci.yml` (tests, PostgreSQL, navigateur, image Docker).

## 9. Dépannage
| Problème | Solution |
|---|---|
| `pnpm` introuvable | `corepack enable` (PowerShell en administrateur) ou `npm install -g pnpm` |
| Port 3000 occupé | `$env:PORT="3001"; pnpm demo` |
| Écran « Serveur injoignable » | Le serveur n’est pas lancé : `pnpm demo` |
| Données incohérentes après essais | `pnpm demo:reset`, ou arrêter le serveur et supprimer `data/` |
| L’IA reste « désactivée » | Vérifier `AI_PROVIDER` et les variables associées ; lire le message affiché au démarrage du serveur |
| Reformulation IA rejetée | Normal si le modèle invente ou conclut : la synthèse déterministe reste la référence ; essayer un modèle plus capable |
| Scan QR indisponible | Le navigateur ne fournit pas l’API de lecture : utiliser la recherche manuelle |
