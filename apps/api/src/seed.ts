import { randomUUID } from 'node:crypto';
import { REFERENCE_OBSERVATION, REFERENCE_SCENARIO } from '@sentinelle/domain';
import type { Db } from './db.js';
import { seedLiving } from './seed-living.js';

export const DEMO_ORG = 'ORG-DEMO';
export const OTHER_ORG = 'ORG-AUTRE';

export const DEMO_USERS = [
  { id: 'U-ELEVEUR', org: DEMO_ORG, name: 'Éleveur (démo)', role: 'FARMER' },
  { id: 'U-AGENT', org: DEMO_ORG, name: 'Agent de terrain (démo)', role: 'AGENT' },
  { id: 'U-VET', org: DEMO_ORG, name: 'Vétérinaire enquêteur (démo)', role: 'VET' },
  { id: 'U-VET-AUTRE', org: OTHER_ORG, name: 'Vétérinaire, autre organisation (démo)', role: 'VET' },
] as const;

const TABLES = [
  'device_incidents',
  'device_readings',
  'devices',
  'sessions',
  'import_batches',
  'audit_events',
  'idempotent_ops',
  'verification_tasks',
  'analysis_summaries',
  'analysis_runs',
  'investigations',
  'observations',
  'record_revisions',
  'animals',
  'locations',
  'users',
  'organizations',
];

/** Réinitialise toutes les données (destructif — réservé au mode démonstration) puis charge le scénario B-017. */
export async function resetAndSeed(db: Db, opts: { withObservation?: boolean; living?: boolean; now?: Date } = {}): Promise<void> {
  await db.tx(async (q) => {
    for (const t of TABLES) await q.query(`DELETE FROM ${t}`);
    await q.query('INSERT INTO organizations(id, name) VALUES ($1, $2), ($3, $4)', [
      DEMO_ORG,
      'Organisation de démonstration',
      OTHER_ORG,
      'Autre organisation (test d’isolation)',
    ]);
    for (const u of DEMO_USERS) await q.query('INSERT INTO users(id, org_id, name, role) VALUES ($1,$2,$3,$4)', [u.id, u.org, u.name, u.role]);
    for (const l of REFERENCE_SCENARIO.locations) {
      await q.query('INSERT INTO locations(id, org_id, code, name, kind, pos_x, pos_y) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
        l.id,
        DEMO_ORG,
        l.code,
        l.name,
        l.kind,
        l.position?.x ?? null,
        l.position?.y ?? null,
      ]);
    }
    await q.query('INSERT INTO locations(id, org_id, code, name, kind) VALUES ($1,$2,$3,$4,$5)', ['Z', OTHER_ORG, 'Z', 'Élevage Z (autre organisation)', 'FARM']);
    for (const a of REFERENCE_SCENARIO.animals) await q.query('INSERT INTO animals(id, org_id, tag) VALUES ($1,$2,$3)', [a.id, DEMO_ORG, a.tag]);
    await q.query('INSERT INTO animals(id, org_id, tag) VALUES ($1,$2,$3)', ['Z-001', OTHER_ORG, 'Z-001']);
    for (const r of [...REFERENCE_SCENARIO.presences, ...REFERENCE_SCENARIO.movements]) {
      const { id, rev, ...data } = r;
      await q.query(
        `INSERT INTO record_revisions(record_id, rev, org_id, kind, data, reason, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,'2026-03-02T09:00:00Z')`,
        [id, rev, DEMO_ORG, r.kind, JSON.stringify(data), 'import initial du jeu synthétique'],
      );
    }
    if (opts.withObservation) {
      const id = randomUUID();
      await q.query(
        `INSERT INTO observations(id, idempotency_key, payload_version, org_id, animal_id, location_id, event_time, note, author_id, recorded_at_client)
         VALUES ($1,$2,1,$3,$4,$5,$6,$7,'U-AGENT',$8)`,
        [id, randomUUID(), DEMO_ORG, REFERENCE_OBSERVATION.animalId, REFERENCE_OBSERVATION.locationId, JSON.stringify(REFERENCE_OBSERVATION.eventTime), REFERENCE_OBSERVATION.note, '2026-03-12T07:45:00Z'],
      );
    }
    // Couche d'événements récents, datés relativement au jour de la réinitialisation (« depuis hier » reste vrai).
    if (opts.living) await seedLiving(q, DEMO_ORG, opts.now ?? new Date());
    await q.query('INSERT INTO audit_events(org_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)', [
      DEMO_ORG,
      'DEMO_RESET',
      'database',
      'all',
      JSON.stringify({ withObservation: !!opts.withObservation, living: !!opts.living }),
    ]);
  });
}
