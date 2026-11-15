/**
 * Représentation explicite du temps et de son incertitude.
 * Stockage : instants UTC ISO 8601 ; jours civils Africa/Abidjan (UTC+0, sans heure d'été).
 * Aucune heure n'est jamais supposée pour une valeur de précision DAY ou UNKNOWN.
 */
export type TemporalValue =
  | { precision: 'INSTANT'; at: string }
  | { precision: 'DAY'; date: string }
  | { precision: 'INTERVAL'; from: string; to: string }
  | { precision: 'UNKNOWN' };

export const DISPLAY_TIME_ZONE = 'Africa/Abidjan';

/** Décalage d'Africa/Abidjan par rapport à UTC, en minutes. Documenté : 0 (pas d'heure d'été). */
const ABIDJAN_OFFSET_MINUTES = 0;

export const NEG_INF = Number.NEGATIVE_INFINITY;
export const POS_INF = Number.POSITIVE_INFINITY;

const DAY_MS = 86_400_000;

function parseInstant(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`Instant invalide : ${iso}`);
  return t;
}

/** Début du jour civil (Africa/Abidjan) en millisecondes UTC. */
export function dayStart(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Date invalide : ${date}`);
  return Date.parse(`${date}T00:00:00Z`) - ABIDJAN_OFFSET_MINUTES * 60_000;
}

/** Bornes [min, max] possibles de l'événement. Pour DAY : [00:00, 24:00) du jour, sans heure supposée. */
export function bounds(v: TemporalValue): { min: number; max: number } {
  switch (v.precision) {
    case 'INSTANT': {
      const t = parseInstant(v.at);
      return { min: t, max: t };
    }
    case 'DAY': {
      const s = dayStart(v.date);
      return { min: s, max: s + DAY_MS };
    }
    case 'INTERVAL': {
      const a = parseInstant(v.from);
      const b = parseInstant(v.to);
      if (b < a) throw new Error('Intervalle inversé');
      return { min: a, max: b };
    }
    case 'UNKNOWN':
      return { min: NEG_INF, max: POS_INF };
  }
}

/** Bornes possibles d'une présence [début, fin). `end === null` : toujours présent (fin ouverte). */
export interface PresenceBounds {
  startMin: number;
  startMax: number;
  endMin: number;
  endMax: number;
}

export function presenceBounds(start: TemporalValue, end: TemporalValue | null): PresenceBounds {
  const s = bounds(start);
  const e = end === null ? { min: POS_INF, max: POS_INF } : bounds(end);
  // Contrainte début ≤ fin : resserre les bornes sans rien inventer.
  return {
    startMin: s.min,
    startMax: Math.min(s.max, e.max),
    endMin: Math.max(e.min, s.min),
    endMax: e.max,
  };
}

/** Restreint les bornes à la fenêtre d'enquête [from, to). */
export function clipToWindow(b: PresenceBounds, from: number, to: number): PresenceBounds {
  const c = (x: number) => Math.min(Math.max(x, from), to);
  return { startMin: c(b.startMin), startMax: c(b.startMax), endMin: c(b.endMin), endMax: c(b.endMax) };
}

export type OverlapVerdict =
  | { kind: 'CERTAIN'; from: number; to: number }
  | { kind: 'EXCLUDED' }
  | { kind: 'UNDETERMINED' };

/**
 * Règle R-B1 (démonstration, à valider) — intervalles semi-ouverts [début, fin) :
 * - chevauchement certain si max(startMax) < min(endMin) (avec durée minimale optionnelle) ;
 * - absence certaine si P.endMax ≤ Q.startMin ou Q.endMax ≤ P.startMin ;
 * - sinon indéterminé.
 */
export function evaluateOverlap(p: PresenceBounds, q: PresenceBounds, minOverlapMs = 0): OverlapVerdict {
  const latestStart = Math.max(p.startMax, q.startMax);
  const earliestEnd = Math.min(p.endMin, q.endMin);
  if (latestStart < earliestEnd && earliestEnd - latestStart >= minOverlapMs) {
    return { kind: 'CERTAIN', from: latestStart, to: earliestEnd };
  }
  if (p.endMax <= q.startMin || q.endMax <= p.startMin) return { kind: 'EXCLUDED' };
  // Durée minimale non atteinte même dans le meilleur cas → exclu ; sinon indéterminé.
  const bestOverlap = Math.min(p.endMax, q.endMax) - Math.max(p.startMin, q.startMin);
  if (minOverlapMs > 0 && bestOverlap < minOverlapMs) return { kind: 'EXCLUDED' };
  return { kind: 'UNDETERMINED' };
}

const fmt = new Intl.DateTimeFormat('fr-FR', {
  timeZone: DISPLAY_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const fmtDay = new Intl.DateTimeFormat('fr-FR', { timeZone: DISPLAY_TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('fr-FR', { timeZone: DISPLAY_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false });

export function formatInstant(ms: number): string {
  if (!Number.isFinite(ms)) return ms < 0 ? 'début inconnu' : 'en cours';
  return fmt.format(new Date(ms)).replace(',', '');
}
export function formatTime(ms: number): string {
  return Number.isFinite(ms) ? fmtTime.format(new Date(ms)) : '?';
}
export function formatDay(ms: number): string {
  return Number.isFinite(ms) ? fmtDay.format(new Date(ms)) : '?';
}

export function formatTemporal(v: TemporalValue | null): string {
  if (v === null) return 'en cours';
  switch (v.precision) {
    case 'INSTANT':
      return formatInstant(Date.parse(v.at));
    case 'DAY':
      return `${formatDay(dayStart(v.date))}, heure inconnue`;
    case 'INTERVAL':
      return `entre ${formatInstant(Date.parse(v.from))} et ${formatInstant(Date.parse(v.to))}`;
    case 'UNKNOWN':
      return 'date inconnue';
  }
}

export function precisionLabel(v: TemporalValue | null): string {
  if (v === null) return 'ouverte';
  return { INSTANT: 'date et heure', DAY: 'jour seulement', INTERVAL: 'intervalle', UNKNOWN: 'inconnue' }[v.precision];
}
