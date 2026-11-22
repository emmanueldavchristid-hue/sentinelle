/**
 * SENTINELLE VIVANT : contrats des fonctions de lecture et de préparation d'écriture de l'exploitation.
 * Chaque capacité est une fonction serveur validée. Les écrans l'appellent directement, l'assistant l'appelle comme outil :
 * l'assistant ne peut donc rien faire que l'interface ne sache déjà faire.
 * Ce fichier ne dépend d'aucun autre module à l'exécution (types et fonctions pures uniquement).
 */
import type { TemporalValueDto } from './index.js';

/** Les cinq natures d'information, toujours affichées par un libellé (jamais par la seule couleur). */
export const INFO_NATURE_LABELS = {
  FACT: 'Fait enregistré',
  COMPUTED: 'Résultat calculé',
  DOCUMENT: 'Contenu documentaire',
  MISSING: 'Donnée absente',
  SUGGESTION: 'Suggestion',
} as const;
export type InfoNature = keyof typeof INFO_NATURE_LABELS;

/** Référence de source cliquable : OBS:<uuid> · REC:<id>@<rév> · TASK:<uuid> · ANIMAL:<id> · SITE:<id>. */
export interface SourceRef {
  ref: string;
  label: string;
}

/** Une phrase de réponse, avec sa nature et ses sources. Construite par le serveur à partir des données. */
export interface Statement {
  nature: InfoNature;
  text: string;
  sources: string[];
}

export type FarmEventType = 'OBSERVATION' | 'PRESENCE' | 'MOVEMENT' | 'CORRECTION' | 'TASK_CREATED' | 'TASK_REQUESTED' | 'TASK_DONE';
/** Nature du changement : ajout, correction (nouvelle révision), tâche. */
export type ChangeKind = 'ADDED' | 'CORRECTED' | 'TASK';

export const FARM_EVENT_LABELS: Record<FarmEventType, string> = {
  OBSERVATION: 'Observation',
  PRESENCE: 'Présence enregistrée',
  MOVEMENT: 'Déplacement enregistré',
  CORRECTION: 'Correction',
  TASK_CREATED: 'Tâche proposée',
  TASK_REQUESTED: 'Tâche demandée',
  TASK_DONE: 'Tâche complétée',
};
export const CHANGE_LABELS: Record<ChangeKind, string> = { ADDED: 'Ajout', CORRECTED: 'Correction', TASK: 'Tâche' };

/**
 * Événement consultable de l'exploitation. Trois dates sont toujours distinguées :
 * eventTime (date de l'événement), deviceRecordedAt (saisie sur l'appareil, si connue), recordedAt (réception par le serveur).
 */
export interface FarmEvent {
  ref: string;
  type: FarmEventType;
  change: ChangeKind;
  animalId: string | null;
  siteIds: string[];
  eventTime: TemporalValueDto | null;
  deviceRecordedAt: string | null;
  recordedAt: string;
  title: string;
  detail: string | null;
  author: string | null;
}

export type FarmToolName = 'situation' | 'changes' | 'find_animal' | 'animal' | 'missing' | 'source' | 'prepare_observation' | 'beacons' | 'incident';

/** Enveloppe commune à tous les résultats : données, sources, dates, limites, paramètres. */
export interface ToolResult<T = unknown> {
  tool: FarmToolName;
  params: Record<string, unknown>;
  /** État des données : instant serveur auquel la lecture a été faite. */
  asOf: string;
  /** Période couverte (réception serveur), si la lecture porte sur une période. */
  period: { from: string; to: string } | null;
  statements: Statement[];
  data: T;
  sources: SourceRef[];
  /** Limites : troncature, période couverte, données absentes, règles de calcul. */
  limits: string[];
}

export interface SiteSummary {
  id: string;
  code: string;
  name: string;
  kind: 'FARM' | 'MARKET';
  x: number | null;
  y: number | null;
  /** Animaux dont une présence ouverte est enregistrée sur ce site. */
  animalsPresent: number;
}
export interface MoveEdge {
  from: string;
  to: string;
  count: number;
  /** Jusqu'à 5 références de déplacements, pour la preuve. */
  refs: string[];
}
export interface MissingItem {
  ref: string;
  animalId: string | null;
  kind: 'NO_CURRENT_SITE' | 'UNKNOWN_TIME' | 'DAY_ONLY' | 'INCONSISTENT' | 'OPEN_TASK';
  text: string;
}
export interface ChangeCounts {
  added: number;
  corrected: number;
  tasks: number;
  total: number;
}

