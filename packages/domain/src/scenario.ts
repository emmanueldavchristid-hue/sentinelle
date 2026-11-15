/**
 * Scénario de référence B-017 — données ENTIÈREMENT SYNTHÉTIQUES.
 * Source de vérité : docs/DOMAIN.md §5. Toute modification doit y être reportée.
 */
import type { AnalysisParams, DataSnapshot, Presence } from './engine.js';

const t = (dayTime: string) => `2026-${dayTime}:00Z`; // ex. t('03-01T08:00')

export const REFERENCE_SCENARIO: DataSnapshot = {
  animals: [
    { id: 'B-017', tag: 'B-017' },
    { id: 'B-031', tag: 'B-031' },
    { id: 'B-044', tag: 'B-044' },
    { id: 'B-052', tag: 'B-052' },
    { id: 'B-060', tag: 'B-060' },
  ],
  locations: [
    { id: 'A', code: 'A', name: 'Élevage A', kind: 'FARM', position: { x: 10, y: 50 } },
    { id: 'M', code: 'M', name: 'Marché M', kind: 'MARKET', position: { x: 42, y: 50 } },
    { id: 'C', code: 'C', name: 'Élevage C', kind: 'FARM', position: { x: 78, y: 50 } },
    { id: 'D', code: 'D', name: 'Élevage D', kind: 'FARM', position: { x: 70, y: 85 } },
    { id: 'E', code: 'E', name: 'Élevage E', kind: 'FARM', position: { x: 90, y: 85 } },
  ],
  presences: [
    { kind: 'presence', id: 'P1', rev: 1, animalId: 'B-017', locationId: 'A', start: { precision: 'UNKNOWN' }, end: { precision: 'INSTANT', at: t('03-01T06:00') }, verification: 'DECLARED', source: 'registre élevage (fictif)' },
    { kind: 'presence', id: 'P2', rev: 1, animalId: 'B-017', locationId: 'M', start: { precision: 'INSTANT', at: t('03-01T08:00') }, end: { precision: 'INSTANT', at: t('03-01T16:00') }, verification: 'DECLARED', source: 'registre marché (fictif)' },
    { kind: 'presence', id: 'P3', rev: 1, animalId: 'B-017', locationId: 'C', start: { precision: 'INSTANT', at: t('03-01T18:00') }, end: null, verification: 'DECLARED', source: 'registre élevage (fictif)' },
    { kind: 'presence', id: 'P4', rev: 1, animalId: 'B-031', locationId: 'M', start: { precision: 'INSTANT', at: t('03-01T10:00') }, end: { precision: 'INSTANT', at: t('03-01T14:00') }, verification: 'DECLARED', source: 'registre marché (fictif)' },
    { kind: 'presence', id: 'P5', rev: 1, animalId: 'B-044', locationId: 'M', start: { precision: 'INSTANT', at: t('03-01T16:30') }, end: { precision: 'INSTANT', at: t('03-01T17:30') }, verification: 'DECLARED', source: 'registre marché (fictif)' },
    { kind: 'presence', id: 'P6', rev: 1, animalId: 'B-052', locationId: 'M', start: { precision: 'DAY', date: '2026-03-01' }, end: { precision: 'DAY', date: '2026-03-01' }, verification: 'DECLARED', source: 'registre marché (fictif)' },
  ],
  movements: [
    { kind: 'movement', id: 'MV1', rev: 1, animalId: 'B-017', fromLocationId: 'A', toLocationId: 'M', departure: { precision: 'INSTANT', at: t('03-01T06:00') }, arrival: { precision: 'INSTANT', at: t('03-01T08:00') }, verification: 'DECLARED', source: 'registre élevage (fictif)' },
    { kind: 'movement', id: 'MV2', rev: 1, animalId: 'B-017', fromLocationId: 'M', toLocationId: 'C', departure: { precision: 'INSTANT', at: t('03-01T16:00') }, arrival: { precision: 'INSTANT', at: t('03-01T18:00') }, verification: 'DECLARED', source: 'registre marché (fictif)' },
    { kind: 'movement', id: 'MV3', rev: 1, animalId: 'B-031', fromLocationId: 'M', toLocationId: 'D', departure: { precision: 'INSTANT', at: t('03-01T14:00') }, arrival: { precision: 'INSTANT', at: t('03-01T17:00') }, verification: 'DECLARED', source: 'registre marché (fictif)' },
    { kind: 'movement', id: 'MV4', rev: 1, animalId: 'B-044', fromLocationId: 'M', toLocationId: 'D', departure: { precision: 'INSTANT', at: t('03-01T17:30') }, arrival: { precision: 'INSTANT', at: t('03-01T19:00') }, verification: 'DECLARED', source: 'registre marché (fictif)' },
    { kind: 'movement', id: 'MV5', rev: 1, animalId: 'B-052', fromLocationId: 'M', toLocationId: 'D', departure: { precision: 'DAY', date: '2026-03-01' }, arrival: { precision: 'INSTANT', at: t('03-01T20:00') }, verification: 'DECLARED', source: 'registre marché (fictif)' },
    { kind: 'movement', id: 'MV6', rev: 1, animalId: 'B-060', fromLocationId: 'D', toLocationId: 'M', departure: { precision: 'INSTANT', at: t('03-01T09:00') }, arrival: { precision: 'INSTANT', at: t('03-01T07:00') }, verification: 'DECLARED', source: 'registre élevage (fictif)' },
  ],
};

/** Observation de référence (créée en direct pendant la démonstration). */
export const REFERENCE_OBSERVATION = {
  animalId: 'B-017',
  locationId: 'C',
  eventTime: { precision: 'INSTANT', at: t('03-12T07:30') } as const,
  note: 'Baisse d’appétit constatée ce matin.',
};

export const REFERENCE_PARAMS: AnalysisParams = {
  subjectAnimalId: 'B-017',
  window: { from: t('02-25T00:00'), to: t('03-13T00:00') },
  rules: ['R-B1'],
  maxDepth: 2,
  maxResults: 200,
  minOverlapMinutes: 0,
};

/** Correction de référence (révision 2 de P6). */
export const REFERENCE_CORRECTION: Pick<Presence, 'start' | 'end' | 'verification' | 'revisionNote'> = {
  start: { precision: 'INSTANT', at: t('03-01T11:00') },
  end: { precision: 'INSTANT', at: t('03-01T15:00') },
  verification: 'DECLARED',
  revisionNote: 'heures précisées par un agent',
};

/** Fenêtre proposée par défaut : 15 jours avant l'observation, jusqu'au lendemain. Modifiable ; pas une durée sanitaire. */
export function defaultWindow(observationIso: string): { from: string; to: string } {
  const d = new Date(observationIso);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { from: new Date(day - 15 * 86_400_000).toISOString(), to: new Date(day + 86_400_000).toISOString() };
}
