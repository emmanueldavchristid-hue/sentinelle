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

export type FarmToolName = 'situation' | 'changes' | 'find_animal' | 'animal' | 'missing' | 'source' | 'prepare_observation';

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
  kind: 'observation' | 'record' | 'task' | 'animal' | 'site';
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

/** État de l'assistant IA, tel que le serveur le connaît. Aucune valeur secrète. */
export interface AssistantStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
  /** Pourquoi l'assistant IA n'est pas disponible, en clair. */
  reason: string | null;
  /** Dictée : le serveur peut-il transcrire un enregistrement, et quelle durée maximale accepte-t-il ? */
  voice?: { available: boolean; maxSeconds: number };
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
  intent: 'situation' | 'changes' | 'why_changed' | 'why_shown' | 'animal' | 'missing' | 'draft' | 'unknown' | 'ai';
  /** Texte formulé par le modèle (mode « ai » uniquement). */
  text: string | null;
  /** Comment la réponse a été produite. Toujours affiché. */
  notice: string;
  results: ToolResult[];
  /** Vrai si le texte de l'IA ne s'appuie sur aucune lecture de données : à présenter comme une suggestion. */
  ungrounded: boolean;
  suggestions: string[];
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