export interface SituationData {
  org: { id: string; name: string };
  sites: SiteSummary[];
  moves: MoveEdge[];
  animals: { total: number; located: number; unlocated: number };
  /** Aucun lot n'est enregistré dans ce démonstrateur : le champ existe pour ne pas inventer d'individus. */
  lots: { id: string; species: string; headcount: number }[];
  recent: { from: string; counts: ChangeCounts; events: FarmEvent[] };
  toComplete: { total: number; openTasks: number; items: MissingItem[] };
  sync: { lastServerReceipt: string | null; datasetResetAt: string | null };
}
export interface ChangesData {
  counts: ChangeCounts;
  events: FarmEvent[];
}
export interface AnimalMatch {
  id: string;
  tag: string;
  species: string;
  currentSiteId: string | null;
}
export interface FindAnimalData {
  query: string;
  normalized: string;
  matches: AnimalMatch[];
}
export interface AnimalData {
  animal: { id: string; tag: string; species: string };
  currentSiteId: string | null;
  /** Sites reliés à l'animal par un enregistrement (présence, déplacement, observation). */
  siteIds: string[];
  timeline: FarmEvent[];
  missing: MissingItem[];
}
export interface MissingData {
  counts: Record<MissingItem['kind'], number>;
  items: MissingItem[];
}
export interface SourceData {
  ref: string;
  kind: 'observation' | 'record' | 'task' | 'animal' | 'site' | 'device' | 'incident';
  title: string;
  /** Champs lisibles de l'enregistrement, dans l'ordre d'affichage. */
  fields: { label: string; value: string }[];
  event: FarmEvent | null;
  /** Révisions conservées (rien n'est écrasé). */
  revisions: { rev: number; recordedAt: string; author: string | null; reason: string | null; summary: string }[];
}

export type DraftFieldStatus = 'OK' | 'DEDUCED' | 'MISSING' | 'AMBIGUOUS' | 'TO_CONFIRM';
export interface DraftField<T> {
  value: T | null;
  status: DraftFieldStatus;
  message: string | null;
  candidates?: { id: string; label: string }[];
}
/** Brouillon d'observation : rien n'est écrit tant que l'utilisateur n'a pas confirmé. */
export interface ObservationDraftData {
  sourceText: string | null;
  animal: DraftField<string>;
  site: DraftField<string>;
  eventTime: DraftField<TemporalValueDto>;
  note: DraftField<string>;
  /** Vrai si tous les champs sont utilisables tels quels (la confirmation reste obligatoire). */
  ready: boolean;
  /** Observation déjà enregistrée qui ressemble à celle-ci (même animal, même jour, même texte). */
  possibleDuplicate: SourceRef | null;
}

// ---------- Balises de démonstration : contrat d'événement IoT minimal ----------

/** Statut d'une mesure par rapport au seuil. « Incertain » : la précision ne permet pas de trancher. */
export type ZoneState = 'INSIDE' | 'OUTSIDE' | 'UNCERTAIN' | 'NO_FIX';

/**
 * Une mesure d'un dispositif. Le contrat porte : la source, l'instant observé, l'instant reçu, l'unité (mètres, fixe),
 * la précision annoncée et le statut calculé par le serveur. L'identifiant du dispositif est porté par la balise.
 */
