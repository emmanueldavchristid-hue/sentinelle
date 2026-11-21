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
- **Dictée (voix, tranche 7)** : bouton « Dicter » sous la zone de question. Enregistrement court déclenché et arrêté par l'utilisateur (30 s au plus, `VOICE_MAX_SESSION_SECONDS`), micro actif signalé avec compteur, annulation possible. L'audio est converti en WAV dans le navigateur, transcrit par Gemini via le serveur (`POST /api/assistant/transcribe`), puis jeté : ni l'audio ni le texte ne sont stockés ou journalisés. Le texte revient dans la zone de saisie pour relecture, puis suit le parcours écrit (brouillon, confirmation). Vérifié de bout en bout dans Chrome avec un faux micro (fichier de synthèse) et une vraie transcription : `VOIX=1 PW_CHANNEL=chrome pnpm --filter @sentinelle/web exec playwright test --project=voix`. Transcription réelle mesurée : 2,8 s.
- **Balises de démonstration (idée de Mouhi, 21/11)** : un téléphone joue le rôle d'un capteur de proximité. « Associer une balise » (écran « Mon élevage ») crée un lien et un QR code ; sur le téléphone, la page « balise » fixe un repère puis transmet toutes les 3 secondes sa distance au repère (GPS du navigateur, https requis) ou une distance simulée à la main. Le serveur calcule le statut (dans la zone, hors zone, incertain, pas de position, muette). Hors zone : alerte dans l'application, question « Quel animal s'est éloigné ? » (texte ou dictée, réponse lue à voix haute si la question a été dictée), preuve du dispositif et de ses mesures. Les coordonnées GPS ne quittent pas le téléphone. Vérifié de bout en bout dans Chrome avec un second navigateur jouant le téléphone, position GPS **émulée** par l'outil de test (`balises.spec.ts`).
- **Réponses à voix haute** (pour une personne qui ne lit pas) : activées par défaut, coupables par le bouton « Réponses à voix haute ». Chaque réponse, chaque brouillon (animal, lieu, date, texte, puis « appuyez sur Confirmer »), chaque reçu, chaque erreur de connexion et chaque alerte de balise est aussi dit. La voix lit le texte affiché, sans rien ajouter, et se présente comme une voix de synthèse. Voix du serveur : Gemini (`GEMINI_TTS_MODEL=gemini-3.8-flash-lite-tts`, `POST /api/assistant/speak`, texte et son jamais conservés) ; repli automatique sur la voix de synthèse de l'appareil (hors connexion, panne, pas de modèle vocal). Vérifié : son réel reçu par le lien https en 3,8 s ; contenu contrôlé en le faisant retranscrire (le texte revient à l'identique) ; parcours « je dicte, on me répond à la voix » rejoué dans Chrome (`voix.spec.ts`). Constat corrigé : une consigne placée devant le texte était lue à voix haute, seul le texte à dire est donc envoyé.
- **Sans clé ou avec `ASSISTANT_AI=off`** : la zone de conversation l'annonce et lit les données par règles fixes, sans IA. Tout le parcours passe ainsi.
- **Hors connexion** : dernière lecture conservée et datée, aucune réponse simulée, observation gardée sur l'appareil puis transmise au retour du réseau.

## Ce qui ne marche pas ou n'existe pas
- **Balises** : jamais essayées avec un vrai téléphone ni un vrai GPS (seulement une position émulée). En intérieur, la précision du GPS (souvent 10 à 30 m) donnera « incertain » plutôt que « hors zone » dans une petite salle : c'est voulu, et le mode simulé, marqué « données simulées », sert à ce cas. Pas de notification par e-mail ni sur le téléphone : le brief interdit les notifications externes ; l'alerte est dans l'application. Un téléphone en veille n'envoie plus rien (balise dite « muette »).
- **Conversation vocale en direct** (API Live, échange parlé continu) : non implémentée. `GEMINI_LIVE_MODEL` reste prévu en configuration, sans code derrière. Ce qui existe est la dictée (voir « Ce qui marche »).
- Dictée : le refus du micro, l'absence de micro et la coupure réseau ont leurs messages, mais ces trois cas n'ont pas été rejoués dans un navigateur (seuls le parcours complet et l'annulation l'ont été). Aucun essai avec une vraie voix humaine ni sur téléphone. Les réponses parlées n'ont pas été écoutées par une personne : leur contenu a été contrôlé par transcription, pas leur naturel ni leur prononciation des identifiants. Le palier tarifaire du modèle vocal n'a pas été vérifié sur la page des tarifs de Google.
- **Lots** (volailles) : aucun lot en base ; l'écran affiche « aucun lot ». Pas de recherche documentaire, pas de simulateur IoT (bonus non commencés).
- **Préparer une tâche** par l'assistant : non fait (les tâches existantes viennent des enquêtes).
- **Vidéo de vision (livrable B)** : script seul. `docs/VIDEO.md` (storyboard, narration, captures à tourner, prompts de plans, instructions) et `docs/video/sous-titres-vision.srt` existent ; aucun plan généré, aucune voix, aucun montage, aucun rendu, aucun MP4.
- **Latence de l'IA** : de 1 à 18 secondes selon les appels, mesurée le 21/11. Au-delà de `ASSISTANT_TIMEOUT_MS` (20 s par défaut), repli annoncé en lecture directe.
- Modèles Gemini : `gemini-3.8-flash` et `gemini-4-hydrogen` répondaient 503 (surcharge) le 21/11 ; `gemini-3.6-flash` a mis jusqu'à 39 s. Retenu : `gemini-3.5-flash-lite` (1 à 6 s), secours `gemini-3.6-flash`.
- Défauts connus non traités : identifiants en double à la casse près (la recherche les liste, sans les fusionner), fenêtre par défaut d'une enquête pour une date « Inconnue », lisibilité de l'ancien schéma de la console d'enquête.

