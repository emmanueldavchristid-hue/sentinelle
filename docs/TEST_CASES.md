# Cas de tests — langage naturel

Statut de tous les cas : **spécifiés, non implémentés, non exécutés** (code en attente, voir D-01).
Les identifiants (P1, MV3, R6…) renvoient au scénario de docs/DOMAIN.md §5.

## 1. Moteur (module pur, Vitest)

| ID | Étant donné | Quand | Alors |
|---|---|---|---|
| ENG-01 | Scénario B-017 rév. 1 | on analyse B-017 sur la fenêtre de référence | R1 et R2 sont « Mouvement enregistré », dans l'ordre chronologique A → M → C |
| ENG-02 | idem | idem | B-031 est « Lien potentiel » avec chevauchement 10:00–14:00 et preuves P2, P4 |
| ENG-03 | idem | idem | Élevage D apparaît à profondeur 2 via B-031, preuve MV3 |
| ENG-04 | idem | idem | B-044 est « Chemin exclu par cette recherche » ; l'explication contient la mention « ne signifie pas sans risque » |
| ENG-05 | idem | idem | B-052 est « Information insuffisante » et une tâche de vérification est proposée |
| ENG-06 | idem | idem | B-060 produit « Anomalie de données » et n'est utilisé dans aucun autre résultat |
| ENG-07 | idem | idem | Aucun résultat ne concerne l'Élevage E |
| ENG-08 | P6 en précision `DAY` | on évalue le chevauchement | aucune heure n'est fixée à minuit ; résultat indéterminé |
| ENG-09 | une présence `DAY` le 02/03 face à P2 (01/03 08:00–16:00) | on évalue | absence de chevauchement certaine → exclu (la journée entière est après) |
| ENG-10 | fin de P = 14:00, début de Q = 14:00 | on évalue | pas de chevauchement (intervalles contigus) |
| ENG-11 | une borne `UNKNOWN` | on évalue | « Information insuffisante », jamais « exclu » |
| ENG-12 | recherche amont | on remonte depuis C | B-017 vient de M puis de A ; provenance antérieure signalée comme non enregistrée |
| ENG-13 | recherche aval | on descend depuis M | D est atteint via B-031 |
| ENG-14 | un animal X va de C à M puis revient à C (cycle) | on analyse | le calcul se termine, chaque couple animal/lieu n'est exploré qu'une fois |
| ENG-15 | le même mouvement enregistré deux fois | on analyse | un seul résultat ; doublon signalé |
| ENG-16 | `maxDepth = 1` | on analyse | R4 n'apparaît pas ; la limite de profondeur est indiquée dans les limites |
| ENG-17 | `maxResults = 3` | on analyse | 3 résultats, indicateur « résultats tronqués » présent |
| ENG-18 | rév. 2 de P6 (11:00–15:00) | on relance | R6 devient « Lien potentiel », R8 apparaît, le reste est identique ; explication « 1 modifié, 1 ajouté » |
| ENG-19 | mêmes données et paramètres | on lance deux fois | résultats strictement identiques (ordre compris) et même `snapshotHash` |
| ENG-20 | tout résultat | — | aucun libellé ni champ n'emploie « infecté », « contaminé », « contact avéré » ou « transmission » |
| ENG-21 | analyse 1 enregistrée, puis correction | on relit l'analyse 1 | elle affiche toujours R6 « Information insuffisante » à partir de son instantané |

## 2. Synchronisation

| ID | Scénario | Attendu |
|---|---|---|
| SYN-01 | Saisir une observation hors connexion, fermer l'onglet, rouvrir | brouillon intact, état « À transmettre » |
| SYN-02 | Envoi avec serveur injoignable | état « Échec », message visible, bouton « Réessayer », compteur de tentatives incrémenté |
| SYN-03 | Relance après échec | état « Reçu » seulement après réponse serveur valide |
| SYN-04 | Double clic / double envoi de la même opération | une seule ligne en base (clé d'idempotence, contrainte unique) |
| SYN-05 | Serveur enregistre puis la réponse se perd ; le client renvoie | le serveur renvoie le résultat existant, aucun doublon |
| SYN-06 | Correction basée sur la rév. 1 alors que la rév. 2 existe | conflit signalé, aucune écrasement, les deux versions conservées |
| SYN-07 | Changement d'utilisateur / déconnexion | données locales purgées ; le second utilisateur ne voit pas l'outbox du premier |
| SYN-08 | `navigator.onLine = true` mais serveur arrêté | l'interface n'affiche pas « synchronisé » |

## 3. Sécurité (démonstration locale)

| ID | Scénario | Attendu |
|---|---|---|
| SEC-01 | Agent demande une enquête qu'il n'est pas autorisé à voir | refus côté serveur (403), écran « Accès refusé » |
| SEC-02 | Requête avec champ invalide (date incohérente, identifiant inconnu) | rejet Zod côté serveur, message lié au champ |
| SEC-03 | Recherche de secrets dans le bundle client et le dépôt | aucune clé, aucun `.env` versionné |
| SEC-04 | Route de réinitialisation appelée hors mode démo | refusée |

## 4. Interface (Playwright + vérification visuelle)

| ID | Scénario | Attendu |
|---|---|---|
| UI-01 | Parcours principal complet au clavier | toutes les actions atteignables, focus visible |
| UI-02 | Largeur 360 px | pas de défilement horizontal ; recherche, fiche, déclaration prioritaires |
| UI-03 | 1920 px (projection) | console lisible, panneau de preuves visible |
| UI-04 | Statuts | chaque statut a un libellé texte et une icône |
| UI-05 | Vue liste | toutes les informations du schéma sont accessibles sans le schéma |
| UI-06 | Sélection d'un chemin | surlignage cohérent schéma / chronologie / preuves |
| UI-07 | `prefers-reduced-motion` | aucune animation |
| UI-08 | Mention « données synthétiques » | visible sur chaque écran |

## 5. IA (seulement si activée plus tard)
Absence de fournisseur → saisie manuelle intacte ; timeout ; sortie invalide rejetée ; texte contenant une instruction traité comme donnée ; aucune proposition enregistrée sans confirmation.

## 6. Qualité
Compilation, typage strict, lint, tests unitaires et d'intégration, E2E du parcours principal. Toute vérification réalisée dans l'environnement Claude devra être **refaite sur l'ordinateur Windows** de démonstration.