export interface BeaconReading {
  /** PHONE_GPS : GPS du navigateur d'un téléphone. SIMULATED : distance réglée à la main, à afficher comme simulée. */
  source: 'PHONE_GPS' | 'SIMULATED';
  observedAt: string;
  receivedAt: string;
  distanceM: number | null;
  accuracyM: number | null;
  zone: ZoneState;
  /**
   * Position relative au repère, en mètres vers l'est et vers le nord (suivi GPS). Null si le téléphone ne l'a pas transmise.
   * Ce ne sont pas des coordonnées géographiques : on sait où est la balise par rapport au repère, pas où est le repère.
   */
  eastM?: number | null;
  northM?: number | null;
}
/** Point d'une trajectoire : position relative au repère à un instant observé. */
export interface TrackPoint {
  eastM: number;
  northM: number;
  observedAt: string;
  zone: ZoneState;
  source: BeaconReading['source'];
}
/** Les huit directions, dites en clair. */
export type Bearing = 'nord' | 'nord-est' | 'est' | 'sud-est' | 'sud' | 'sud-ouest' | 'ouest' | 'nord-ouest';
const BEARINGS: Bearing[] = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];
/**
 * Direction d'une position relative au repère. Null si la direction n'a pas de sens : pas de position, ou balise trop près du
 * repère pour que la précision annoncée permette de dire de quel côté elle se trouve.
 */
export function bearingOf(eastM: number | null | undefined, northM: number | null | undefined, accuracyM: number | null | undefined = 0): Bearing | null {
  if (eastM === null || eastM === undefined || northM === null || northM === undefined) return null;
  if (Math.hypot(eastM, northM) <= Math.max(3, accuracyM ?? 0)) return null;
  const deg = (Math.atan2(eastM, northM) * 180) / Math.PI;
  return BEARINGS[Math.round(((deg + 360) % 360) / 45) % 8]!;
}
export interface Beacon {
  id: string;
  label: string;
  animalId: string | null;
  radiusM: number;
  createdAt: string;
  stoppedAt: string | null;
  latest: BeaconReading | null;
  /** NEVER : aucune mesure reçue. SILENT : plus de mesure depuis un moment (ne dit pas où est la balise). */
  status: ZoneState | 'NEVER' | 'SILENT' | 'STOPPED';
  outsideSince: string | null;
  silentSeconds: number | null;
  recent: BeaconReading[];
  /** Trajectoire récente (du plus ancien au plus récent), quand le téléphone transmet sa position relative. */
  track?: TrackPoint[];
}
/** Incident d'éloignement : un épisode « hors zone » d'une balise, avec les faits qui l'ont justifié. */
export interface IncidentSummary {
  id: string;
  deviceId: string;
  label: string;
  animalId: string | null;
  openedAt: string;
  closedAt: string | null;
  /**
   * E-mail d'alerte de cet incident, tel que le fournisseur d'envoi l'a réellement traité. SENT : accepté par le fournisseur
   * (pas « lu »). FAILED : rien n'est parti. SENDING : pas encore de réponse. Absent ou null : aucun envoi n'a été tenté.
   */
  email?: { status: 'SENDING' | 'SENT' | 'FAILED'; provider: string | null; to: string | null; at: string | null; error: string | null } | null;
}
export interface IncidentData extends IncidentSummary {
  /** Règle appliquée, en clair, et seuil au moment de l'incident. */
  rule: string;
  radiusM: number;
  /** Mesure qui a ouvert l'incident. */
  trigger: { observedAt: string; distanceM: number; accuracyM: number | null; source: BeaconReading['source'] };
  maxDistanceM: number;
  closeReason: 'BACK_INSIDE' | 'DEVICE_STOPPED' | null;
  /** État de la balise au moment de la lecture (pas au moment de l'incident). */
  current: Beacon | null;
}
export interface BeaconsData {
  /** Incidents récents (ouverts d'abord) : un par épisode d'éloignement. */
  incidents?: IncidentSummary[];
  beacons: Beacon[];
  /** Identifiants des balises hors de leur zone. */
  alerts: string[];
  /** Vrai si au moins une balise active transmet une distance simulée : bandeau « données simulées » obligatoire. */
  simulated: boolean;
}
/** Libellé donné à une balise quand l'utilisateur ne l'a pas nommée. */
export const DEFAULT_BEACON_LABEL = 'Téléphone de démonstration';
/** Nom affiché et dit d'une balise : le nom choisi (« Poulet A »), sinon son identifiant technique. */
export const beaconName = (b: { id: string; label: string }): string => (b.label && b.label !== DEFAULT_BEACON_LABEL ? b.label : b.id);