## Tests exécutés (Windows, Node 24, 21/11)
- `pnpm -r typecheck` : OK.
- Dictée puis réponse parlée : `voix.spec.ts` 1/1 (à la demande, appels réels de transcription et de synthèse vocale).
- Tests unitaires : API **98/98** (dont 52 nouveaux, avec `beacons.test.ts` : `farm.test.ts`, `assistant.test.ts`), web 6/6. Domaine **32/33** l'après-midi du 21/11 : le test de performance du moteur (« 2 000 animaux, calcul sous 2 s ») échoue à 2,3 s sur cette machine alors qu'il passait le matin (33/33) ; le code du moteur n'a pas été modifié, le seuil non plus.
- `pnpm assistant:check` : opérationnel avec la clé de `sentinelle/.env` (appels réels).
- Navigateur : parcours déroulé à la main dans l'aperçu intégré, à 1242 px (1366 px à 110 %) et 375 px, sans IA puis avec Gemini.
- `PW_CHANNEL=chrome pnpm e2e` : **16/16** dans Chrome (plus la capture, ignorée sans `CAPTURE=1`), sans IA (`ASSISTANT_AI=off`). Dont `vivant.spec.ts` : parcours d'acceptation en 16 étapes, états limites et hors connexion, téléphone 375 px. Les 12 tests antérieurs passent après adaptation (sélecteur de rôle à `/#/roles`, comptages filtrés sur B-017, plus de sélection d'office depuis le correctif du 20/11).
- Projet `auth` des tests de navigateur : **non exécuté** (ignoré sous Windows) ; `auth.spec.ts` a été adapté sans pouvoir être rejoué ici. Commande : `pnpm e2e` sous Linux ou en CI.

## Blocages et points d'attention
- **Clés exposées** : les clés ont transité par WhatsApp et par la conversation Claude. À régénérer après la démonstration. La clé « grok » est en réalité une clé Groq (`gsk_`) : non enregistrée, non utilisée.
- **Palier gratuit Google** : d'après la documentation lue le 21/11, le contenu envoyé sur le palier gratuit sert à améliorer les produits Google. Acceptable ici (données synthétiques), à revoir avant toute donnée réelle. La facturation du projet Google de la clé n'est pas visible depuis ce poste.
- **Règlement du concours** : autorisation du code préalable toujours non confirmée (D-01, D-09).
- Base locale `data/pglite` : réinitialisée le 21/11 à 15:15 avec l'accord de Yvan (jeu vivant chargé, vérifié : 8 animaux, 5 enregistrements depuis hier). Sauvegarde de l'état précédent : `data/sauvegardes/avant-jeu-vivant-2026-11-21.tar.gz` (hors Git). **Les dates du jeu sont relatives au jour de la réinitialisation : à refaire le jour de la démonstration** (`pnpm demo:reset` serveur arrêté, ou « Réinitialiser le scénario »), sinon « depuis hier » sera vide.

## Prochaine action précise
1. Le jour de la démonstration : réinitialiser de nouveau le jeu (dates relatives), lancer `pnpm assistant:check`, puis dérouler `docs/DEMO.md` une fois en entier sur `http://localhost:3000`.
2. Tranche 9 : rejouer `PW_CHANNEL=chrome pnpm e2e` après toute modification ; faire rejouer `auth.spec.ts` en CI.
3. Décisions de Yvan pour la vidéo de vision (voir `docs/VIDEO.md`, « Points ouverts ») : voie de montage, plans générés ou motion design, voix.
4. Balises : essai réel avec un téléphone par le lien https (repère, éloignement à l'extérieur, mode simulé en salle), puis décider si elles entrent dans le script de démonstration.
5. Dictée : l'essayer avec une vraie voix, au micro du PC de démonstration puis sur téléphone par le lien https ; décider si elle entre dans le script de démonstration.
5. Décider du sort du test de performance du moteur (seuil de 2 s dépassé sur cette machine).
