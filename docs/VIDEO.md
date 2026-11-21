# Dossier vidéo : SENTINELLE VIVANT

Référence : `docs/BRIEF_SENTINELLE_VIVANT.md`, section « Brief vidéo » et « Règles non négociables ». État du produit : `docs/STATUS.md`. Document rédigé le 21/11/2026.

## 1. Statut réel

**Statut du rendu : script seul.**

Ce qui existe aujourd'hui :

- ce document (storyboard, narration, liste des captures, prompts, instructions) ;
- le fichier de sous-titres `docs/video/sous-titres-vision.srt`.

Ce qui n'existe pas :

- aucun plan illustratif généré ;
- aucune capture d'écran filmée du parcours ;
- aucune voix de narration enregistrée ;
- aucun montage, aucun projet de montage, aucun code Remotion ;
- aucun rendu lancé, aucun fichier MP4.

Rien dans ce document n'a été testé en montage. Les durées de narration sont des estimations, à mesurer à l'enregistrement. Les trois statuts possibles sont ceux du brief : « script seul », « rendu lancé », « MP4 rendu et vérifié ». Ce statut ne change que lorsqu'un fichier existe et a été regardé en entier.

Préalable aux captures : le jeu de données vivant n'apparaît dans la base locale qu'après une réinitialisation (`pnpm demo:reset`, serveur arrêté). C'est une action destructive qui demande l'accord de Yvan (voir `docs/STATUS.md`). Tant qu'elle n'est pas faite, les scènes 3, 4 et 5 ne peuvent pas être tournées.

## 2. Les deux livrables

L'application passe avant la vidéo : sa livraison n'est jamais bloquée par ce dossier.

| Livrable | Nature | Contenu | Statut |
| --- | --- | --- | --- |
| A, preuve produit | Capture réelle, en une prise continue | Le parcours fonctionnel en 16 étapes, de l'ouverture de « Mon élevage aujourd'hui » jusqu'à la comparaison de deux états | À produire |
| B, vision terrain | Vidéo courte, environ 80 s (82 s au storyboard) | Le problème, la différence, la preuve actuelle, la vision future | À produire (script seul) |

Règle : **les scènes 3, 4 et 5 du livrable B n'utilisent que des captures du produit réel.** Aucune maquette, aucun écran redessiné, aucune réponse réécrite. Ces scènes sont des extraits de la prise du livrable A, ou de prises tournées dans les mêmes conditions.

Le livrable A ne comporte aucune coupe qui masquerait un appel en échec. Si un appel échoue pendant la prise, on recommence la prise ou on montre le repli annoncé par l'application, tel qu'il s'affiche.

## 3. Storyboard minuté

Format 16:9, lisible sur vidéoprojecteur, sous-titres français incrustés. Durée totale : 82 s.

