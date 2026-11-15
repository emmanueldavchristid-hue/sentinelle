# Domaine — règles temporelles, hypothèses et scénario de référence

> Toutes les données de ce document sont **synthétiques**. Aucun animal, lieu
> ou événement réel. Les règles marquées **[à valider]** sont des règles de
> démonstration : elles n'ont fait l'objet d'aucune validation vétérinaire.

## 1. Deux niveaux d'analyse, strictement séparés

| Niveau | Question | Nature |
|---|---|---|
| **A — Traçabilité du même animal** | Où cet identifiant a-t-il été enregistré, dans quel ordre ? | Faits enregistrés (avec leur précision et leur provenance). Noyau obligatoire. |
| **B — Liens potentiels** | Quels autres animaux ont une présence enregistrée qui *chevauche* celle de l'animal signalé, selon une règle configurée ? | Hypothèse calculée. Jamais une preuve de contact ni de transmission. |
| **C — Conclusions impossibles** | Qu'est-ce que les données ne permettent pas de trancher ? | Information insuffisante, anomalie de données, hors périmètre. |

Principes affichés dans l'interface :
- un passage dans le même marché n'est pas une preuve de contact ;
- un chevauchement de présence n'est pas une preuve de transmission ;
- l'absence de mouvement enregistré ne prouve pas l'absence de contact ;
- « exclu par cette recherche » ne signifie jamais « sans risque sanitaire ».

## 2. Représentation du temps

### 2.1 Valeur temporelle (`TemporalValue`)

| Précision | Champs | Bornes utilisées par le moteur |
|---|---|---|
| `INSTANT` | `at` (instant UTC) | `[at, at]` |
| `DAY` | `date` (AAAA-MM-JJ, jour civil Africa/Abidjan) | `[jour 00:00, jour+1 00:00)` — l'heure est **inconnue**, jamais minuit par défaut |
| `INTERVAL` | `from`, `to` (instants UTC) | `[from, to]` — l'événement a eu lieu quelque part dans cet intervalle |
| `UNKNOWN` | — | `(-∞, +∞)` |

- **Stockage** : instants en UTC (ISO 8601, `Z`). Jours civils stockés comme date sans heure.
- **Affichage** : fuseau `Africa/Abidjan` (UTC+0, sans heure d'été — l'affichage passe tout de même par le fuseau nommé, pas par un décalage codé en dur).
- **Heure de l'événement ≠ heure de saisie** : chaque enregistrement porte `eventTime` (TemporalValue) et `recordedAt` (instant serveur ou client). Une observation saisie hors connexion garde l'heure de saisie du client et reçoit une heure de réception serveur.

### 2.2 Intervalle de présence

Une présence d'un animal dans un lieu = un début et une fin, chacun étant une `TemporalValue`.
Le moteur en déduit quatre bornes : `startMin`, `startMax`, `endMin`, `endMax`.

Exemple : présence « le 01/03, heures inconnues » → début ∈ [01/03 00:00, 02/03 00:00), fin ∈ [01/03 00:00, 02/03 00:00).

### 2.3 Règle de chevauchement R-B1 [à valider]

Deux présences P et Q **dans le même lieu** sont comparées sur des intervalles **semi-ouverts** `[début, fin)` :

- **Chevauchement certain** si `max(P.startMax, Q.startMax) < min(P.endMin, Q.endMin)`
  → statut `POTENTIAL_LINK` (lien potentiel selon les paramètres).
- **Absence de chevauchement certaine** si `P.endMax ≤ Q.startMin` ou `Q.endMax ≤ P.startMin`
  → statut `PATH_EXCLUDED` (chemin exclu par cette recherche).
- **Sinon** → statut `INSUFFICIENT_INFO`.

Comportement aux limites (documenté, testé) :
- fin de P **égale** au début de Q → pas de chevauchement (intervalles contigus) ;
- aucune durée minimale de chevauchement n'est exigée (paramètre `minOverlapMinutes = 0`, à valider) ;
- aucune fenêtre d'incubation n'est codée. La **fenêtre d'enquête** est choisie par l'enquêteur et apparaît dans les paramètres de chaque analyse ;
- le temps de transport (entre départ et arrivée) n'est rattaché à aucun lieu : les contacts pendant le transport ne sont pas modélisés (limite affichée).

### 2.4 Anomalie de données

Un enregistrement est en **anomalie** (`DATA_ANOMALY`) s'il est incohérent en lui-même : arrivée antérieure au départ, présences du même animal dans deux lieux qui se chevauchent avec certitude, identifiant inconnu. Un enregistrement en anomalie **n'est pas utilisé** pour établir ni exclure un lien ; il produit une tâche de vérification. Une anomalie de données n'est pas un signal sanitaire.

## 3. Statuts de résultat

