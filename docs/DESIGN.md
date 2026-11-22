# Design — console d’enquête

Direction : outil professionnel calme. Fond ivoire, texte ardoise, vert pétrole pour les actions, ambre pour les informations à compléter, rouge réservé aux anomalies, bleu pour les liens et la sélection. Tokens dans `apps/web/src/styles.css`.

## Contrastes mesurés (formule WCAG 2.x, calcul local du 15/11)
| Paire | Rapport |
|---|---|
| texte ardoise / fond ivoire | 13,90:1 |
| texte secondaire / blanc | 6,46:1 |
| texte atténué / blanc | 4,63:1 |
| blanc / vert pétrole (boutons) | 7,47:1 |
| statut « mouvement » | 6,39:1 |
| statut « information insuffisante » | 6,30:1 |
| statut « anomalie » | 6,32:1 |
| statut « lien potentiel » | 6,84:1 |
| statut « exclu » | 6,47:1 |

Toutes ≥ 4,5:1 pour le texte. Ce n’est **pas** un audit WCAG complet.

## Principes appliqués
- Statuts : icône + libellé texte (→ ≈ ? ∅ !), jamais la couleur seule ; traits différenciés (plein, tirets, pointillés) sur le schéma.
- Schéma SVG + liste équivalente ; sur mobile (< 640 px), seule la liste est affichée.
- Cibles des actions principales : 44 px minimum ; focus visible (contour bleu 3 px).
- Animations : surlignage du changement après relance ; aucune animation simulant un calcul ; `prefers-reduced-motion` respecté.
- Mention « données synthétiques » et « mode démonstration » sur chaque écran.

# Design : SENTINELLE VIVANT (21/11)

Écran « Mon élevage aujourd'hui ». Les écrans existants gardent leurs tokens ; les nouveaux styles sont préfixés `.v-` dans `apps/web/src/styles.css`.

## Direction
- **Référence** : un registre d'élevage (papier ivoire, filets, chiffres en sérif) et, seul panneau sombre de l'application, une carte de constellation vert nuit.
- **Typographie** : Fraunces (titres et chiffres, licence OFL 1.1, servie en local par `@fontsource-variable/fraunces`, aucun appel externe) ; texte en pile système. Corps de l'écran : 16 px ; aucun texte utile sous 12,5 px ; libellés du schéma de 12 px rendus ou plus à 1366 px.
- **Palette nommée par le sujet** : ivoire du registre `#f5f0e3`, papier `#fffdf8`, encre `#1c2421`, filet `#d8d0bc`, vert nuit `#0e2b27` (constellation), vert pâturage `#1c5a48` (actions), ocre latérite `#9a4f12` sur clair et lueur `#f2b24a` sur fond nuit (un seul accent : ce qui est nouveau ou sélectionné).
- **Mise en page** : axe gauche tenu, deux colonnes 7/5 (représentation à gauche, conversation à droite), pas de titre centré. La situation tient en une ligne de registre réglée, pas en quatre cartes. Rayons par rôle : 3 à 4 px pour les blocs, 6 px pour la saisie, 999 px pour les pastilles.

## Règles tenues
- Cinq natures d'information, toujours par un libellé et un signe, jamais par la seule couleur : ■ fait enregistré, ∑ résultat calculé, ¶ contenu documentaire, ∅ donnée absente, → suggestion. Le filet de gauche change aussi de style (plein, double, tirets, pointillés).
- Constellation : un trait est un déplacement enregistré ; le chiffre dans un site est le nombre d'animaux avec une présence ouverte ; la seule pulsation signale un enregistrement que l'utilisateur vient de confirmer. Aucune animation ne suggère un capteur. Vue « Liste » équivalente, seule vue sous 640 px.
- Trois dates toujours distinguées : date de l'événement, saisie sur l'appareil, réception par le serveur.
- États : chargement (squelettes à la forme du contenu), vide (dit sans conclure sur l'état des animaux), erreur avec « Réessayer », hors connexion (données locales datées), données anciennes.
- `prefers-reduced-motion` respecté ; focus visible ; cibles de 44 px pour les actions principales.
- Contrastes des nouvelles paires : non mesurés à ce jour (à faire avec la même méthode que le tableau ci-dessus).

## Passe de finition du 22/11 (demande de Yvan : « retouche à tout »)
La direction ne change pas (registre d'élevage, un seul panneau sombre, un seul accent). La passe porte sur ce qui s'en écartait.
- **Un seul geste fort : le chiffre.** Les chiffres du registre passent de 40 px à 48–76 px (Fraunces, interlettrage resserré). C'est le seul très grand corps avec le titre de l'écran et la distance d'un incident. « Nouveautés depuis hier » prend l'ocre latérite, dont le seul sens reste « ce qui est nouveau ».
- **En-tête** : titre en 36–64 px, puis une ligne d'état des données lue sur le serveur (dernier enregistrement reçu, heure de lecture, ou « hors connexion »). Elle rend visible en affichage simple ce qui n'apparaissait qu'en affichage détaillé.
- **Incident** : bandeau en deux colonnes, la distance mesurée en grand à gauche (c'est le fait), la phrase et les actions à droite ; « Comprendre avec Sentinelle » est le seul bouton plein. Trois tons, jamais portés par la seule couleur (libellé, signe, style du filet) : hors zone (rouge, filet plein), incident ouvert mais balise muette ou incertaine (ambre, filet en tirets), incident terminé (vert pâturage). Avant cette passe, un incident ouvert disparaissait de l'écran dès que le téléphone cessait d'émettre.
- **Bande vocale** : le micro est dans un cadre net ; son filet de gauche et la couleur de l'état disent « j'écoute » (rouge) ou « je réponds » (ocre), en plus du libellé. Quatre traits animés pendant la réponse : un signe d'état, pas une mesure du son.
- **Vue de la zone** : schéma agrandi, échelle lisible à la verticale du repère (moitié du seuil, seuil, double), légende, source et précision de chaque mesure, ancienneté quand la balise ne transmet plus (la dernière position reste affichée, estompée). Sous 640 px, le schéma laisse place à une liste des mêmes mesures : un schéma réduit à 375 px ne se lisait plus (texte de 6 px).
- **Cohérence** : deux verts coexistaient (pétrole des anciens écrans, pâturage du nouveau) ; sur cet écran tous les boutons utilisent le pâturage, des angles de 4 px et un filet d'encre. Les réglages oui / non ne sont plus des pavés noirs : une pastille pleine ou vide précède le libellé.
- **Micro-typographie** : espaces insécables dans les guillemets et avant « : ; ? ! » à l'affichage, chiffres tabulaires, deux courbes d'animation nommées (apparition, micro-interaction).
- **Corrigé au passage** : le bandeau annonçait « données simulées » dès qu'une balise quelconque était simulée, même si celle qui était hors zone ne l'était pas ; les libellés du registre se chevauchaient à 375 px.
- Vérifié dans le navigateur à 1366 px et 375 px, en affichage simple et détaillé, sans défilement horizontal. Contrastes des nouvelles paires : toujours non mesurés.