| Scène | Temps | Image | Source de l'image | Mention à l'écran | Narration |
| --- | --- | --- | --- | --- | --- |
| 1. Le terrain | 0 à 10 s | Un éleveur dans une exploitation, observations notées sur différents supports, téléphone et carnet. | Plan illustratif généré (repli : motion design) | « Scène illustrative » | « Chaque jour, un élevage produit des informations : une arrivée, une observation, une mesure, un déplacement. » |
| 2. La question | 10 à 20 s | L'éleveur cherche une information, puis transition vers le produit. | Plan illustratif généré, puis transition en motion design (repli : motion design seul) | « Scène illustrative » | « Mais retrouver ce qui a changé et savoir d'où vient une réponse reste une question essentielle. » |
| 3. Le produit réel | 20 à 38 s | Question « Qu'est-ce qui a changé depuis hier ? », appel aux données, réponse, sources, sélection correspondante dans la constellation. | Capture réelle | « Capture réelle du démonstrateur, données synthétiques » | « Sentinelle Vivant relie la conversation aux données enregistrées de l'exploitation. » |
| 4. La boucle vivante | 38 à 58 s | Préparation d'une observation, confirmation, reçu du serveur, apparition de l'événement, nouvelle question, réponse actualisée. | Capture réelle | « Capture réelle du démonstrateur, données synthétiques » | « Une nouvelle observation est confirmée. Elle devient consultable. Et lorsque la réponse change, vous pouvez voir pourquoi. » |
| 5. La preuve et la limite | 58 à 68 s | Une source et une information manquante. | Capture réelle | « Capture réelle du démonstrateur, données synthétiques » | « Chaque réponse distingue les faits, les calculs et ce qui manque. L'assistant ne remplace ni l'observation du terrain, ni le professionnel de santé animale. » |
| 6. Le futur | 68 à 77 s | Des dispositifs, des événements et leur provenance, sans faire croire à une intégration déjà disponible. | Plan illustratif généré, libellés ajoutés en motion design (repli : motion design seul) | « Vision future, intégrations IoT » et « Illustration : non disponible aujourd'hui » | « Demain, des équipements autorisés pourront enrichir ce suivi. La même exigence restera : une donnée identifiable, une réponse explicable. » |
| 7. Signature | 77 à 82 s | Écran final : SENTINELLE VIVANT, puis « Votre élevage. Vos données. Des réponses que vous pouvez vérifier. » | Motion design (carton de texte) | « Démonstrateur, données synthétiques » | Pas de narration : la signature se lit à l'écran. |

Remarques :

- Les mentions à l'écran restent affichées pendant toute la durée de la scène, pas seulement une seconde.
- Si une scène illustrative est remplacée par du motion design, sa mention devient « Animation illustrative ».
- La mention de la scène 7 correspond au statut réel de la version montrée le 21/11 : démonstrateur local, données entièrement synthétiques.
- Les scènes 3 à 5 ne se tournent qu'une fois le parcours en 16 étapes stable sur la base réinitialisée.

## 4. Narration française

Texte exact à dire, repris du brief sans modification. La narration est une voix hors champ ajoutée au montage. Ce n'est pas une fonction du produit : le produit n'a pas de voix.

