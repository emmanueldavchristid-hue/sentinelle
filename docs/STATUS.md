# État de reprise : SENTINELLE VIVANT

Brief de référence : `docs/BRIEF_SENTINELLE_VIVANT.md`. Mot-clé `REPRISE` : lire `CLAUDE.md`, ce fichier, puis `git status`.

## Dernier point de contrôle
- Date : 2026-11-21 (Africa/Abidjan), session Claude Code sur le PC Windows de Yvan.
- Branche : `sentinelle-vivant` (créée depuis `feat/sentinelle-demo`, qui garde la version du 20/11 avec ses correctifs commités : `da53611`).
- Rien n'est poussé vers GitHub. Aucune fusion.

## Audit du 21/11 (dépôt réel)
| Constat | Détail |
|---|---|
| Fonctionne et réutilisé | Synchronisation idempotente des observations, révisions en ajout seul, tâches de vérification, outbox hors connexion (Dexie), rôles et isolation par organisation, moteur de mouvements et console d'enquête (inchangés, réservés au vétérinaire). |
| Écart avec le brief | Le dépôt contient 5 animaux de référence (B-017), pas 5 000 : ceux de la recette venaient d'un import CSV dans `data/pglite` (base locale non versionnée, non touchée). |
| Manquait | Aucun événement récent (jeu daté de mars 2026), pas de rôle éleveur, aucun fichier `.env` lu par le serveur, aucune fonction de lecture « exploitation ». |
| Défaut trouvé en route | Une recompilation serveur allumé laissait un écran blanc : le serveur renvoyait la page HTML à la place d'un script absent, et le service worker la mettait en cache. Corrigé (404 réel, cache v2). |

## Ce qui marche (vérifié)
- **Écran d'ouverture « Mon élevage aujourd'hui »** : l'application s'ouvre dessus avec l'éleveur de démonstration ; le sélecteur de rôle reste accessible par « Changer de rôle » ou `/#/roles`.
- **Fonctions de lecture** (`apps/api/src/farm.ts`, routes `/api/farm/*`) : situation, changements entre deux états, recherche tolérante (« B 017 », « b17 »), fiche animale avec déplacements, informations manquantes, preuve d'une source. Chaque résultat porte sources, trois dates, période, limites.
- **Écritures confirmées** : texte ou saisie manuelle, brouillon, validation serveur des champs, confirmation, enregistrement par la synchronisation idempotente existante, reçu du serveur. Un rejeu au contenu différent renvoie 409 au lieu d'un faux doublon. Dates impossibles refusées.
- **Constellation vivante** (SVG maison) avec liste équivalente et chronologie ; « Montre-moi B-017 » sélectionne l'animal, numérote son parcours, estompe le reste.
- **Boucle de preuve** : même question après une écriture, réponse mise à jour, puis « Pourquoi ta réponse a changé ? » montre la comparaison des deux états et l'enregistrement ajouté.
- **Assistant IA réel (Gemini)** : appels de fonctions vérifiés contre la vraie API le 21/11 (`pnpm assistant:check` : liste des modèles, appel minimal, appel de fonction). Citations contrôlées côté serveur ; repli annoncé en lecture directe si le fournisseur échoue. Pour les questions de lecture reconnues (changements, manques, situation), le serveur fait la lecture de référence et le modèle la formule : deux réponses à la même question restent comparables. « Pourquoi ta réponse a changé ? » est toujours calculé directement.
- **Brouillon demandé par l'IA** : les valeurs avancées par le modèle sont recoupées avec la phrase de l'utilisateur. Constat réel du 21/11 : pour « ce matin », le modèle proposait 08:00 ; corrigé, aucune heure n'est gardée si elle n'est pas écrite, et un animal ou un lieu absent de la phrase est signalé « à vérifier » ou écarté.
- **Preuve produit (livrable A)** : deux captures réelles du parcours en 16 étapes, une seule prise chacune, 1366 x 768, enregistrées par le navigateur et contrôlées sur images extraites : `docs/captures/parcours-vivant.webm` (54 s, sans IA) et `docs/captures/parcours-vivant-ia.webm` (64 s, Gemini réel). Reproductibles : `apps/web/e2e/capture.spec.ts` (`CAPTURE=1`). Format WebM, pas MP4.
- **Sans clé ou avec `ASSISTANT_AI=off`** : la zone de conversation l'annonce et lit les données par règles fixes, sans IA. Tout le parcours passe ainsi.
- **Hors connexion** : dernière lecture conservée et datée, aucune réponse simulée, observation gardée sur l'appareil puis transmise au retour du réseau.