export const BEACON_STATUS_LABELS: Record<Beacon['status'], string> = {
  INSIDE: 'Dans la zone',
  OUTSIDE: 'Hors de la zone',
  UNCERTAIN: 'Incertain',
  NO_FIX: 'Pas de position',
  NEVER: 'Aucune mesure reçue',
  SILENT: 'Muette',
  STOPPED: 'Arrêtée',
};

/** État de l'assistant IA, tel que le serveur le connaît. Aucune valeur secrète. */
export interface AssistantStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
  /** Pourquoi l'assistant IA n'est pas disponible, en clair. */
  reason: string | null;
  /** Dictée : le serveur peut-il transcrire un enregistrement, et quelle durée maximale accepte-t-il ? */
  voice?: {
    available: boolean;
    maxSeconds: number;
    /** Le serveur sait-il produire une réponse parlée (synthèse vocale) ? */
    speech?: boolean;
    /** Conversation en direct : le modèle écoute et répond à la voix, sans étape de transcription. */
    live?: { available: boolean; model: string | null; maxSeconds: number; idleSeconds: number };
    /** Note vocale en baoulé, par des modèles ouverts exécutés sur le serveur (aucun service en ligne ne sait le baoulé). */
    baoule?: BaouleStatus;
  };
}

/**
 * Conversation en direct (WebSocket /api/assistant/live). Le navigateur envoie le son du micro en trames binaires
 * (PCM 16 bits mono 16 kHz) et reçoit la voix du modèle en trames binaires (PCM 16 bits mono 24 kHz). Les messages
 * ci-dessous voyagent en trames texte (JSON). Aucun son n'est conservé par le serveur.
 */
export type LiveClientMessage =
  | { type: 'start'; demoUser?: string; contextAnimalId?: string; contextIncidentId?: string; /** L'utilisateur a demandé à écouter cet incident : l'assistant commence par le résumer. */ speakIncident?: boolean }
  | { type: 'stop' }
  /** Réponse à `confirm_request` : ce que le chemin d'écriture habituel (brouillon, file d'envoi, reçu) a donné. */
  | { type: 'confirm_result'; id: string; state: 'RECEIVED' | 'QUEUED' | 'FAILED' | 'INVALID' | 'NO_DRAFT'; receivedAt?: string | null }
  /** L'utilisateur a agi à l'écran pendant la conversation (bouton vert, croix) : le modèle en est informé. */
  | { type: 'screen'; event: 'RECEIVED' | 'QUEUED' | 'FAILED' | 'DISCARDED' };

export type LiveEndReason = 'stopped' | 'silence' | 'limit' | 'upstream' | 'auth' | 'unavailable' | 'error';
export type LiveServerMessage =
  | { type: 'ready'; model: string; maxSeconds: number; idleSeconds: number }
  /** Fragment de ce que le modèle a entendu (transcription automatique), pour le tour `turn`. */
  | { type: 'heard'; turn: number; text: string }
  /** Fragment de ce que le modèle a dit (transcription automatique de sa voix). */
  | { type: 'said'; turn: number; text: string }
  /** Lecture des données faite pendant ce tour : c'est la preuve affichée à l'écran. */
  | { type: 'result'; turn: number; result: ToolResult; /** Brouillon prêt : son identifiant et l'empreinte de son contenu, auxquels une confirmation à la voix sera liée. */ draft?: { id: string; fingerprint: string; expiresAt: string } }
  | { type: 'turn_complete'; turn: number }
  /** L'utilisateur a repris la parole : la lecture en cours doit s'arrêter. */
  | { type: 'interrupted' }
  /** L'utilisateur a confirmé à la voix : l'écran doit enregistrer le brouillon ouvert par le chemin habituel. */
  | { type: 'confirm_request'; id: string; draftId: string; fingerprint: string }
  | { type: 'draft_cancel' }
  | { type: 'notice'; text: string }
  | { type: 'end'; reason: LiveEndReason; message: string };

