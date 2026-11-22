# Essais à faire par nous (vraie voix, vrai téléphone)

Aucun de ces essais n'a été fait par l'assistant de code : il n'a ni voix, ni haut-parleurs, ni téléphone, ni GPS.
Ce qui a été vérifié automatiquement l'a été avec un **faux microphone** (voix de synthèse jouée par Chrome) et une **position émulée**.
Notez pour chaque ligne : fait / pas fait, ce qui s'est passé, sur quel appareil.

Avant de commencer : `pnpm assistant:check` (les étapes 2, 3 et 5 doivent dire « opérationnel »), puis ouvrir l'application.

## Sur l'ordinateur (Chrome ou Edge, haut-parleurs allumés)
1. Ouvrir http://localhost:3000. Toucher le gros bouton **Parler**, autoriser le micro. Un bip, puis « Je vous écoute ».
2. Dire : « Qu'est-ce qui a changé depuis hier ? ». Noter le délai avant la réponse, et si la voix est audible et compréhensible.
3. Vérifier que l'assistant **ne se coupe pas lui-même** (écho des haut-parleurs). Si c'est le cas : baisser le volume ou utiliser un casque, et le noter.
4. Sous la réponse, ouvrir « Détails et preuves » et cliquer une source : l'enregistrement s'ouvre.
5. Poser une question longue, puis toucher **Interrompre** pendant la réponse : la voix s'arrête, « Je vous écoute » revient.
6. Dire : « Ajoute une observation sur B zéro dix-sept : elle boite. ». Écouter le brouillon, puis dire « **non** ». Rien ne doit être enregistré.
7. Dire : « Ajoute une observation sur B zéro dix-sept : elle mange moins depuis ce matin. ». Écouter le brouillon, puis dire « **je confirme** ». « Reçu par le serveur » s'affiche, et l'assistant le dit.
8. Demander de nouveau « Qu'est-ce qui a changé depuis hier ? » : le chiffre a augmenté de un, l'écran indique « Réponse mise à jour ».
9. Toucher le bouton pour arrêter. L'indicateur de micro du navigateur doit s'éteindre.
10. Essayer une phrase piège avec un brouillon ouvert : « je ne confirme pas ». Rien ne doit être enregistré.

## Sur le téléphone (lien https du tunnel, pas `localhost`)
1. Sur l'ordinateur : « Associer une balise », nom « Poulet A », seuil 20 ou 30 m. Scanner le QR code avec le téléphone.
2. Sur le téléphone : **Autoriser la position**. Noter la précision annoncée (± x m).
3. **Fixer le repère ici**. Sur l'ordinateur, la balise apparaît « dans la zone », avec « GPS du téléphone ».
4. S'éloigner à pied, dehors, nettement au-delà du seuil. Noter à quelle distance l'état passe à « incertain », puis à « hors de la zone ».
5. Sur l'ordinateur : l'alerte rouge apparaît. Toucher **Comprendre avec Sentinelle** : la synthèse de l'incident s'affiche. Toucher **Écouter et discuter**.
6. Revenir près du repère : l'alerte disparaît, « Incident terminé » s'affiche.
7. Verrouiller le téléphone 30 secondes : la balise doit être dite « muette », avec l'ancienneté de la dernière mesure. Elle ne doit pas « bouger » toute seule.
8. En salle (GPS imprécis) : passer en **Distance simulée** sur le téléphone. Le bandeau « données simulées » doit être visible sur les deux écrans.
9. **Arrêter** la balise depuis l'ordinateur : le téléphone l'indique.
10. Sur le téléphone, essayer aussi le bouton **Parler** (micro du téléphone, réseau mobile ou Wi-Fi) et noter le délai.

## Ce qu'il faut me rapporter
- Délai ressenti avant la réponse parlée (mesuré avec un faux micro : environ 2 secondes sur l'ordinateur, 2,5 secondes par le tunnel).
- Écho ou coupures, sur haut-parleurs et sur casque.
- Précision GPS réelle dehors et dedans, et distance à laquelle l'alerte se déclenche.
- Toute phrase mal comprise (identifiants d'animaux surtout : « B zéro dix-sept »).
