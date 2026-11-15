# Démonstration (≈ 3 minutes)

Données **synthétiques**, mode démonstration (pas d’authentification sécurisée). Un seul ordinateur suffit.

## Préparation (la veille et 15 min avant)
1. `pnpm install` puis `pnpm demo` → ouvrir http://localhost:3000 dans Chrome ou Edge.
2. Page d’accueil → « Préparation de la démonstration » → **Réinitialiser le scénario**.
3. Choisir **Agent de terrain**, ouvrir une fois la fiche B-017 (préchargement des fiches et mise en cache de l’interface).
4. « Changer de rôle » (purge les données locales de l’agent), revenir à l’accueil.
5. Vérifier : pastille « Serveur joignable », case « Couper le réseau » décochée.
6. Zoom navigateur 110–125 % si projection.

## Script
| Temps | Écran | À dire / faire |
|---|---|---|
| 0:00 | Accueil | **Problème** : un signalement ne dit pas, à lui seul, quels mouvements vérifier ni ce qui manque. |
| 0:20 | Agent → recherche « B-017 » → fiche | Recherche manuelle ; le QR ne serait qu’un raccourci, il ne prouve pas l’identité de l’animal. |
| 0:35 | Cocher « Couper le réseau (simulation démo) » → Nouvelle observation | Lieu : Élevage C · 12/03/2026 07:30 · « Baisse d’appétit constatée ce matin. » |
| 0:55 | Recharger la page (F5) | Le brouillon est restauré : rien n’est perdu. « Enregistrer sur l’appareil » → état **À transmettre**. |
| 1:05 | Décocher la simulation → « Transmettre (1) » | **Reçu par le serveur** seulement après réponse vérifiée. Un rejeu ne crée pas de doublon. |
| 1:15 | Changer de rôle → Vétérinaire → Signalements → Examiner | Examen humain. Fenêtre proposée 25/02 → 13/03, modifiable : ce n’est pas une durée d’incubation. |
| 1:30 | Ouvrir l’enquête | **Trois catégories** : parcours enregistré (A → M → C) ; liens potentiels (B-031, puis Élevage D à vérifier) ; ce qu’on ne peut pas conclure (B-052 sans heure, B-044 exclu, B-060 anomalie). |
| 1:55 | Cliquer B-044 puis B-052 | « Pourquoi ce résultat ? » : calcul, preuves, règle à valider. *Exclu ≠ sans risque.* Élevage E proche : non évalué, ni lien ni exclusion. |
| 2:10 | « Demander à un agent » (B-052) → Agent → Vérifications → Compléter | Arrivée 11:00, départ 15:00, source « registre du marché ». Révision 2 ; la révision 1 est conservée. |
| 2:35 | Vétérinaire → Enquêtes → la console → « Relancer l’analyse » | **Ce qui a changé** : 1 modifié, 1 ajouté, cause = révision 2 de P6 (déclarée, non vérifiée). L’analyse n° 1 reste consultable telle quelle. |
| 2:50 | — | **Limites et suite** : règles à valider avec des vétérinaires, pilote avec une organisation multi-sites, mesure du temps pour retrouver un parcours. |

## Secours
- **Saisie hors connexion qui échoue** : accueil → « Réinitialiser avec signalement reçu (secours) », passer directement à l’étape vétérinaire. Ou `pnpm demo:reset --avec-signalement`.
- **Serveur arrêté** : relancer `pnpm demo` (les données persistent dans `data/pglite`).
- **Base corrompue** : arrêter le serveur, supprimer le dossier `data/`, relancer `pnpm demo`.
- Vidéo de secours : **non enregistrée** à ce jour.

## Limites à annoncer
- Données synthétiques ; aucune intégration réelle ; aucune validation vétérinaire des règles.
- Sélecteur de rôle = mode démonstration, pas une authentification.
- Hors connexion : l’application doit avoir été chargée une fois ; la correction d’un agent nécessite le serveur.
- La coupure réseau est **simulée** par une case à cocher (le vrai mode avion fonctionne aussi, mais n’a été testé qu’avec la simulation).
- Pas de carte : schéma des lieux à coordonnées fictives et liste équivalente.

## Trame de pitch (positionnement)
- **Problème** : un signalement sanitaire n’indique pas quels mouvements vérifier ni quelles données manquent.
- **Proposition** : parcours terrain → enquête temporelle → preuves → données manquantes → correction → comparaison des analyses. Le contact tracing n’est pas une invention : la différence proposée est ce parcours, explicable et traçable.
- **Client initial à tester** : organisation gérant plusieurs agents ou sites.
- **Hypothèse de valeur** (non mesurée) : historique partagé, suivi des incidents, données mieux documentées, aide à l’enquête.
- **Indicateurs de pilote** : réussite des tâches, temps pour retrouver un parcours, proportion de données complétées, compréhension des résultats, charge de saisie, intérêt à payer.
- Pas de marché chiffré, pas de tarif, pas de partenaire annoncé.

## Travaux préalables à déclarer aux organisateurs
L’autorisation du développement avant le sprint n’est **pas confirmée** (D-01, D-09). Ont été produits avant l’événement, à partir du 15/11/2026 :
- cadrage et documentation (`docs/`), maquette statique ;
- moteur, API, interface web, tests (historique Git de la branche `feat/sentinelle-demo`) ;
- outils d’IA utilisés pour le développement (assistant de code).
