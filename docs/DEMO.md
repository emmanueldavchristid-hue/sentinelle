# Démonstration SENTINELLE VIVANT (environ 3 minutes)

Données **synthétiques**, mode démonstration (pas d'authentification sécurisée). Un seul ordinateur suffit.
Ce script correspond au parcours d'acceptation en 16 étapes du brief, rejoué automatiquement par `apps/web/e2e/vivant.spec.ts`.

## Préparation (le jour même, 15 minutes avant)
1. Double-clic sur `lancer-sentinelle.bat` (ou `pnpm install` puis `pnpm demo`), ouvrir http://localhost:3000 dans Chrome ou Edge.
2. **Réinitialiser le jeu le jour de la démonstration** : « Changer de rôle » → « Préparation de la démonstration » → **Réinitialiser le scénario**. Les événements récents du jeu sont datés relativement à ce jour : réinitialisé la veille, « depuis hier » serait vide. Cette action efface les données de démonstration.
3. Revenir à l'accueil : l'application s'ouvre sur « Mon élevage aujourd'hui » (éleveur de démonstration). Vérifier le registre : 8 animaux, 5 enregistrements depuis hier.
4. Son : régler le volume du PC ; les réponses sont dites à voix haute par défaut (bouton « Réponses à voix haute » pour couper).
5. Assistant IA : dans un terminal, `pnpm assistant:check` doit finir par « texte et appels de fonctions opérationnels. Conversation en direct : opérationnelle ». L'étape 4 (synthèse vocale par tours) peut être indisponible : elle est limitée à 10 demandes par jour sur le palier gratuit, et n'empêche rien. Sinon, voir « Secours ».
6. Pastille « Serveur joignable », case « Couper le réseau » décochée. Zoom du navigateur à 110 % en projection (1366 px).
7. Ne jamais afficher le fichier `.env` ni le terminal de démarrage à l'écran partagé (la clé n'y est pas écrite, mais autant ne pas montrer de configuration).

## Script
L'application s'ouvre en **affichage simple**. Pour montrer les natures d'information, les sources et les dates sans cliquer, activer « Affichage détaillé » en haut à droite ; sinon, ouvrir « Détails et preuves » sous une réponse.

Version à la voix, en direct (IA activée, micro autorisé, à n'utiliser en public qu'après l'essai de `docs/ESSAIS.md` avec la voix et les haut-parleurs de la salle) : toucher le gros bouton « Parler », attendre le bip, dire la question ; la réponse est dite environ deux secondes après la fin de la phrase. Dire « Ajoute une observation sur B zéro dix-sept : elle mange moins depuis ce matin », écouter le brouillon, dire « je confirme ». Toucher « Interrompre » pour reprendre la parole pendant une réponse. À dire : l'assistant écoute et répond à la voix ; il ne parle pas en même temps qu'on lui parle ; ce qu'il dit s'affiche avec les données qu'il a lues ; il ne peut rien enregistrer sans la confirmation.

Variante « e-mail » (seulement si `pnpm alert:check --envoyer` a déjà livré un message dans la boîte du destinataire de test) : quand la balise sort de sa zone, un e-mail part, un seul pour l'épisode ; ouvrir le message, toucher « Comprendre l'incident » : l'application s'ouvre directement sur la synthèse. À dire : le message est accepté par un service d'envoi, l'écran affiche ce que ce service a répondu, pas une supposition.

Variante « incident » (après un essai réel avec le téléphone) : quand la balise sort de sa zone, toucher « Comprendre avec Sentinelle » sur l'alerte ; la synthèse de l'incident s'affiche (ce qui a été détecté, quand, la mesure, l'état actuel) ; toucher « Écouter et discuter » pour l'entendre et poser des questions.

