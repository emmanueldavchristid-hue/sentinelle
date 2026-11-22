# Baoulé (`bci`) : recherche, essais réels et état

Demandes de Yvan (22/11) : « On va ajouter le baoulé, tu devras analyser et rechercher le modèle baoulé » ; puis : « le baoulé doit seulement être orienté sur la saisie vocale, pas sur les écrits de l'interface. Il faut que le modèle donne des réponses en baoulé, car l'utilisateur peut être baoulé » ; puis, après ses essais au téléphone : « il prend le temps avant de transcrire, ou il ne transcrit même pas ce qu'on dit, et il ne répond pas. Prends la même voix [que les trois exemples] et intègre-la dans l'application. »

> Ce document a été reconstitué le 22/11 au soir dans une session Claude en ligne, le PC étant éteint : les sections 1 à 4 et 6 reprennent le texte écrit sur le PC (retrouvé dans l'historique de la session) ; la section 7 décrit ce qui a été ajouté ensuite, sans les modèles, donc sans essai réel.

## En bref
- **L'interface écrite reste en français.** Le baoulé ne concerne que la voix.
- **Les services en ligne ne savent pas le baoulé** : essai réel de la conversation en direct de Gemini (section 4), question non reconnue et chiffres changés. Ce mode n'est pas branché.
- **Réalisé le 22/11 : la voix en baoulé par des modèles ouverts installés sur le PC** (sections 6 et 7). L'utilisateur pose une question en baoulé, ou touche l'une des quatre questions, et l'application répond à la voix en baoulé ; les faits et leurs preuves s'affichent en français. Aucun modèle ne formule un fait ni un chiffre.
- **Amélioré le 22/11 au soir (section 7)** : écoute par un moteur plus rapide, réponse en deux temps (les faits avant la voix), voix rendue audible sur téléphone, voix préparée d'avance et gardée sur disque, questions à toucher, alerte de balise et réponses aux questions en français dites en baoulé. **Rien de cela n'a été essayé avec les vrais modèles ni sur un vrai téléphone** : c'est la première chose à faire sur le PC (`pnpm baoule:check`).
- **Ce qui reste vrai** : les phrases baoulé sont un premier jet, validé par aucun locuteur ; quatre questions seulement sont reconnues ; pas de phrase libre, pas d'observation ni de confirmation en baoulé. L'écran le dit, et la voix reste marquée « à l'essai ».

## 1. Ce que prennent en charge les services (pages officielles lues le 22/11/2026)

| Service | Baoulé listé ? | Source |
|---|---|---|
| Google Traduction (grand public) | **Oui** (ajout de juin 2024, 110 langues) | https://support.google.com/translate/answer/15139004?hl=en |
| Cloud Translation API | Non | https://docs.cloud.google.com/translate/docs/languages |
| Gemini, modèles texte | Non | https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/models |
| Gemini Live (conversation) | Non (99 langues, dont l'akan, langue apparentée mais distincte) | https://aistudio.google.com/docs/live-api/capabilities |
| Gemini TTS (voix) | Non (akan et dioula oui) | https://aistudio.google.com/docs/speech-generation |
| Cloud Speech-to-Text, Cloud Text-to-Speech | Non | https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages |
| Meta MMS | Identification de langue seulement (ni reconnaissance, ni voix) | https://dl.fbaipublicfiles.com/mms/misc/language_coverage_mms.html |
| Meta NLLB-200, SeamlessM4T v2 | Non | https://huggingface.co/facebook/nllb-200-distilled-600M |
| OpenAI Whisper, ElevenLabs, Azure, AWS | Non | https://github.com/openai/whisper/blob/main/whisper/tokenizer.py |

## 2. Les modèles qui citent le baoulé

| Usage | Modèle | Données baoulé | Licence | Remarque |
|---|---|---|---|---|
| Reconnaissance vocale | **Meta Omnilingual ASR** (`bci_Latn`) | 8,3 h | Apache 2.0 | Taux d'erreur publié (10,7 % par caractère) pour le plus gros modèle (25 Gio) ; les petits (1,3 à 3,7 Gio) seront moins bons. Audio de moins de 40 s. https://github.com/facebookresearch/omnilingual-asr |
| Reconnaissance vocale | `abdouaziiz/baoule_stt_2` (Whisper small affiné) | parole lue (WAXAL) | Apache 2.0 | Erreur de 18 % par mot sur son propre jeu ; terrain inconnu. https://huggingface.co/abdouaziiz/baoule_stt_2 |
| Synthèse vocale | `AfriSpeech/africa-tts` (`bci`) | 2,2 h | CC-BY-NC | Tourne sur processeur (440 Mo). https://huggingface.co/AfriSpeech/africa-tts |
| Synthèse vocale | `k2-fsa/OmniVoice` (`bci`) | 10,2 h | poids CC-BY-NC | Clonage de voix : il faut un extrait de référence en baoulé. https://github.com/k2-fsa/OmniVoice/blob/master/docs/languages.md |
| Traduction | **Google MADLAD-400** (`<2bci>`) | petites, bibliques | Apache 2.0 | 3 milliards de paramètres ; phrases d'élevage hors domaine. https://huggingface.co/google/madlad400-3b-mt |
| Traduction | `GaindeNdiaye/nllb-baoule-v1` | — | CC-BY-NC | Ses auteurs jugent le registre quotidien « faible » (chrF++ 10,4), sans évaluation par un locuteur. https://huggingface.co/GaindeNdiaye/nllb-baoule-v1 |
| Voix, texte | `Tree-AI-lab/kouman-*` (« Kouman IA ») | — | variable | Accès restreint, fiches non lisibles, identité non confirmée. https://huggingface.co/Tree-AI-lab |

Données ouvertes : Mozilla Common Voice `bci` (15 h enregistrées, 12 validées, 18 locuteurs, CC0), Google WAXAL (`bau_tts`, 1 216 énoncés, CC-BY), Google SMOL (anglais vers baoulé).
Initiative ivoirienne : **YIRI** (FuturAfric, présenté à Abidjan le 15/10/2026 ; baoulé et dioula annoncés « à 70 % ») ; aucune API documentée trouvée. https://community.yiri.africa

Licences : CC-BY-NC convient à un hackathon, pas à un produit commercial. Seuls Omnilingual ASR, MADLAD-400 et `baoule_stt_2` sont en Apache 2.0.

## 3. Essais réels avec la clé du projet (22/11)
Dix phrases de l'écran traduites du français vers le baoulé, puis retraduites vers le français par un second appel. La retraduction est un indice faible : elle ne remplace pas un locuteur.

| Modèle | Constat |
|---|---|
| `gemini-3.5-flash-lite` (celui de l'assistant) | Inutilisable : se dit lui-même peu sûr ; « 8 animaux sont enregistrés » revient en « Eau 8 sur rouge il est sur ». |
| `gemini-3.6-flash` | Moyen : « ce matin » revient en « la chenille » ; environ 11 s par appel. |
| `gemini-4-hydrogen` | Le sens revient sur la plupart des phrases, mais 245 s puis 66 s pour dix phrases : impossible en conversation. |
| `gemini-3.8-flash`, `gemini-flash-latest` | Indisponibles pendant l'essai (503). |

Conclusion : pas de traduction à la volée. Un modèle qui ne connaît pas la langue invente, et rien dans l'application ne permettrait de s'en apercevoir.

## 4. Essai réel de la voix en baoulé avec l'API Live (22/11)
Script d'essai, vrais appels à `gemini-3.8-live` (le modèle de la conversation en direct), avec une fonction qui renvoie trois faits fixes en français : « 8 animaux sont enregistrés », « 5 enregistrements ont été reçus depuis hier », « la balise Poulet A est à 57 mètres du repère, vers le nord-est, hors de sa zone ».

| Essai | Résultat |
|---|---|
| A. Question écrite en français, réponse demandée en baoulé parlé | Le modèle appelle la fonction et produit 13,8 s de parole d'allure baoulé (premier son après 3,1 s). Sa propre transcription : « Mɔ nsan o ti nvle su. Kɛnɛ nnu o ba ti kɛnɛ bɛlɛ su… ». |
| B. Le modèle dit une question en baoulé (pour disposer d'un son à réinjecter) | 5 s de parole : « Ngo mun be o min fie su nsan, yɛ sa mun be bali kɛɛ fiti nɔle nsan? » |
| C. Ce son renvoyé comme un micro, réponse demandée en baoulé | La transcription de ce qui est entendu sort **en coréen** (« 너 문배우 민폐 순선… ») : la langue n'est pas reconnue. Le modèle répond quand même, avec d'autres mots que dans l'essai A pour les mêmes faits. |
| D. Contrôle : le même son, à un modèle chargé de dire en français ce qu'il a compris | « Je n'ai pas compris. » |

Ce que l'essai établit :
- **Écoute** : le baoulé n'est pas reconnu. La question est transcrite dans une autre langue et n'est pas comprise. Réserve : le son réinjecté était du « baoulé » prononcé par le modèle lui-même, pas par un locuteur ; un essai avec une vraie voix reste à faire, mais rien n'indique qu'il réussirait.
- **Parole** : les mêmes faits ne sont pas dits de la même façon d'un essai à l'autre (« 8 animaux » : « Mɔ nsan » en A, « nnɛn miɛnɛn » en C ; « nsan » est le mot baoulé pour trois). Le modèle n'a donc pas une forme stable pour les nombres : rien ne garantit que le chiffre dit est le chiffre lu.
- **Conséquence** : brancher ce mode ferait dire à l'éleveur, dans sa langue, des chiffres que l'application n'a pas lus. C'est contraire à la règle de base de l'assistant (ne dire que ce qui figure dans une lecture). Il n'est donc pas branché.

Enregistrements gardés pour qu'un locuteur les écoute (restés sur le PC, commit local `b652fe5`, absents de cette branche) : `docs/captures/essai-voix-baoule-A-2026-11-22.wav` et `essai-voix-baoule-C-2026-11-22.wav` (voix de synthèse Gemini, ce ne sont pas des réponses de l'application). Si un locuteur les juge compréhensibles et justes, la conclusion ci-dessus est à revoir.

## 5. Premier jet de libellés écrits (non utilisé)
Un premier jet de 29 libellés d'écran avait été produit le 22/11 par `gemini-4-hydrogen` pour une bascule de langue écrite, retirée le jour même à la demande de Yvan : l'interface reste en français. Indices de faiblesse visibles sans parler la langue : « Mon élevage » revenait en « mon achat de viande », « Ajouter une observation » en « ajoute une parole d'exemple ». Le tableau de ce premier jet est resté sur le PC (commit local `cc078bf`) ; il n'est pas repris ici.

## 6. La note vocale en baoulé (réalisée le 22/11, modèles locaux)
Téléchargements autorisés par Yvan le 22/11 (« Oui, télécharge »), rangés dans `data/baoule` (hors Git) : `abdouaziiz/baoule_stt_2` (967 Mo, Apache 2.0), `AfriSpeech/africa-tts` (438 Mo, CC-BY-NC : usage non commercial), PyTorch pour processeur et les paquets `africa-tts` 0.5.2, `africa-g2p` 0.3.5, `pocket-tts` 4.0.1, dont le code a été lu avant installation.

### La chaîne
1. **Écouter** : la note vocale (20 s au plus) est transcrite en baoulé par `baoule_stt_2`, dans le service local `tools/baoule/serveur.py` (écoute sur 127.0.0.1 seulement ; ni son ni texte gardés).
2. **Rapprocher** : la transcription est comparée, par une règle de ressemblance (paires de lettres), à quelques formulations de quatre questions : la situation de l'élevage, les nouveautés depuis hier, ce qui manque, l'animal qui s'est éloigné. Pas de traduction. En dessous d'un seuil, ou si deux questions se valent, la question est dite non reconnue : rien n'est lu, rien n'est deviné.
3. **Lire les faits** : la question retenue est traitée comme sa version française tapée au clavier (lecture directe des données, sans IA générative). La réponse s'affiche en français, avec ses sources.
4. **Répondre** : un gabarit baoulé fixe par cas (`apps/api/src/baoule-phrases.ts`), où seul le nombre change ; il est écrit en toutes lettres par une règle (`bciNumber`, 1 à 9 999), jamais par un modèle. Le chiffre dit est donc celui qui a été lu. L'écran affiche aussi le sens en français de ce qui est dit.
5. **Dire** : `africa-tts` (langue `bci`) prononce la réponse, phrase par phrase, avec une mémoire des phrases déjà dites.

**Apprendre une formulation** (affichage détaillé) : une personne qui parle baoulé choisit une des quatre questions et la pose à sa façon. Seule la transcription est gardée (`data/baoule/exemples.json`), comme point de comparaison. C'est le moyen prévu pour rendre la reconnaissance fiable avec de vraies voix, sans que personne ait à écrire du baoulé.

### Ce que cette voix ne fait pas
Comprendre une phrase libre, préparer ou confirmer une observation, tenir une conversation. Pour cela, le français reste nécessaire.

### Essais réels sur ce poste (22/11, processeur i7-4800MQ, sans carte graphique)
| Essai | Résultat |
|---|---|
| Écoute d'un vrai enregistrement humain en baoulé (2,8 s, l'extrait de voix fourni avec `africa-tts`) | « like nga nzowa seli kɛ ɔ yo min i. », en 6 à 7 s. Phrase d'allure baoulé plausible ; non vérifiée par un locuteur. |
| Écoute de phrases françaises | Le modèle écrit tout « en baoulé » (« kis kɛ sranjɛn de fu yɛ ɔ? ») : il ne sait pas dire qu'on ne lui parle pas baoulé. La règle de ressemblance écarte ces phrases. |
| `pnpm baoule:check` : les 8 questions de référence prononcées par la voix de synthèse puis réécoutées | **4 sur 8 retrouvées**, et pas les mêmes d'une fois sur l'autre. Sur un son de 1 à 2 secondes, le modèle d'écoute invente souvent une longue phrase. Les questions non retrouvées sont dites « non reconnues », jamais confondues avec une autre. |
| Temps | Écoute : 6 à 10 s, quel que soit le son (coût fixe du modèle sur ce processeur). Voix : 1 à 5 s, presque nul pour une phrase déjà dite. |
| De bout en bout dans Chrome (`baoule.spec.ts`, faux micro jouant une question de synthèse, vrais modèles) | Entendu « n'guilike uflɛ yɛ ɔ juli. », question « Qu'est-ce qui a changé depuis hier ? » retenue (ressemblance 0,84), réponse prononcée, faits affichés en français. **13,4 s** de l'appui à la réponse. |
| Version allégée du modèle d'écoute (poids arrondis en entiers 8 bits par PyTorch) | Écartée : ni plus rapide, ni aussi juste. Ce n'est pas le moteur rapide de la section 7 (CTranslate2), qui n'a pas encore été mesuré. |

### Ce qu'il reste à faire, avec un locuteur du baoulé
1. **Valider les phrases** de `apps/api/src/baoule-phrases.ts` (réponses, questions, noms des nombres), puis passer `validated` à `true`. Sans cela, l'écran garde la mention « premier jet ».
2. **Essayer avec une vraie voix** : poser les quatre questions ; noter ce qui est reconnu.
3. **Enregistrer ses formulations** (affichage détaillé, « Apprendre une formulation »), en phrases entières de 2 à 4 secondes, puis réessayer.
4. Écouter les réponses gardées dans `data/baoule/essais` par `pnpm baoule:check` : la voix est-elle compréhensible ?

### Installer et lancer
```
py -3.12 -m venv data\baoule\venv
data\baoule\venv\Scripts\python.exe -m pip install -r tools\baoule\requirements.txt
```
Modèles : `abdouaziiz/baoule_stt_2` dans `data/baoule/stt` ; `config.yaml`, `model.safetensors`, `tokenizer.json` et `voices/bci.wav` de `AfriSpeech/africa-tts` dans `data/baoule/tts`.
Lancer le service de parole (une vingtaine de secondes de chargement), puis le serveur avec `BAOULE_VOICE=on` dans `.env` :
```
data\baoule\venv\Scripts\python.exe tools\baoule\serveur.py
pnpm baoule:check
```

### Licences
`africa-tts` est en CC-BY-NC : acceptable pour un démonstrateur de concours, pas pour un produit commercial. Pour un produit, la voix devrait venir d'enregistrements de locuteurs ou d'un modèle sous licence ouverte.

## 7. Améliorations du 22/11 au soir (après les essais de Yvan au téléphone)
Constats de Yvan : la transcription est lente, parfois absente ; aucune réponse n'est entendue ; il faut la même voix que les trois exemples écoutés (`reponse-situation`, `reponse-balise`, `reponse-non-comprise`, produits par `pnpm baoule:check` : c'est la voix `africa-tts` du service local).

| Constat | Cause la plus probable | Ce qui a été fait |
|---|---|---|
| « Il prend le temps avant de transcrire » | L'écoute coûte 6 à 14 s sur ce processeur, quel que soit le son, et l'écran attendait en plus la voix avant d'afficher quoi que ce soit. | Écoute par `faster-whisper` (modèle converti pour CTranslate2, `data/baoule/stt-ct2`) quand il est installé. Réponse en deux temps : ce qui a été entendu et les faits s'affichent dès la fin de l'écoute, la voix suit. |
| « Il ne transcrit même pas » | Sur un son court ou faible, le modèle invente une phrase sans rapport, qui n'est rapprochée d'aucune question. | Son nettoyé avant l'écoute (silences retirés, niveau remonté). Un enregistrement sans parole n'est plus donné au modèle. Une question dite au milieu d'une phrase plus longue est retrouvée. Quand la question n'est pas reconnue, quatre questions à toucher sont proposées : la réponse est dite en baoulé sans passer par l'écoute. |
| « Il ne répond pas » | Sur un téléphone, le navigateur refuse de jouer un son qui ne suit pas immédiatement un geste ; la réponse arrivait une dizaine de secondes après l'appui. | Le lecteur est débloqué pendant l'appui, puis réutilisé pour la réponse. Si le navigateur refuse encore, l'écran le dit et offre un bouton « Écouter la réponse en baoulé ». |
| « Répondre directement, avec la même voix » | La voix n'était dite qu'après une note vocale reconnue. | Même voix partout : « Réponses à voix haute en baoulé » fait dire en baoulé l'alerte de balise et les réponses aux questions posées en français qui ont une phrase baoulé (élevage, depuis hier, manques, balises). Les réponses du moment sont prononcées d'avance, et chaque phrase dite est gardée sur disque (`data/baoule/cache-voix`) : la redire ne coûte rien. |

### Ce qui change dans la chaîne
- `tools/baoule/serveur.py` : `/health` dit quel moteur d'écoute tourne ; `/stt` rend `silence: true` sans rien transcrire si aucune parole n'est repérée ; `/warm` prépare des phrases à l'avance en laissant passer les demandes en direct.
- `POST /api/assistant/baoule` avec `voice: "later"` : la réponse écrite part sans le son ; `GET /api/assistant/baoule/voix/:id` le rend ensuite, à celui qui a posé la question, pendant trois minutes.
- `POST /api/assistant/baoule/question` : la question est choisie (bouton, alerte, question en français), rien n'est écouté.
- `POST /api/assistant/baoule/preparer` : fait prononcer d'avance les phrases fixes et les réponses du moment.
- Les règles de vérité ne changent pas : faits lus dans les données, gabarits fixes, nombres par règle, question non reconnue jamais devinée.

### À faire sur le PC, dans cet ordre
1. Installer le moteur rapide (déjà fait le 22/11 à 15 h 15 dans `data/baoule/venv` ; le modèle converti `data/baoule/stt-ct2` existe) : `data\baoule\venv\Scripts\python.exe -m pip install -r tools\baoule\requirements.txt`.
2. Relancer le service de parole, puis `pnpm baoule:check`. Il affiche le moteur d'écoute, les temps, et combien des 8 questions de référence sont retrouvées.
3. **Comparer avec le moteur d'origine** : relancer le service avec `BAOULE_STT_ENGINE=origine`, refaire `pnpm baoule:check`, et garder le moteur qui retrouve le plus de questions. Le moteur rapide n'a jamais été mesuré : la session du PC s'est interrompue pendant cette mesure. Si le moteur rapide transcrit moins bien en `int8`, essayer `BAOULE_STT_COMPUTE=float32`.
4. Essai au téléphone par le lien https : toucher « Mon élevage » (la réponse doit s'entendre), puis « Parler en baoulé ».
5. Avec une personne qui parle baoulé : « Affichage détaillé », « Apprendre une formulation », pour chacune des quatre questions (20 formulations gardées au plus par question).

### Vérifié, et non vérifié
- Vérifié dans la session en ligne (Linux, sans les modèles) : `baoule.test.ts` 21/21 contre un faux service de parole, dont 14 transcriptions réelles relevées sur le PC (aucune n'est rapprochée d'une autre question que celle posée) ; `python tools/baoule/test_serveur.py` 12/12 contre de faux moteurs ; dans Chrome, `baoule-faux.spec.ts` 4/4 (`BAOULE=faux` : faux service de parole, faux micro, son réellement joué par le navigateur).
- **Non vérifié** : le moteur rapide avec le vrai modèle (vitesse, justesse, langue retenue) ; le nettoyage du son sur de vraies voix ; la lecture du son sur un vrai téléphone (iPhone et Android) ; le temps réel de bout en bout. `baoule.spec.ts` (`BAOULE=1`, vrais modèles) a été adapté à la réponse en deux temps sans pouvoir être rejoué.

## 8. Non vérifié dans la recherche initiale
Le comportement réel de Cloud Translation avec `bci` (non listé, non essayé), la voix du baoulé dans l'application Google Traduction, la qualité réelle de tous les modèles cités (chiffres de leurs auteurs), les fiches des dépôts à accès restreint, l'existence d'une API YIRI, la règle officielle de notation des tons (document ILA de 1979 introuvable en ligne).