| Code | Libellé affiché | Signification |
|---|---|---|
| `MOVEMENT_RECORDED` | Mouvement enregistré | Niveau A : mouvement de l'animal signalé, tel qu'enregistré |
| `POTENTIAL_LINK` | Lien potentiel selon les paramètres | Niveau B : chevauchement certain selon R-B1 |
| `INSUFFICIENT_INFO` | Information insuffisante | La précision des données ne permet ni d'établir ni d'exclure |
| `PATH_EXCLUDED` | Chemin exclu par cette recherche | Absence de chevauchement certaine selon R-B1 et les paramètres |
| `DATA_ANOMALY` | Anomalie de données | Enregistrement incohérent, non exploité |

Chaque statut s'affiche avec un libellé texte et une icône, jamais par la couleur seule.

## 4. Moteur — contrat

Entrée : instantané des données + paramètres. Sortie : liste de résultats.

Paramètres d'une analyse : `subjectAnimalId`, `window` `[from, to)`, `rules` (ici `R-B1`), `maxDepth` (défaut 2), `maxResults` (défaut 200), `minOverlapMinutes` (0).

Chaque résultat contient : `status`, `depth`, `path` (suite d'étapes animal/lieu), `evidence` (identifiants et révisions des enregistrements justificatifs), `rulesApplied`, `explanation` (texte déterministe), `limits`.
Chaque analyse contient : `engineVersion`, `parameters`, `dataSnapshot`, `snapshotHash`, `createdAt`, `createdBy`.

Propriétés : déterministe (tri stable par instant puis identifiant), sans LLM, sans accès réseau, gestion des cycles (un couple animal/lieu déjà visité n'est pas réexploré), profondeur maximale, plafond de volume (dépassement signalé, jamais tronqué silencieusement), déduplication par clé `(status, path)`.

Profondeur : 0 = parcours de l'animal signalé ; 1 = autres animaux en présence chevauchante ; 2 = lieux où ces animaux ont ensuite été enregistrés (« lieux à vérifier »). La démonstration s'arrête à 2.

## 5. Scénario de référence B-017

### 5.1 Lieux

| Code | Nom | Type | Remarque |
|---|---|---|---|
| A | Élevage A | élevage | origine de B-017 |
| M | Marché M | marché | |
| C | Élevage C | élevage | lieu du signalement |
| D | Élevage D | élevage | |
| E | Élevage E | élevage | à environ 1,5 km de C (coordonnées fictives), **aucun mouvement enregistré** |

### 5.2 Enregistrements (révision 1)

Toutes les heures sont en Africa/Abidjan (= UTC). Année fictive 2026.

| Réf. | Animal | Événement | Début | Fin | Précision |
|---|---|---|---|---|---|
| P1 | B-017 | présence A | inconnu (avant fenêtre) | 01/03 06:00 | début `UNKNOWN`, fin `INSTANT` |
| MV1 | B-017 | mouvement A → M | départ 01/03 06:00 | arrivée 01/03 08:00 | `INSTANT` |
| P2 | B-017 | présence M | 01/03 08:00 | 01/03 16:00 | `INSTANT` |
| MV2 | B-017 | mouvement M → C | départ 01/03 16:00 | arrivée 01/03 18:00 | `INSTANT` |
| P3 | B-017 | présence C | 01/03 18:00 | toujours présent | `INSTANT` / ouvert |
| OBS1 | B-017 | observation à C : « baisse d'appétit » | 12/03 07:30 | — | `INSTANT` |
| P4 | B-031 | présence M | 01/03 10:00 | 01/03 14:00 | `INSTANT` |
| MV3 | B-031 | mouvement M → D | départ 01/03 14:00 | arrivée 01/03 17:00 | `INSTANT` |
| P5 | B-044 | présence M | 01/03 16:30 | 01/03 17:30 | `INSTANT` |
| MV4 | B-044 | mouvement M → D | départ 01/03 17:30 | arrivée 01/03 19:00 | `INSTANT` |
| P6 | B-052 | présence M | 01/03, heure inconnue | 01/03, heure inconnue | `DAY` |
| MV5 | B-052 | mouvement M → D | départ 01/03, heure inconnue | arrivée 01/03 20:00 | `DAY` / `INSTANT` |
| MV6 | B-060 | mouvement D → M | départ 01/03 09:00 | arrivée 01/03 07:00 | `INSTANT` — **incohérent** |

Signalement : OBS1 sur B-017. Fenêtre d'enquête choisie : `[25/02 00:00, 13/03 00:00)`. Paramètres : R-B1, `maxDepth` 2, `maxResults` 200.

### 5.3 Résultats attendus — analyse n° 1 (révision 1)

**Niveau A — parcours enregistré de B-017**

| # | Statut | Contenu | Justification manuelle |
|---|---|---|---|
| R1 | Mouvement enregistré | A → M, 01/03 06:00 → 08:00 | MV1, dans la fenêtre |
| R2 | Mouvement enregistré | M → C, 01/03 16:00 → 18:00 | MV2, dans la fenêtre |

P1 a un début inconnu : on sait seulement que B-017 était à A jusqu'au 01/03 06:00. Limite affichée : « provenance antérieure à A non enregistrée ».

**Niveau B — liens potentiels (règle R-B1, à valider)**

| # | Statut | Contenu | Justification manuelle |
|---|---|---|---|
| R3 | Lien potentiel selon les paramètres | B-031 au Marché M, chevauchement 10:00–14:00 | P2 = [08:00, 16:00), P4 = [10:00, 14:00) ; max(08:00, 10:00) = 10:00 < min(16:00, 14:00) = 14:00 → chevauchement certain (4 h) |
| R4 | Lien potentiel selon les paramètres — lieu à vérifier (profondeur 2) | Élevage D, via B-031 (arrivée 01/03 17:00) | Conséquence de R3 + MV3 |

**Conclusions impossibles ou exclues**

| # | Statut | Contenu | Justification manuelle |
|---|---|---|---|
| R5 | Chemin exclu par cette recherche | B-044 au Marché M, 16:30–17:30 | P2 se termine à 16:00 ≤ début de P5 (16:30) → pas de chevauchement certain. Le passage de B-044 vers D n'est pas exploré par ce chemin. **Ne signifie pas « sans risque »** : la contamination du lieu après départ n'est pas modélisée. |
| R6 | Information insuffisante | B-052 au Marché M le 01/03, heures inconnues | P6 : début et fin ∈ [01/03 00:00, 02/03 00:00). Chevauchement certain ? max(24:00, 08:00) < min(00:00, 16:00) : non. Exclusion certaine ? 24:00 ≤ 08:00 : non ; 16:00 ≤ 00:00 : non. → indéterminé. Tâche créée : « Préciser les heures de présence de B-052 au Marché M le 01/03 ». |
| R7 | Anomalie de données | B-060, mouvement D → M : arrivée (07:00) avant départ (09:00) | Incohérence interne. Non utilisé pour établir ni exclure un lien. Tâche créée : « Vérifier les heures du mouvement de B-060 ». Distinct du signalement sanitaire. |

**Ce qui n'apparaît pas, et pourquoi**
- **Élevage E** : aucun mouvement enregistré le relie à B-017. La proximité géographique n'est pas une règle de cette recherche : E n'est **ni lié ni exclu**. Mention affichée : « Lieu proche sans mouvement enregistré — la proximité n'est pas évaluée. »
- **Élevage C** : aucun autre animal enregistré à C pendant la fenêtre. Mention : « L'absence d'enregistrement ne prouve pas l'absence d'autres animaux. »

### 5.4 Correction (révision 2)

Un agent complète P6 (tâche issue de R6) : B-052 présent au Marché M le 01/03 de **11:00 à 15:00**, précision `INSTANT`, statut de vérification « déclaré par agent ». La révision 1 de P6 est conservée.

### 5.5 Résultats attendus — analyse n° 2 (révision 2)

| # | Analyse 1 | Analyse 2 | Justification |
|---|---|---|---|
| R1, R2 | inchangés | inchangés | |
| R3, R4 | inchangés | inchangés | |
| R5 | exclu | exclu | inchangé |
| R6 | Information insuffisante | **Lien potentiel selon les paramètres** | P6 rév. 2 = [11:00, 15:00) ; max(08:00, 11:00) = 11:00 < min(16:00, 15:00) = 15:00 → chevauchement certain (4 h) |
| R8 | — | **Nouveau** : Élevage D, lieu à vérifier via B-052 (arrivée 01/03 20:00) | Conséquence de R6 rév. 2 + MV5 |
| R7 | anomalie | anomalie | non corrigée |

Explication de changement attendue (déterministe) : « 1 résultat modifié, 1 ajouté. Cause : révision 2 de la présence de B-052 au Marché M (heures précisées par un agent, non vérifiées). »

L'analyse n° 1 reste consultable telle quelle : elle est relue à partir de son propre instantané de données (voir DECISIONS.md, D-03).

### 5.6 Hypothèses métier à faire valider
1. R-B1 (chevauchement de présence dans un même lieu) comme critère de *lien potentiel*.
2. Aucune durée minimale de chevauchement.
3. Intervalles semi-ouverts : présences contiguës non chevauchantes.
4. Profondeur 2 suffisante pour une première vérification.
5. Pas de modélisation de la contamination du lieu après départ ni du transport.
6. La fenêtre d'enquête est un choix de l'enquêteur, pas une durée sanitaire.

## 6. Jeu volumineux (performance uniquement)
Après le moteur : générateur à graine fixe (ex. 2 000 animaux, 20 lieux, 30 jours). Sert uniquement à mesurer le temps de calcul et le respect des plafonds. **Aucun réalisme épidémiologique revendiqué** ; jamais utilisé comme oracle.
