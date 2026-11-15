# Produit — Sentinelle

Nom de travail (disponibilité juridique et commerciale non vérifiée).
Signature : « Du signalement à l'enquête, chaque mouvement compte. »

## Promesse
Retrouver les mouvements à vérifier, comprendre pourquoi, et savoir ce que les données ne permettent pas de conclure.

Sentinelle aide un professionnel habilité à relier un signalement sanitaire aux mouvements enregistrés d'un animal, à examiner des liens potentiels selon des hypothèses explicites, et à identifier les informations manquantes.

## Ce que Sentinelle n'est pas
Ni outil de diagnostic, ni prescripteur, ni moteur de prédiction d'épidémie, ni certification sanitaire, ni autorité de restriction des déplacements, ni registre national. Aucune connexion au MIRAH ni à un partenaire n'est établie.
Les principes du contact tracing ne sont pas une invention de Sentinelle. La différenciation proposée tient au **parcours** : terrain → enquête temporelle → preuves → données manquantes → correction → comparaison des analyses.

## Périmètre du démonstrateur
- Une espèce (bovins), 5 lieux fictifs, identifiants de démonstration.
- Données **entièrement synthétiques**, mention visible à l'écran.
- Français uniquement.
- Démontrable sur **un seul ordinateur** (Windows). Le second appareil est un bonus.

## Utilisateurs (mode démonstration : sélecteur de rôle, sans authentification sécurisée)

**Agent** — consulte les animaux et lieux autorisés, enregistre une observation, la conserve hors connexion, synchronise, complète une information dans son périmètre.

**Vétérinaire / enquêteur** — examine un signalement, ouvre une enquête, choisit la fenêtre temporelle et la règle, examine les résultats et leurs preuves, demande une vérification, compare deux analyses.

## Parcours principal (P0)
1. Ouvrir la fiche de B-017 (recherche manuelle ; le QR, en bonus, n'est qu'un raccourci et ne prouve pas l'identité physique).
2. Enregistrer une observation hors connexion.
3. Fermer et rouvrir l'application sans perdre la saisie.
4. Retrouver la connexion et synchroniser (bouton explicite, réponse serveur vérifiée).
5. Examiner le signalement (enquêteur).
6. Ouvrir une enquête.
7. Voir le parcours et les résultats expliqués.
8. Voir une information manquante (B-052).
9. Corriger cette donnée (agent).
10. Relancer l'analyse et voir l'explication du changement.

## Priorités
- **P0** : voir ci-dessus + données réinitialisables, synchronisation sans doublons, états vides/erreur, tests critiques, script de démo.
- **P1** (si P0 stable) : comparaison visuelle enrichie, import CSV, rapport imprimable, saisie assistée par IA (interface prévue, aucun fournisseur payant), scan QR.
- **P2** (après le hackathon) : dictée vocale, langues, intégrations autorisées, notifications, règles validées, production.

## Exclusions
Marketplace, paiement, crédit, assurance, blockchain, antivol, vision diagnostique, microservices, agents LLM permanents, entraînement de modèle, lecteur RFID, score numérique de contamination, déploiement public.

## Valeur à tester en pilote (hypothèses, non mesurées)
Client initial à tester : organisation gérant plusieurs agents ou sites. Indicateurs proposés : réussite des tâches, temps pour retrouver un parcours, proportion de données complétées, compréhension des résultats, charge de saisie, intérêt à payer.