Convention de comptage : un mot élidé compte avec le mot qui le suit (« l'exploitation » compte pour un mot).

| Scène | Fenêtre | Début conseillé | Texte à dire | Mots |
| --- | --- | --- | --- | --- |
| 1 | 0 à 10 s | 0,5 s | Chaque jour, un élevage produit des informations : une arrivée, une observation, une mesure, un déplacement. | 15 |
| 2 | 10 à 20 s | 10,5 s | Mais retrouver ce qui a changé et savoir d'où vient une réponse reste une question essentielle. | 16 |
| 3 | 20 à 38 s | 21 s | Sentinelle Vivant relie la conversation aux données enregistrées de l'exploitation. | 10 |
| 4 | 38 à 58 s | 40 s, 45,5 s, 51 s (une phrase par action) | Une nouvelle observation est confirmée. Elle devient consultable. Et lorsque la réponse change, vous pouvez voir pourquoi. | 17 |
| 5 | 58 à 68 s | 58,3 s | Chaque réponse distingue les faits, les calculs et ce qui manque. L'assistant ne remplace ni l'observation du terrain, ni le professionnel de santé animale. | 24 |
| 6 | 68 à 77 s | 68,3 s | Demain, des équipements autorisés pourront enrichir ce suivi. La même exigence restera : une donnée identifiable, une réponse explicable. | 18 |
| 7 | 77 à 82 s | (aucun) | Pas de narration. | 0 |

Total : **100 mots** pour une vidéo de **82 s**.

Points d'attention :

- Scène 5 : 24 mots dans une fenêtre de 10 s. C'est la scène la plus dense. Débit régulier, sans précipitation ; si la phrase ne tient pas à l'enregistrement, ne pas la raccourcir sans accord, mais décaler de quelques dixièmes le début de la scène 6.
- Scènes 3 et 4 : peu de mots pour beaucoup d'images. Les silences sont voulus, ils laissent lire l'écran.
- Scène 4 : chaque phrase se dit au moment où l'action correspondante est visible (confirmation, apparition, comparaison).
- Scène 7 : silence ou fin de musique. Aucun sous-titre parlé : le fichier SRT s'arrête à la fin de la scène 6.
- Durées de parole non mesurées. À chronométrer à l'enregistrement, puis recaler les sous-titres si l'écart dépasse une demi-seconde.

## 5. Captures réelles à tourner (scènes 3, 4 et 5)

### Conditions de tournage

- Format 16:9. Zone de page capturée : 1366 px de large (1366 x 768), zoom du navigateur à 110 %. C'est la référence de projection du brief.
- Application lancée en local (`pnpm demo`, http://localhost:3000), base réinitialisée avec l'accord de Yvan.
- Une prise continue pour le livrable A. Les extraits du livrable B sont tirés de cette prise.
- Mode de l'assistant : celui qui fonctionne réellement au moment de la prise. La ligne d'état sous « Parler à mon élevage » (« Assistant IA connecté : … » ou « Assistant IA non configuré. ») doit rester lisible, et correspondre à ce qui a servi. Une lecture directe sans IA n'est jamais présentée comme un appel IA.
- Le bandeau « Démonstrateur · données entièrement synthétiques » reste visible dans chaque extrait.
- Avant de filmer : fermer les autres onglets, masquer la barre de favoris et les notifications, ne jamais montrer un terminal, le fichier `.env` ou une clé.
- Les attentes peuvent être raccourcies au montage du livrable B, jamais pour cacher un échec. Si elles le sont, voir la question ouverte en section 10.
- Les chiffres cités ci-dessous (5 puis 6 enregistrements) sont ceux que vérifie `apps/web/e2e/vivant.spec.ts` sur le jeu fraîchement réinitialisé, en lecture directe. Ils sont à constater à l'écran, pas à retoucher.

### Liste des captures

| N° | Scène | Écran | Action exacte dans l'application | Durée à l'écran | Doit être lisible |
| --- | --- | --- | --- | --- | --- |
| C3-1 | 3 | « Mon élevage aujourd'hui », à l'ouverture | Ouvrir l'application. Ne rien toucher pendant trois secondes. | 3 s | Le titre « Mon élevage aujourd'hui », les quatre cases du registre (« Enregistré », « Depuis hier », « À compléter », « Synchronisation »), le titre « Constellation de l'exploitation », le bandeau de démonstration |
| C3-2 | 3 | Zone « Parler à mon élevage » | Saisir « Qu'est-ce qui a changé depuis hier ? » puis cliquer sur « Demander ». Attendre la réponse complète. | 7 s | La question, l'état de lecture des données, puis la réponse avec les libellés « Fait enregistré » et « Résultat calculé » et les sources cliquables |
| C3-3 | 3 | Constellation et chronologie « Reçu depuis hier » | Aucune action : laisser l'écran après la réponse. Passer le pointeur sur une source sans cliquer. | 4 s | La ligne « … sources mises en évidence dans la constellation et la chronologie », les éléments mis en évidence |
| C3-4 | 3 | Parcours d'un animal | Saisir « Montre-moi B-017 » (ou cliquer sur le raccourci du même nom). | 4 s | « Parcours enregistré de B-017 », « B-017, tout ce qui est enregistré », le parcours numéroté, le reste estompé |
| C4-1 | 4 | Brouillon d'observation | Saisir « Ajoute une observation sur B-017 : mange moins depuis ce matin » puis « Demander ». | 5 s | « Brouillon · non enregistré », « Vérifiez, puis confirmez », les champs « Animal », « Lieu de l'observation », « Ce qui est constaté », les statuts « Proposé, à vérifier » et « À confirmer » |
| C4-2 | 4 | Brouillon d'observation | Cliquer sur « Confirmer et enregistrer ». | 2 s | Le bouton, le pointeur au moment du clic |
| C4-3 | 4 | Reçu | Aucune action : laisser le reçu s'afficher. | 3 s | « Reçu par le serveur », « Observation enregistrée, reçue le … » avec la date et l'heure |
| C4-4 | 4 | Chronologie de B-017 | Aucune action : laisser l'événement apparaître. | 3 s | La nouvelle ligne en tête de chronologie, « nouveau, confirmé pendant cette session » |
| C4-5 | 4 | Zone « Parler à mon élevage » | Cliquer sur « Reposer : qu'est-ce qui a changé depuis hier ? ». | 4 s | « Réponse mise à jour », la ligne de l'état précédent et la ligne « Maintenant : … » |
| C4-6 | 4 | Zone « Parler à mon élevage » | Cliquer sur « Pourquoi ta réponse a changé ? ». | 3 s | « Comparaison de deux états enregistrés », les deux heures et les deux résumés, l'observation ajoutée |
| C5-1 | 5 | Fenêtre « Source · enregistrement exact » | Dans une réponse, cliquer sur une source de type « Observation … ». Laisser lire, puis « Fermer ». | 5 s | « Source · enregistrement exact », les trois dates : « Date de l'événement », « Saisie sur l'appareil », « Réception par le serveur » |
| C5-2 | 5 | Zone « Parler à mon élevage » | Cliquer sur le raccourci « Quelles informations manquent ? ». | 5 s | Le libellé « Donnée absente » et au moins une ligne de réponse complète, la ligne « Limites de cette lecture » |

Totaux : scène 3, 18 s ; scène 4, 20 s ; scène 5, 10 s.

La scène 4 enchaîne six actions en 20 s. Si un extrait devient illisible à cette vitesse, la priorité de lecture est : le brouillon, le reçu, « Réponse mise à jour », la comparaison.

Durée de la prise continue du livrable A : non mesurée. Elle dépend du temps de réponse du fournisseur IA (1 à 6 s par appel relevés le 21/11 avec le modèle retenu, voir `docs/STATUS.md`).

## 6. Prompts des plans illustratifs (scènes 1, 2 et 6)

Aucun de ces plans n'a été généré. Aucun service de génération n'a été choisi ni appelé. Toute génération payante demande l'accord préalable de Yvan.

### Fiche de continuité (à recopier dans chaque prompt)

> **Personnage.** Un éleveur ivoirien d'une quarantaine d'années, silhouette mince, cheveux courts. Chemise à manches courtes bleu délavé, unie. Pantalon de travail sombre, bottes en caoutchouc noires, casquette beige sans inscription. Il tient un carnet à couverture verte cartonnée et un téléphone simple dans un étui noir. Même visage, mêmes vêtements et mêmes objets dans tous les plans.
>
> **Lieu.** Une petite exploitation bovine en zone de savane, dans le nord de la Côte d'Ivoire. Un enclos en bois et fil de fer, un abri au toit de tôle, un sol de terre rouge, un manguier à l'arrière-plan. Quelques bovins de petit gabarit, à robe fauve ou pie, calmes, en bon état apparent. Même enclos et même abri dans tous les plans.
>
> **Lumière.** Début de matinée, soleil bas, lumière chaude et douce, ciel dégagé légèrement voilé. Pas de contre-jour marqué, pas d'effet dramatique.

### Exclusions (à recopier dans chaque prompt)

> Aucun texte lisible à l'image, aucune interface d'écran, aucun sous-titre : l'écran du téléphone n'est jamais lisible. Aucun logo, aucune marque, aucun uniforme officiel. Aucun geste de soin, aucune injection, aucune contention, aucun animal malade, blessé ou amaigri. Personne ne touche un animal de façon risquée, personne ne se place derrière un animal. Pas de drone, pas d'hologramme, pas d'écran lumineux flottant, pas de robot. Pas de foule, pas de costume folklorique, pas de mise en scène misérabiliste. Rendu réaliste de type documentaire, sans filtre spectaculaire.

### Plan 1A (scène 1, de 0 à 5 s)

> Durée : 5 secondes. Format 16:9. Plan large fixe, caméra à hauteur d'homme, très léger travelling avant.
> [Coller la fiche de continuité.]
> Action : l'éleveur marche lentement le long de l'enclos, à l'extérieur de la clôture, et regarde ses animaux. Il s'arrête et ouvre son carnet. Les bovins sont calmes, certains mangent.
> [Coller les exclusions.]

### Plan 1B (scène 1, de 5 à 10 s)

> Durée : 5 secondes. Format 16:9. Plan rapproché sur les mains et le buste, caméra fixe, faible profondeur de champ.
> [Coller la fiche de continuité.]
> Action : l'éleveur, debout près du poteau de l'abri, écrit une ligne dans son carnet vert. Son téléphone dépasse de la poche de sa chemise. L'enclos et les animaux restent flous à l'arrière-plan. L'écriture du carnet n'est pas lisible.
> [Coller les exclusions.]

### Plan 2 (scène 2, de 10 à 17 s)

> Durée : 7 secondes. Format 16:9. Plan moyen, caméra fixe, à hauteur de poitrine.
> [Coller la fiche de continuité.]
> Action : l'éleveur, à l'ombre de l'abri, feuillette son carnet en arrière, page après page, puis regarde son téléphone qu'il tient dans l'autre main. Il cherche une information et ne la trouve pas tout de suite. Expression concentrée, sans détresse. L'écran du téléphone est tourné vers lui, on ne le voit pas.
> [Coller les exclusions.]

Les trois dernières secondes de la scène 2 (17 à 20 s) sont une transition en motion design vers la capture du produit. Elles ne sont pas générées.

### Plan 6 (scène 6, de 68 à 77 s)

> Durée : 9 secondes. Format 16:9. Plan large fixe, caméra à hauteur d'homme, lent panoramique de gauche à droite.
> [Coller la fiche de continuité.]
> Action : le même enclos, le même abri, à la même heure. Les bovins portent une boucle d'identification ordinaire à l'oreille. Dans le couloir de l'enclos, une bascule de pesée simple, en métal, sans écran visible. Sur un poteau de l'abri, un petit boîtier gris, sobre, sans voyant ni écran. L'éleveur se tient à l'extérieur de la clôture, son carnet sous le bras, et observe. Personne ne manipule les animaux.
> [Coller les exclusions.]

Les libellés de provenance de la scène 6 (par exemple « Source », « Identifiant du dispositif », « Instant observé », « Instant reçu ») sont ajoutés au montage, sans valeur chiffrée, avec les mentions « Vision future, intégrations IoT » et « Illustration : non disponible aujourd'hui ». Aucune mesure fictive n'est affichée.

À faire relire par Yvan ou par une personne du terrain avant toute génération : la crédibilité du lieu, du type de bovins et des équipements décrits.

## 7. Médias nécessaires

| Média | Usage | Statut | Licence et points à vérifier |
| --- | --- | --- | --- |
| Capture continue du parcours en 16 étapes | Livrable A | À produire | Produit de l'équipe. Vérifier qu'aucune clé, aucun nom réel et aucune donnée personnelle n'apparaît à l'image. |
| Extraits C3-1 à C5-2 | Scènes 3, 4, 5 | À produire | Mêmes vérifications. Tirés de la prise ci-dessus. |
| Plans illustratifs 1A, 1B, 2, 6 | Scènes 1, 2, 6 | À produire (aucun généré) | Conditions d'utilisation du générateur retenu : à vérifier (droits d'usage, diffusion en concours, mention exigée). Coût : aucune génération payante sans accord de Yvan. |
| Motion design : transition de la scène 2, libellés de la scène 6, carton de la scène 7, repli des scènes 1, 2, 6 | Scènes 2, 6, 7 et repli | À produire | Création originale de l'équipe. Licence du logiciel utilisé : à vérifier. |
| Mentions à l'écran (texte) | Toutes les scènes | À produire | Texte de l'équipe, composé au montage. |
| Voix de narration | Scènes 1 à 6 | À produire | Voix d'un membre de l'équipe avec son accord, ou synthèse vocale : licence et coût à vérifier, accord de Yvan si le service est payant. |
| Musique | Facultative, discrète | À produire ou à choisir | Licence à vérifier. Par défaut : pas de musique. |
| Police Fraunces | Titres, signature, mentions | Existe (police de titrage du produit) | Licence OFL 1.1. |
| Police de texte courant pour les sous-titres | Sous-titres incrustés | À choisir | Licence à vérifier. Fraunces peut servir à défaut. |
| Sous-titres `docs/video/sous-titres-vision.srt` | Scènes 1 à 6 | Existe | Texte de l'équipe, issu du brief. |
| Logo | Scène 7 | Aucun fichier de logo repéré dans `docs/` | La signature est composée en texte. Aucun logo tiers. |
| Outil de capture d'écran | Captures | À choisir | Licence à vérifier. |
| Outil de montage ou de rendu | Montage | À choisir | Licence à vérifier (voir section 8). |

## 8. Instructions de montage et de rendu

Les deux voies ci-dessous sont des modes opératoires proposés. Aucune n'a été exécutée ni testée.

### Voie A : montage manuel dans un logiciel de montage

1. Créer un projet 16:9, cadence unique alignée sur celle des captures, durée 82 s. La définition de sortie reste à trancher (section 10).
2. Poser un repère à chaque limite de scène : 0, 10, 20, 38, 58, 68, 77 et 82 s.
3. Ordre des pistes, de bas en haut :
   - V1 : images (plans illustratifs ou motion design, captures réelles, carton final) ;
   - V2 : mentions à l'écran, en haut à gauche, affichées pendant toute la scène ;
   - V3 : sous-titres incrustés, en bas au centre ;
   - A1 : narration ;
   - A2 : musique facultative, nettement sous la narration, coupée ou très basse pendant les scènes 3 à 5.
4. Durées par scène : 10, 10, 18, 20, 10, 9 et 5 s. Les extraits de capture suivent les durées de la section 5.
5. Transitions : coupes franches ou fondus courts. Pas d'effet sur les captures (ni zoom qui masque le bandeau de démonstration, ni recadrage qui retire une source ou une limite).
6. Sous-titres : importer `docs/video/sous-titres-vision.srt`, les incruster dans l'image (lisibles sans lecteur compatible), deux lignes au plus, taille lisible sur vidéoprojecteur, fond ou contour assurant le contraste. Vérifier qu'ils ne recouvrent ni une mention, ni un texte utile de la capture.
7. Scène 7 : « SENTINELLE VIVANT » en Fraunces, puis la phrase de signature, puis la mention « Démonstrateur, données synthétiques ». Pas de sous-titre.
8. Exporter en MP4. Les réglages d'export sont à aligner sur les exigences du concours, qui ne sont pas connues à ce jour.
9. Vérifier le fichier rendu en le regardant en entier : durée, synchronisation des sous-titres, présence des mentions sur chaque scène, lisibilité à la taille d'un vidéoprojecteur, absence de clé ou de donnée personnelle. Seulement après : passer le statut à « MP4 rendu et vérifié » dans ce document et dans `docs/STATUS.md`.

### Voie B : montage programmable (Remotion)

**Remotion n'est pas installé dans ce dépôt et n'a pas été testé.** Aucun fichier de composition n'existe. C'est une possibilité, pas un acquis.

À vérifier avant d'engager du temps :

- la licence de Remotion pour un usage en équipe : à vérifier sur le site de l'éditeur, avant toute installation ;
- les dépendances : compatibilité avec la version de Node du poste, navigateur nécessaire au rendu (sur ce projet, le téléchargement d'un navigateur a déjà posé problème pour les tests, d'où l'usage de Chrome installé), outils d'encodage requis ;
- l'isolation : installer dans un dossier séparé, sans modifier les dépendances de l'application ni son fichier de verrouillage, avec l'accord de Yvan ;
- le temps : installation, écriture des sept séquences, premier rendu et vérification, à comparer au temps restant avant la fin du hackathon.

Si la voie est retenue, le découpage serait le suivant à 30 images par seconde : scènes commençant aux images 0, 300, 600, 1140, 1740, 2040 et 2310, fin à l'image 2460. Les captures et les plans sont des fichiers importés, les mentions, les sous-titres et la signature sont des calques de texte. Tant qu'aucun rendu n'a abouti, le statut reste « script seul ».

### Plan de repli si les plans générés manquent

Motion design original et captures du produit :

- Scènes 1 et 2 : animation sobre dans la palette du produit (fond ivoire, vert profond), avec quatre pictogrammes dessinés par l'équipe pour « une arrivée », « une observation », « une mesure », « un déplacement », puis une page de carnet et une question. Mention : « Animation illustrative ».
- Scène 6 : schéma animé, des dispositifs vers des événements portant leur provenance (source, identifiant du dispositif, instant observé, instant reçu, unité, qualité), sans valeur chiffrée. Mentions inchangées : « Vision future, intégrations IoT » et « Illustration : non disponible aujourd'hui ».
- Scènes 3, 4, 5 et 7 : inchangées.

Si le temps manque : livrer d'abord le livrable A complet, puis un motion design propre. La vision illustrée ne remplace pas la preuve.

## 9. Ce qu'il ne faut pas faire

- Pas de faux témoignage : aucun éleveur, vétérinaire ou responsable ne « parle » du produit.
- Pas de partenariat inventé : aucun acteur, lieu, organisme ou marque présenté comme partenaire.
- Pas de montage cachant un appel qui échoue, pas de réponse réécrite, pas de capture retouchée.
- Pas de maquette présentée comme une application opérationnelle.
- Aucune génération payante sans accord de Yvan.
- Ne pas montrer ni suggérer ce qui n'existe pas : voix, capteurs ou objets connectés en service, lots de volailles, recherche documentaire, application mobile native.
- Ne pas présenter la scène 6 comme une fonction disponible : ses mentions restent à l'écran pendant toute la scène.
- Ne pas retirer le bandeau « Démonstrateur · données entièrement synthétiques » des captures.
- Ne pas demander à un générateur de créer des textes d'interface, ni utiliser un logo réel.
- Ne montrer ni diagnostic visuel, ni geste dangereux avec les animaux.
- Ne jamais afficher une clé, un terminal ou un fichier de configuration.
- Ne pas annoncer un rendu ou un MP4 qui n'existe pas : le statut en tête de ce document fait foi.

## 10. Points ouverts

- Accord de Yvan pour réinitialiser la base de démonstration (préalable aux captures).
- Choix de la voie de montage (A ou B) et de l'outil, licences à vérifier.
- Choix d'un générateur pour les plans 1A, 1B, 2 et 6, ou passage direct au plan de repli.
- Voix de narration : qui la dit, ou quelle synthèse, à quel coût.
- Définition de sortie : 1366 x 768 (taille native des captures) ou agrandissement vers 1920 x 1080 (léger flou possible, à juger sur vidéoprojecteur).
- Attentes raccourcies dans les scènes 3 à 5 du livrable B : ajouter ou non la précision « attentes raccourcies » à la mention de capture.
- Exigences du concours pour la vidéo (durée, format, dépôt) : non connues à ce jour.
- Mise à jour de `docs/STATUS.md`, qui indique encore « Vidéo : rien de produit » : à faire par la personne qui tient ce fichier.
