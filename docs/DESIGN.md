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