## Ce qui ne marche pas ou n'existe pas
- **Voix** : non implémentée, donc absente de l'interface (aucun bouton micro factice). `GEMINI_LIVE_MODEL` est prévu en configuration, sans code derrière.
- **Lots** (volailles) : aucun lot en base ; l'écran affiche « aucun lot ». Pas de recherche documentaire, pas de simulateur IoT (bonus non commencés).
- **Préparer une tâche** par l'assistant : non fait (les tâches existantes viennent des enquêtes).
- **Vidéo de vision (livrable B)** : script seul. `docs/VIDEO.md` (storyboard, narration, captures à tourner, prompts de plans, instructions) et `docs/video/sous-titres-vision.srt` existent ; aucun plan généré, aucune voix, aucun montage, aucun rendu, aucun MP4.
- **Latence de l'IA** : de 1 à 18 secondes selon les appels, mesurée le 21/11. Au-delà de `ASSISTANT_TIMEOUT_MS` (20 s par défaut), repli annoncé en lecture directe.
- Modèles Gemini : `gemini-3.8-flash` et `gemini-4-hydrogen` répondaient 503 (surcharge) le 21/11 ; `gemini-3.6-flash` a mis jusqu'à 39 s. Retenu : `gemini-3.5-flash-lite` (1 à 6 s), secours `gemini-3.6-flash`.
- Défauts connus non traités : identifiants en double à la casse près (la recherche les liste, sans les fusionner), fenêtre par défaut d'une enquête pour une date « Inconnue », lisibilité de l'ancien schéma de la console d'enquête.

## Tests exécutés (Windows, Node 24, 21/11)
- `pnpm -r typecheck` : OK.
- Tests unitaires : API **80/80** (dont 34 nouveaux : `farm.test.ts`, `assistant.test.ts`), web 6/6. Domaine **32/33** l'après-midi du 21/11 : le test de performance du moteur (« 2 000 animaux, calcul sous 2 s ») échoue à 2,3 s sur cette machine alors qu'il passait le matin (33/33) ; le code du moteur n'a pas été modifié, le seuil non plus.
- `pnpm assistant:check` : opérationnel avec la clé de `sentinelle/.env` (appels réels).
- Navigateur : parcours déroulé à la main dans l'aperçu intégré, à 1242 px (1366 px à 110 %) et 375 px, sans IA puis avec Gemini.
- `PW_CHANNEL=chrome pnpm e2e` : **15/15** dans Chrome (plus la capture, ignorée sans `CAPTURE=1`), sans IA (`ASSISTANT_AI=off`). Dont `vivant.spec.ts` : parcours d'acceptation en 16 étapes, états limites et hors connexion, téléphone 375 px. Les 12 tests antérieurs passent après adaptation (sélecteur de rôle à `/#/roles`, comptages filtrés sur B-017, plus de sélection d'office depuis le correctif du 20/11).
- Projet `auth` des tests de navigateur : **non exécuté** (ignoré sous Windows) ; `auth.spec.ts` a été adapté sans pouvoir être rejoué ici. Commande : `pnpm e2e` sous Linux ou en CI.

## Blocages et points d'attention
- **Clés exposées** : les clés ont transité par WhatsApp et par la conversation Claude. À régénérer après la démonstration. La clé « grok » est en réalité une clé Groq (`gsk_`) : non enregistrée, non utilisée.
- **Palier gratuit Google** : d'après la documentation lue le 21/11, le contenu envoyé sur le palier gratuit sert à améliorer les produits Google. Acceptable ici (données synthétiques), à revoir avant toute donnée réelle. La facturation du projet Google de la clé n'est pas visible depuis ce poste.
- **Règlement du concours** : autorisation du code préalable toujours non confirmée (D-01, D-09).
- La base locale `data/pglite` de Yvan n'a pas été réinitialisée : le jeu vivant n'y apparaît qu'après « Réinitialiser le scénario » (accord de Yvan requis, action destructive).

## Prochaine action précise
1. Décision de Yvan : réinitialiser `data/pglite` (serveur arrêté : `pnpm demo:reset`) pour charger le jeu vivant sur la base de démonstration.
2. Tranche 9 : rejouer `PW_CHANNEL=chrome pnpm e2e` après toute modification ; faire rejouer `auth.spec.ts` en CI.
3. Décisions de Yvan pour la vidéo de vision (voir `docs/VIDEO.md`, « Points ouverts ») : voie de montage, plans générés ou motion design, voix.
4. Voix (tranche 7) : non commencée ; à n'aborder que si le temps le permet, testée séparément du texte.
5. Décider du sort du test de performance du moteur (seuil de 2 s dépassé sur cette machine).
