/**
 * Phrases dites et reconnues en baoulé (code ISO `bci`) pour la note vocale en baoulé.
 *
 * ÉTAT : PREMIER JET, VALIDÉ PAR AUCUN LOCUTEUR (`validated: false`). Tant que c'est le cas, l'écran le dit.
 * Pour valider : faire relire et corriger chaque phrase par une personne qui parle baoulé, puis passer `validated` à true.
 *
 * - `questions` : façons de poser chaque question. Elles servent seulement de points de comparaison avec ce que le modèle
 *   d'écoute transcrit ; un locuteur peut aussi enregistrer ses propres formulations depuis l'écran (elles s'ajoutent).
 * - `answers` : gabarits de réponse. `{N}` est remplacé par un nombre écrit en toutes lettres par `bciNumber` (une règle,
 *   jamais un modèle) : le chiffre dit est toujours celui qui a été lu dans les données.
 * - Orthographe : alphabet ILA (ɛ, ɔ, voyelles nasales écrites avec n), celle qu'attend le modèle de voix.
 */
export type BaouleIntent = 'situation' | 'changes' | 'missing' | 'beacons';

export const BAOULE_PHRASES = {
  validated: false,
  origin: 'Premier jet rédigé par un modèle de langue le 22/11/2026. Aucun locuteur du baoulé ne l’a relu.',
  questions: {
    situation: ['Min nnɛn mun be ti sɛ ?', 'Nnɛn nnyɛ yɛ n le be ?'],
    changes: ['Ngue yɛ ɔ kacili kɛ ɔ fin anuman ?', 'Ngue like uflɛ yɛ ɔ juli ?'],
    missing: ['Ngue yɛ ɔ ka ?', 'Ndɛ benin yɛ ɔ ka ?'],
    beacons: ['Nnɛn benin yɛ ɔ wɔli mmua ?', 'Min nnɛn wo nin ?'],
  } satisfies Record<BaouleIntent, string[]>,
  answers: {
    animals: { fr: '{N} animaux sont enregistrés.', bci: 'Be klɛli nnɛn {N}.' },
    changes: { fr: 'Depuis hier, {N} nouvelles choses ont été enregistrées.', bci: 'Kɛ ɔ fin anuman, be klɛli like uflɛ {N}.' },
    changesNone: { fr: 'Depuis hier, rien de nouveau n’a été enregistré.', bci: 'Kɛ ɔ fin anuman, be klɛman like uflɛ fi.' },
    missing: { fr: '{N} informations manquent ou sont à vérifier.', bci: 'Ndɛ {N} yɛ ɔ ka.' },
    missingNone: { fr: 'Aucune information ne manque.', bci: 'Ndɛ fi kaman.' },
    beaconOut: { fr: 'Attention. Un animal qui porte une balise s’est éloigné. Il est à {N} mètres.', bci: 'Nian. Nnɛn kun wɔli mmua. Ɔ wo mɛtri {N} su.' },
    beaconOk: { fr: 'Aucun animal suivi ne s’est éloigné.', bci: 'Nnɛn fi wɔman mmua.' },
    beaconNone: { fr: 'Aucun animal n’est suivi par une balise.', bci: 'Be nianman nnɛn fi su.' },
    screen: { fr: 'Les détails sont écrits à l’écran.', bci: 'Ndɛ’n i kwlaa wo ekran’n su.' },
    unknown: { fr: 'Je n’ai pas compris. Répétez, s’il vous plaît.', bci: 'N a timan. Kan ekun, yaci.' },
  },
} as const;

export type BaouleAnswerKey = keyof typeof BAOULE_PHRASES.answers;

const UNITS = ['', 'kun', 'nnyɔn', 'nsan', 'nnan', 'nnun', 'nsiɛn', 'nso', 'mɔcuɛ', 'ngwlan'];
const TENS = ['', 'blu', 'ablaɔn', 'ablasan', 'ablanan', 'ablenun', 'ablesiɛn', 'ableso', 'ablemɔcuɛ', 'ablengwlan'];

/**
 * Nombre entier écrit en toutes lettres en baoulé (1 à 9 999), par règle fixe : unités, dizaines (blu, ablaɔn…),
 * centaines (ya), milliers (akpi), reliés par « nin ». Null hors de ces bornes ou pour zéro (les gabarits ont une forme
 * « aucun »). Les noms de nombres sont, eux aussi, à faire confirmer par un locuteur.
 */
export function bciNumber(n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 9999) return null;
  const parts: string[] = [];
  const th = Math.floor(n / 1000);
  const h = Math.floor((n % 1000) / 100);
  const t = Math.floor((n % 100) / 10);
  const u = n % 10;
  if (th) parts.push(`akpi ${UNITS[th]}`);
  if (h) parts.push(`ya ${UNITS[h]}`);
  if (t) parts.push(TENS[t]!);
  if (u) parts.push(UNITS[u]!);
  return parts.join(' nin ');
}
