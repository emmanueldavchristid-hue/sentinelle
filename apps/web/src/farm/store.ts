import { useSyncExternalStore } from 'react';
import type { AssistantReply, ChangesData, ObservationDraftData, ToolResult } from '@sentinelle/contracts';

/**
 * État de la conversation « Parler à mon élevage ».
 * Conservé en mémoire hors des composants : il survit à la navigation entre les pages, pas à la fermeture de l'onglet.
 * Aucune donnée n'est inventée ici : chaque échange garde la réponse du serveur telle qu'elle a été reçue.
 */
export interface Receipt {
  /** RECEIVED : le serveur a confirmé. QUEUED : enregistré sur l'appareil seulement. FAILED : refusé. */
  state: 'RECEIVED' | 'QUEUED' | 'FAILED';
  ref: string;
  receivedAt: string | null;
  duplicate: boolean;
  message: string;
}
export interface AnswerUpdate {
  previousAsOf: string;
  previousSummary: string;
  currentSummary: string;
}
export interface Exchange {
  id: string;
  question: string;
  askedAt: string;
  pending: boolean;
  error: string | null;
  /** Hors connexion au moment de la question. */
  offline: boolean;
  reply: AssistantReply | null;
  /** Clé de la question (même fonction, mêmes paramètres) : sert à repérer une réponse mise à jour. */
  key: string | null;
  update: AnswerUpdate | null;
  /** Comparaison affichée pour « Pourquoi ta réponse a changé ? ». */
  compared: { from: string; to: string; before: string; after: string } | null;
  draft: 'open' | 'saving' | 'confirmed' | 'discarded' | null;
  receipt: Receipt | null;
}

let exchanges: Exchange[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const conversation = {
  get: () => exchanges,
  subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
  add(e: Exchange) {
    exchanges = [e, ...exchanges].slice(0, 30);
    emit();
  },
  patch(id: string, p: Partial<Exchange>) {
    exchanges = exchanges.map((e) => (e.id === id ? { ...e, ...p } : e));
    emit();
  },
  clear() {
    exchanges = [];
    emit();
  },
};
export const useExchanges = () => useSyncExternalStore(conversation.subscribe, conversation.get);

/** Enregistrements confirmés pendant cette session : marqués « nouveau » dans la constellation et la chronologie. */
let fresh: ReadonlySet<string> = new Set();
/** Compteur d'écritures confirmées : chaque écran qui lit des données se recharge quand il change. */
let writes = 0;
export const session = {
  fresh: () => fresh,
  writes: () => writes,
  subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
  markWritten(ref: string) {
    fresh = new Set([...fresh, ref]);
    writes++;
    emit();
  },
  reset() {
    fresh = new Set();
    emit();
  },
};
export const useFresh = () => useSyncExternalStore(session.subscribe, session.fresh);
export const useWrites = () => useSyncExternalStore(session.subscribe, session.writes);

/** Clé stable d'une lecture : la même question posée deux fois donne la même clé. */
export function resultKey(r: ToolResult): string | null {
  switch (r.tool) {
    case 'situation':
    case 'missing':
      return r.tool;
    case 'changes':
      return r.params.sinceYesterday ? 'changes:depuis-hier' : null;
    case 'animal':
      return `animal:${String(r.params.animalId)}`;
    default:
      return null;
  }
}

/** Résumé court d'une lecture, pour dire ce qui a changé entre deux réponses. */
export function resultSummary(r: ToolResult): string {
  if (r.tool === 'changes') {
    const c = (r as ToolResult<ChangesData>).data.counts;
    return `${c.total} enregistrement${c.total > 1 ? 's' : ''} (${c.added} ajout${c.added > 1 ? 's' : ''}, ${c.corrected} correction${c.corrected > 1 ? 's' : ''}, ${c.tasks} tâche${c.tasks > 1 ? 's' : ''})`;
  }
  return r.statements.find((s) => s.nature !== 'SUGGESTION')?.text ?? '';
}

/** Empreinte du contenu d'une lecture (hors instant de lecture) : deux empreintes différentes = réponse différente. */
export function resultDigest(r: ToolResult): string {
  return JSON.stringify([r.statements.map((s) => [s.nature, s.text]), r.sources.map((s) => s.ref)]);
}

export const firstResult = (e: Exchange): ToolResult | null => e.reply?.results[0] ?? null;
export const draftOf = (e: Exchange): ToolResult<ObservationDraftData> | null => {
  const r = e.reply?.results.find((x) => x.tool === 'prepare_observation');
  return r ? (r as ToolResult<ObservationDraftData>) : null;
};

/** Références d'événements citées par une réponse : mises en évidence dans la constellation et la chronologie. */
export function refsOf(reply: AssistantReply | null): string[] {
  if (!reply) return [];
  return [...new Set(reply.results.flatMap((r) => r.sources.map((s) => s.ref)))];
}

/**
 * Affichage simple (par défaut) ou détaillé. Le mode simple n'enlève aucun contrôle : les natures d'information, les sources,
 * les dates et les limites restent à un clic (« Détails et preuves »). Le mode détaillé les montre d'emblée.
 */
const DISPLAY_KEY = 'sentinelle.affichage';
let detailed = (() => {
  try {
    return localStorage.getItem(DISPLAY_KEY) === 'detail';
  } catch {
    return false;
  }
})();
export const display = {
  detailed: () => detailed,
  subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
  set(on: boolean) {
    detailed = on;
    try {
      localStorage.setItem(DISPLAY_KEY, on ? 'detail' : 'simple');
    } catch {
      /* préférence valable pour cette page seulement */
    }
    emit();
  },
};
export const useDetailed = () => useSyncExternalStore(display.subscribe, display.detailed);