/** Phrase dite ou écrite, ramenée à une forme comparable (minuscules, sans accents ni ponctuation). */
export function normalizeSpoken(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, ' ')
    .replace(/[.!?,;:«»"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
/** Confirmation dite en toutes lettres. */
const EXPLICIT = ['oui je confirme', 'je confirme', 'confirme', 'je valide', 'valide', 'enregistre'];
/** Accord bref : ne vaut confirmation que juste après la lecture du brouillon. */
const SHORT = ['c est exact', 'c est bon', 'c est ca', 'd accord', 'ouais', 'okay', 'exact', 'oui', 'ok'];
/** Mots de politesse admis autour d'une confirmation, sans valeur seuls. */
const FILLER = ['s il vous plait', 's il te plait', 'tout a fait', 'tres bien', 'parfait', 'merci', 'vas y', 'allez'];
const CANCEL_WORDS = /^(non|annule|annuler|j annule|abandonne|laisse tomber)( |$)/;
/**
 * Une phrase vaut-elle confirmation d'un brouillon ? Règle fixe, sans IA. La phrase ENTIÈRE doit être faite d'expressions de
 * confirmation : « je ne confirme pas », « tu as dit je confirme », « oui mais change le lieu » ou « explique ce que veut
 * dire confirmer » ne sont donc pas des confirmations. Renvoie « explicit » (« je confirme »), « short » (« oui », « d'accord » :
 * à n'accepter que juste après la lecture du brouillon) ou null.
 */
export function spokenConfirmation(t: string): 'explicit' | 'short' | null {
  let rest = normalizeSpoken(t);
  if (!rest || rest.length > 40) return null;
  let kind: 'explicit' | 'short' | null = null;
  const take = (words: string[]) => {
    const w = words.find((x) => rest === x || rest.startsWith(`${x} `));
    if (w === undefined) return false;
    rest = rest.slice(w.length).trim();
    return true;
  };
  while (rest) {
    if (take(EXPLICIT)) kind = 'explicit';
    else if (take(SHORT)) kind ??= 'short';
    else if (!take(FILLER)) return null;
  }
  return kind;
}
export const isSpokenConfirmation = (t: string): boolean => spokenConfirmation(t) !== null;
/** Empreinte du contenu d'un brouillon : une confirmation vaut pour ce contenu précis, pas pour un autre. */
export function draftFingerprint(d: ObservationDraftData): string {
  return JSON.stringify([d.animal.value, d.site.value, d.eventTime.value, d.note.value]);
}
/** Vrai si la phrase, courte, vaut abandon d'un brouillon (« non », « annule »). */
export function isSpokenCancellation(t: string): boolean {
  const n = normalizeSpoken(t);
  return n.length > 0 && n.length <= 40 && CANCEL_WORDS.test(n);
}

/**
 * Aide à la saisie d'une observation (formulaire « Nouvelle observation ») : la phrase de l'utilisateur, écrite ou dictée,
 * devient une PROPOSITION de champs. Rien n'est enregistré : le formulaire est rempli, l'utilisateur vérifie puis valide.
 */
export interface ObservationAssistReply {
  /** « ai » : un modèle a lu la phrase. « direct » : lecture par règles fixes, sans IA. Toujours annoncé. */
  mode: 'direct' | 'ai';
  provider: string | null;
  notice: string;
  /** Les champs proposés, avec leur statut (dit, proposé, à confirmer, manquant). */
  result: ToolResult<ObservationDraftData>;
  /** Réponse de l'assistant dans le volet : ce qui a été rempli, ce qui reste à indiquer. Composée par le serveur à partir des champs. */
  reply: string;
  /** La phrase nomme un autre animal que celui du formulaire : rien n'est changé pour l'animal, et c'est dit. */
  otherAnimal: string | null;
}

/** État de la voix en baoulé sur ce serveur. `validated` : les phrases dites ont-elles été validées par un locuteur ? */
export interface BaouleStatus {
  /** La voix en baoulé est-elle activée sur ce serveur (BAOULE_VOICE=on) ? Activée ne veut pas dire disponible : le service local de parole doit répondre. */
  enabled: boolean;
  available: boolean;
  reason: string | null;
  validated: boolean;
  /** Nombre de formulations enregistrées par un locuteur, qui servent de points de comparaison. */
  examples: number;
  /** Moteur d'écoute chargé par le service local (« rapide » ou « origine »), tel qu'il le déclare ; null s'il ne le dit pas. */
  engine?: string | null;
}
export type BaouleIntent = 'situation' | 'changes' | 'missing' | 'beacons';
/**
 * Réponse à une note vocale en baoulé. Les faits sont dans `reply` (lecture des données, en français, avec ses preuves) ;
 * `spoken` est le texte baoulé dit à voix haute, composé de gabarits fixes et de nombres écrits par règle ; `spokenFr` en donne
 * le sens en français. `heard` est une transcription automatique, à ne pas prendre pour les mots exacts de la personne.
 */
export interface BaouleReply {
  heard: string;
  intent: BaouleIntent | 'unknown';
  /** Ressemblance avec la question retenue, de 0 à 1. */
  score: number;
  /** Question française à laquelle la note vocale a été rapprochée ; null si elle n'a pas été reconnue. */
  question: string | null;
  reply: AssistantReply;
  spoken: string;
  spokenFr: string;
  /**
   * Réponse dite en baoulé (WAV, base64). Null si la voix a échoué (rien n'a alors été dit), ou si elle a été demandée en
   * deux temps : `voiceId` permet alors de récupérer le son (`GET /api/assistant/baoule/voix/:id`).
   */
  audio: string | null;
  voiceId?: string | null;
  /** « voice » : question dite en baoulé puis rapprochée ; « choice » : question choisie (bouton, alerte, question en français). */
  via?: 'voice' | 'choice';
  /** Aucune parole dans l'enregistrement : rien n'a été transcrit. */
  silence?: boolean;
  validated: boolean;
  listenMs: number;
  speakMs: number;
}

/** Résultat d'une dictée : le texte transcrit, à vérifier par l'utilisateur avant envoi. L'audio n'est pas conservé. */
export interface TranscriptionReply {
  text: string;
  provider: string;
  notice: string;
}

/**
 * Réponse de la zone « Parler à mon élevage ».
 * - mode « direct » : la phrase a été reconnue par des règles fixes et les données ont été lues directement, SANS IA.
 * - mode « ai » : un modèle a choisi les fonctions à appeler et a formulé `text` ; les faits restent dans `results`.
 */
export interface AssistantReply {
  mode: 'direct' | 'ai';
  provider: string | null;
  intent: 'situation' | 'changes' | 'why_changed' | 'why_shown' | 'animal' | 'missing' | 'beacons' | 'incident' | 'draft' | 'unknown' | 'ai';
  /** Texte formulé par le modèle (mode « ai » uniquement). */
  text: string | null;
  /** Comment la réponse a été produite. Toujours affiché. */
  notice: string;
  results: ToolResult[];
  /** Vrai si le texte de l'IA ne s'appuie sur aucune lecture de données : à présenter comme une suggestion. */
  ungrounded: boolean;
  suggestions: string[];
  /** Conversation en direct : `text` est la transcription automatique de ce que le modèle a dit à voix haute. */
  live?: boolean;
}

/**
 * Normalise un identifiant d'animal dicté ou tapé vite : « b 017 », « B017 », « b-017 » donnent « B-017 ».
 * Ne devine rien : si la forme n'est pas lettres + chiffres, le texte est seulement mis en majuscules et nettoyé.
 */
export function normalizeAnimalQuery(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/[\s_.]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const m = /^([A-Z]{1,4})-?(\d{1,6})$/.exec(s);
  return m ? `${m[1]}-${m[2]}` : s;
}

/** Clé de comparaison tolérante (casse, espaces, tirets, zéros de tête) : « B-17 » et « b 017 » sont rapprochés. */
export function animalMatchKey(raw: string): string {
  const n = normalizeAnimalQuery(raw);
  const m = /^([A-Z]{1,4})-(\d{1,6})$/.exec(n);
  return m ? `${m[1]}${Number(m[2])}` : n.replace(/-/g, '');
}

/** Extrait d'une phrase les identifiants plausibles (« montre-moi b 017 » donne ["B-017"]). */
export function extractAnimalIds(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.toUpperCase().matchAll(/(?:^|[^A-Z0-9])([A-Z]{1,3})[\s-]?(\d{2,6})(?![A-Z0-9])/g)) out.add(`${m[1]}-${m[2]}`);
  return [...out];
}
