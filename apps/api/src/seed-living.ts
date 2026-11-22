import type { Queryable } from './db.js';

/**
 * Couche « vivante » du jeu de démonstration : données ENTIÈREMENT SYNTHÉTIQUES, déterministes,
 * dont les dates sont RELATIVES au jour de la réinitialisation (J). Ainsi « depuis hier » reste vrai le jour de la démonstration.
 * Le scénario de référence B-017 (mars 2026) n'est pas modifié : aucun enregistrement ci-dessous ne concerne B-017.
 */
const DAY_MS = 86_400_000;
export const LIVING_ANIMALS = ['B-071', 'B-072', 'B-073'] as const;
export const LIVING_OBSERVATION_IDS = {
  waterRefusal: '0a000000-0000-4000-8000-000000000001',
  appetite: '0a000000-0000-4000-8000-000000000002',
  gait: '0a000000-0000-4000-8000-000000000003',
} as const;
export const FARMER_ID = 'U-ELEVEUR';

export async function seedLiving(q: Queryable, orgId: string, now: Date): Promise<void> {
  const day0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()); // Africa/Abidjan = UTC
  const at = (offsetDays: number, hhmm: string) => new Date(day0 + offsetDays * DAY_MS + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))) * 60_000).toISOString();
  const date = (offsetDays: number) => new Date(day0 + offsetDays * DAY_MS).toISOString().slice(0, 10);
  const src = 'registre élevage (fictif)';

  for (const id of LIVING_ANIMALS) await q.query('INSERT INTO animals(id, org_id, tag) VALUES ($1,$2,$3)', [id, orgId, id]);

  const rec = (id: string, rev: number, kind: 'presence' | 'movement', data: object, recordedAt: string, reason: string, author: string | null = null) =>
    q.query('INSERT INTO record_revisions(record_id, rev, org_id, kind, data, author_id, reason, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
      id,
      rev,
      orgId,
      kind,
      JSON.stringify({ kind, ...data }),
      author,
      reason,
      recordedAt,
    ]);

  // Il y a 20 jours : trois animaux enregistrés à l'Élevage C (début de présence connu au jour près, ou inconnu).
  const initial = 'import initial du jeu synthétique';
  await rec('P7', 1, 'presence', { animalId: 'B-071', locationId: 'C', start: { precision: 'DAY', date: date(-20) }, end: null, verification: 'DECLARED', source: src }, at(-20, '10:00'), initial);
  await rec('P8', 1, 'presence', { animalId: 'B-072', locationId: 'C', start: { precision: 'DAY', date: date(-20) }, end: null, verification: 'DECLARED', source: src }, at(-20, '10:00'), initial);
  await rec('P9', 1, 'presence', { animalId: 'B-073', locationId: 'C', start: { precision: 'UNKNOWN' }, end: null, verification: 'DECLARED', source: src }, at(-20, '10:00'), initial);

  // Hier : B-072 quitte l'Élevage C pour l'Élevage A. La présence P8 est corrigée (révision 2), le déplacement et la nouvelle présence sont ajoutés.
  await rec(
    'P8',
    2,
    'presence',
    {
      animalId: 'B-072',
      locationId: 'C',
      start: { precision: 'DAY', date: date(-20) },
      end: { precision: 'INSTANT', at: at(-1, '06:30') },
      verification: 'DECLARED',
      source: 'Éleveur (démo)',
      revisionNote: 'départ vers l’Élevage A',
    },
    at(-1, '11:15'),
    'départ vers l’Élevage A, registre élevage (fictif)',
    FARMER_ID,
  );
  await rec(
    'MV7',
    1,
    'movement',
    {
      animalId: 'B-072',
      fromLocationId: 'C',
      toLocationId: 'A',
      departure: { precision: 'INSTANT', at: at(-1, '06:30') },
      arrival: { precision: 'INSTANT', at: at(-1, '08:10') },
      verification: 'DECLARED',
      source: src,
    },
    at(-1, '11:16'),
    'saisie du registre (fictif)',
    FARMER_ID,
  );
  await rec('P10', 1, 'presence', { animalId: 'B-072', locationId: 'A', start: { precision: 'INSTANT', at: at(-1, '08:10') }, end: null, verification: 'DECLARED', source: src }, at(-1, '11:17'), 'saisie du registre (fictif)', FARMER_ID);

  const obs = (id: string, animalId: string, locationId: string, eventTime: object, note: string, device: string, received: string) =>
    q.query(
      `INSERT INTO observations(id, idempotency_key, payload_version, org_id, animal_id, location_id, event_time, note, author_id, recorded_at_client, received_at)
       VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, id.replace(/^0a/, '0b'), orgId, animalId, locationId, JSON.stringify(eventTime), note, FARMER_ID, device, received],
    );
  await obs(LIVING_OBSERVATION_IDS.waterRefusal, 'B-073', 'C', { precision: 'DAY', date: date(-3) }, 'A refusé l’abreuvoir pendant la matinée, a bu en fin de journée.', at(-3, '18:20'), at(-3, '18:21'));
  await obs(LIVING_OBSERVATION_IDS.appetite, 'B-044', 'D', { precision: 'INSTANT', at: at(-1, '07:40') }, 'Mange moins que d’habitude ce matin, reste à l’écart du groupe.', at(-1, '07:52'), at(-1, '07:53'));
  await obs(LIVING_OBSERVATION_IDS.gait, 'B-071', 'C', { precision: 'DAY', date: date(-1) }, 'Boite légèrement à la marche.', at(-1, '17:02'), at(-1, '17:05'));
}
