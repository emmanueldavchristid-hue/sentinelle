# Démonstration SENTINELLE VIVANT (environ 3 minutes)

Données **synthétiques**, mode démonstration (pas d'authentification sécurisée). Un seul ordinateur suffit.
Ce script correspond au parcours d'acceptation en 16 étapes du brief, rejoué automatiquement par `apps/web/e2e/vivant.spec.ts`.

## Préparation (le jour même, 15 minutes avant)
1. Double-clic sur `lancer-sentinelle.bat` (ou `pnpm install` puis `pnpm demo`), ouvrir http://localhost:3000 dans Chrome ou Edge.
2. **Réinitialiser le jeu le jour de la démonstration** : « Changer de rôle » → « Préparation de la démonstration » → **Réinitialiser le scénario**. Les événements récents du jeu sont datés relativement à ce jour : réinitialisé la veille, « depuis hier » serait vide. Cette action efface les données de démonstration.
3. Revenir à l'accueil : l'application s'ouvre sur « Mon élevage aujourd'hui » (éleveur de démonstration). Vérifier le registre : 8 animaux, 5 enregistrements depuis hier.
4. Assistant IA : dans un terminal, `pnpm assistant:check` doit finir par « texte et appels de fonctions opérationnels ». Sinon, voir « Secours ».
5. Pastille « Serveur joignable », case « Couper le réseau » décochée. Zoom du navigateur à 110 % en projection (1366 px).
6. Ne jamais afficher le fichier `.env` ni le terminal de démarrage à l'écran partagé (la clé n'y est pas écrite, mais autant ne pas montrer de configuration).

## Script
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

Phrases reconnues sans IA (mode direct) : « Qu'est-ce qui a changé depuis hier ? », « Montre-moi B-017 », « Quelles informations manquent ? », « Ajoute une observation sur B-017 : … », « Pourquoi ta réponse a changé ? », « Quelle est la situation de mon élevage ? ». Avec l'IA, les formulations libres fonctionnent aussi.

## Secours
- **L'IA ne répond pas ou répond lentement** : l'application repasse d'elle-même en lecture directe et l'annonce. Pour la couper franchement : ajouter `ASSISTANT_AI=off` dans `sentinelle/.env`, puis relancer le serveur. Tout le parcours ci-dessus passe sans IA, sauf la ligne 2:35.
- **Modèle surchargé (503)** : un modèle de secours est configuré (`GEMINI_FALLBACK_MODEL`). `pnpm assistant:check` dit lequel répond.
- **Pas de réseau** : la conversation est indisponible et le dit ; une observation préparée en saisie manuelle reste sur l'appareil et se transmet depuis « Déclarations » au retour du réseau.
- **Écran blanc après une recompilation** : relancer le serveur, puis recharger la page deux fois.
- **Serveur arrêté** : relancer `pnpm demo` (les données persistent dans `data/pglite`).
- **Base corrompue** : arrêter le serveur, supprimer le dossier `data/`, relancer `pnpm demo`.
- Vidéo de secours : **non enregistrée** à ce jour.

## Limites à annoncer
- Données synthétiques ; aucune intégration réelle ; aucun capteur ; aucune donnée en temps réel.
- Pas de voix, pas de lots (volailles), pas de recherche documentaire dans cette version.
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
- outils d'IA utilisés pour le développement (assistant de code) et, dans le produit, l'API Gemini de Google.