| Temps | À faire | À dire |
|---|---|---|
| 0:00 | Écran d'ouverture | Chaque jour un élevage produit des informations. La question est de retrouver ce qui a changé, et d'où vient chaque réponse. Ici : ce qui est enregistré, ce qui est récent, ce qui manque, la dernière synchronisation. |
| 0:20 | Taper **Qu'est-ce qui a changé depuis hier ?** | L'assistant lit les données par des fonctions contrôlées. Chaque phrase porte sa nature : fait enregistré, résultat calculé, donnée absente. Chaque source est cliquable. |
| 0:40 | Cliquer une source (une observation) | L'enregistrement exact, avec ses trois dates : événement, saisie, réception par le serveur. Fermer. |
| 0:55 | Taper **Montre-moi B 017** (avec l'espace) | L'identifiant tapé vite est retrouvé. La constellation isole son parcours enregistré, numéroté ; le reste passe au second plan. Aucune observation : cela ne dit rien de son état. |
| 1:20 | Taper **Ajoute une observation sur B-017 : mange moins depuis ce matin** | Un brouillon, pas un enregistrement. Le lieu est proposé et signalé comme tel ; « ce matin » donne un jour, sans heure supposée. |
| 1:40 | **Confirmer et enregistrer** | « Reçu par le serveur » n'apparaît qu'après sa réponse. L'événement arrive dans la chronologie et la constellation, marqué « nouveau ». |
| 2:00 | Bouton **Reposer : qu'est-ce qui a changé depuis hier ?** | Même question, réponse mise à jour : 6 enregistrements au lieu de 5. |
| 2:15 | Bouton **Pourquoi ta réponse a changé ?** | La comparaison des deux états et l'enregistrement ajouté entre les deux. C'est la boucle de preuve vivante. |
| 2:35 | Taper **Quel traitement dois-je lui donner ?** (IA activée) | L'assistant refuse : ni diagnostic ni prescription. Il ne remplace ni l'observation du terrain ni le professionnel de santé animale. |
| 2:50 | « Changer de rôle » → Vétérinaire → Signalements (facultatif) | Le vétérinaire autorisé retrouve la même observation et garde sa console d'enquête. Limites et suite. |

Variante vocale (IA activée, micro autorisé dans le navigateur) : à 1:20, cliquer **Dicter**, dire « Ajoute une observation sur B zéro dix-sept : elle mange moins depuis ce matin », cliquer **Arrêter et transcrire**, relire le texte, puis **Demander**. À n'utiliser en public qu'après un essai concluant avec le micro de la salle.

Variante « baoulé » (service local de parole lancé, `BAOULE_VOICE=on` ; à ne montrer qu'après l'essai de `docs/ESSAIS.md`) : dans « Parler en baoulé », toucher **Mon élevage** : la réponse est dite en baoulé et les faits s'affichent en français. Puis, si l'essai avec une vraie voix a été concluant, toucher **Parler en baoulé** et poser l'une des quatre questions. À dire : aucun service du marché ne sait le baoulé, nous l'avons essayé ; ce sont deux modèles ouverts qui tournent sur cet ordinateur, l'un écoute, l'autre parle ; le chiffre dit est écrit par une règle à partir des données, jamais inventé ; quatre questions seulement, et les phrases restent à valider par des locuteurs. Ne pas annoncer « l'application comprend le baoulé » : elle reconnaît quatre questions.

Variante « suivi automatique » (après un essai réel dehors, `docs/ESSAIS.md`) : faire ouvrir le lien https par deux ou trois personnes prévenues, téléphone à la main ; chacune accepte la demande de position. Sans rien associer, « Téléphone 1 », « Téléphone 2 » apparaissent sur l'écran de l'éleveur et sur la carte ; quand l'une s'éloigne au-delà du seuil, l'alerte dit la distance et la direction. À dire : chaque téléphone joue le rôle d'un capteur, aucun animal n'est équipé ; le navigateur a demandé l'accord de chacun et un bandeau permet d'arrêter ; le serveur ne garde que des mètres par rapport au repère. Préparation : ouvrir le lien d'abord sur un téléphone, dehors, à l'endroit qui servira de repère ; si l'écran affiche « Repère imprécis », toucher « Placer le repère sur cet appareil » sur ce téléphone.

Variante « balise » associée à la main (ancien parcours ; à n'utiliser qu'après un essai réel avec le téléphone prévu) : ouvrir l'application par le lien https, « Associer une balise » sur un animal (par exemple B-071), scanner le QR code avec le téléphone. Sur le téléphone : « Distance simulée » pour une salle (bandeau « données simulées » visible), ou « Autoriser la position » puis « Fixer le repère ici » si l'on peut s'éloigner dehors. Quand la distance dépasse le seuil, l'alerte apparaît sur l'écran de l'éleveur ; demander alors « Quel animal s'est éloigné ? » (au micro : la réponse est lue à voix haute). À dire : c'est un téléphone qui joue le rôle d'un capteur, la balise mesure sa propre distance, aucun capteur n'est posé sur un animal.

Phrases reconnues sans IA (mode direct) : « Qu'est-ce qui a changé depuis hier ? », « Montre-moi B-017 », « Quelles informations manquent ? », « Ajoute une observation sur B-017 : … », « Pourquoi ta réponse a changé ? », « Quelle est la situation de mon élevage ? ». Avec l'IA, les formulations libres fonctionnent aussi.

## Secours
- **La conversation en direct ne s'ouvre pas ou se coupe** : l'écran le dit et affiche le bouton de dictée (une phrase à la fois) ; le texte reste. Pour la désactiver franchement : vider `GEMINI_LIVE_MODEL` dans `sentinelle/.env`, puis relancer le serveur.
- **La nouvelle version pose problème** : fermer le serveur, puis double-clic sur `lancer-secours.bat` (version du 21/11, voix par tours, même base et même configuration).
- **L'IA ne répond pas ou répond lentement** : l'application repasse d'elle-même en lecture directe et l'annonce. Pour la couper franchement : ajouter `ASSISTANT_AI=off` dans `sentinelle/.env`, puis relancer le serveur. Tout le parcours ci-dessus passe sans IA, sauf la ligne 2:35.
- **Modèle surchargé (503)** : un modèle de secours est configuré (`GEMINI_FALLBACK_MODEL`). `pnpm assistant:check` dit lequel répond.
- **Pas de réseau** : la conversation est indisponible et le dit ; une observation préparée en saisie manuelle reste sur l'appareil et se transmet depuis « Déclarations » au retour du réseau.
- **Écran blanc après une recompilation** : relancer le serveur, puis recharger la page deux fois.
- **Serveur arrêté** : relancer `pnpm demo` (les données persistent dans `data/pglite`).
- **Base corrompue** : arrêter le serveur, supprimer le dossier `data/`, relancer `pnpm demo`.
- Vidéo de secours : `docs/captures/parcours-vivant.webm`, capture réelle du parcours écrit, sans IA, en une prise, réenregistrée le 22/11 sur la version actuelle (question, sources, fiche, brouillon, confirmation, reçu, réponse mise à jour, explication ; muette, format WebM, affichage détaillé). `parcours-vivant-ia.webm` date du 21/11 (version précédente, avec Gemini). Aucune vidéo de la conversation en direct ni de l'incident de balise n'est enregistrée ; aucune vidéo montée ni MP4.

## Limites à annoncer
- Données synthétiques ; aucune intégration réelle ; aucun capteur posé sur un animal. La seule mesure automatique est la balise de démonstration (un téléphone ou un ordinateur qui a ouvert le lien), relue toutes les 2 secondes. Sa distance est calculée à partir de la position donnée par son navigateur et d'un repère commun : ce n'est pas une mesure radio de proximité avec l'ordinateur, et en intérieur la précision du GPS donne souvent « incertain ». L'e-mail d'alerte est facultatif et désactivé par défaut ; s'il est activé, il part vers un seul destinataire de test, une fois par épisode.
- Voix : conversation en direct en semi-duplex (on n'interrompt pas l'assistant à la voix, mais par un bouton) ; ses phrases sont dites au fur et à mesure, donc affichées avec les données lues plutôt que contrôlées avant d'être entendues. Vérifiée avec un micro simulé, pas encore avec une voix humaine. En secours : dictée d'une phrase et réponse par une voix de synthèse (10 réponses par jour par le service, puis voix de l'appareil). Pas de lots (volailles), pas de recherche documentaire : l'assistant lit des données structurées par des fonctions ; ce n'est ni un modèle réentraîné ni une recherche dans des documents.
- Sélecteur de rôle = mode démonstration, pas une authentification.
- L'assistant ne voit que ce qui est enregistré. Une absence d'observation n'est pas un bon état de santé.
- Sur le palier gratuit de Google, le contenu envoyé au modèle peut servir à améliorer ses produits : acceptable avec des données synthétiques, à revoir avant toute donnée réelle.
- Hors connexion : l'application doit avoir été chargée une fois ; la coupure est **simulée** par une case à cocher (le vrai mode avion est couvert par un test automatisé de l'ancien parcours).
- Pas de carte : schéma à coordonnées fictives et liste équivalente.
- Règles d'enquête sanitaire (console du vétérinaire) toujours « à valider ».

## Annexe : parcours vétérinaire (version du 20/11)
Toujours disponible par « Changer de rôle ». Résumé : agent de terrain → fiche B-017 → observation hors connexion → transmission → vétérinaire → « Examiner » → enquête (parcours A → M → C, liens potentiels, ce qu'on ne peut pas conclure) → « Demander à un agent » → correction (révision 2) → « Relancer l'analyse » → « Ce qui a changé ». Le script détaillé est dans l'historique Git de ce fichier (commit `3d5b9ad`) et rejoué par `apps/web/e2e/parcours.spec.ts`.

## Trame de pitch (positionnement)
- **Problème** : retrouver ce qui a changé dans un élevage, et savoir d'où vient une réponse.
- **Proposition** : la conversation, les données et l'interface forment un seul produit. Une donnée nouvelle devient un événement consultable, une réponse mise à jour et un changement expliqué.
- **Différence à montrer** : la boucle de preuve vivante (question, réponse sourcée, écriture confirmée, réponse mise à jour, explication de l'écart). Ne pas la présenter comme une première mondiale.
- **Hypothèse de valeur** (non mesurée) : historique partagé, données mieux documentées, confiance dans les réponses.
- Pas de marché chiffré, pas de tarif, pas de partenaire annoncé.

## Travaux préalables à déclarer aux organisateurs
L'autorisation du développement avant le sprint n'est **pas confirmée** (D-01, D-09). Ont été produits avant ou pendant l'événement, à partir du 15/11/2026 :
- cadrage et documentation (`docs/`), maquette statique ;
- moteur, API, interface web, tests (historique Git des branches `feat/sentinelle-demo` et `sentinelle-vivant`) ;
- outils d'IA utilisés pour le développement (assistant de code) et, dans le produit, l'API Gemini de Google ;
- pour la voix en baoulé : deux modèles ouverts exécutés sur l'ordinateur, `abdouaziiz/baoule_stt_2` (Apache 2.0) et `AfriSpeech/africa-tts` (CC-BY-NC, usage non commercial) ;
- le 22/11, une partie du travail (branche `claude/baoule-balise-improvements-wwf2je`) a été faite par l'assistant de code dans une session en ligne, sans le PC.
