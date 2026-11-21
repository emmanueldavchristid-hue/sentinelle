import { openTestDb } from './helpers.js';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REFERENCE_CORRECTION, REFERENCE_OBSERVATION, REFERENCE_PARAMS } from '@sentinelle/domain';
import { buildApp } from '../src/app.js';
import { type Db, migrate } from '../src/db.js';
import { resetAndSeed } from '../src/seed.js';

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
const AGENT = { 'x-demo-user': 'U-AGENT' };
const VET = { 'x-demo-user': 'U-VET' };
const OTHER_VET = { 'x-demo-user': 'U-VET-AUTRE' };

const obsPayload = (over: Record<string, unknown> = {}) => ({
  payloadVersion: 1,
  clientId: randomUUID(),
  idempotencyKey: randomUUID(),
  animalId: REFERENCE_OBSERVATION.animalId,
  locationId: REFERENCE_OBSERVATION.locationId,
  eventTime: REFERENCE_OBSERVATION.eventTime,
  note: REFERENCE_OBSERVATION.note,
  recordedAtClient: '2026-03-12T07:45:00.000Z',
  ...over,
});

beforeAll(async () => {
  db = await openTestDb();
  await migrate(db);
  await resetAndSeed(db);
  app = await buildApp({ db, demoMode: true });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe('Parcours principal de bout en bout (API)', () => {
  let obsId = '';
  let invId = '';

  it('synchronise une observation (201), puis l’enquêteur la voit comme signalement', async () => {
    const p = obsPayload();
    const r = await app.inject({ method: 'POST', url: '/api/sync/observations', headers: AGENT, payload: p });
    expect(r.statusCode).toBe(201);
    obsId = r.json().observation.id;
    expect(obsId).toBe(p.clientId);
    const list = await app.inject({ url: '/api/observations', headers: VET });
    expect(list.json().map((o: { id: string }) => o.id)).toContain(obsId);
  });

  it('ouvre une enquête : analyse n° 1 avec 7 résultats et 2 tâches proposées', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/investigations', headers: VET, payload: { observationId: obsId, window: REFERENCE_PARAMS.window, maxDepth: 2 } });
    expect(r.statusCode).toBe(201);
    invId = r.json().id;
    const run1 = (await app.inject({ url: `/api/investigations/${invId}/runs/1`, headers: VET })).json();
    expect(run1.output.results.map((x: { key: string }) => x.key)).toEqual(['A|MV1', 'A|MV2', 'B|P2|P4', 'B2|P4|MV3', 'B|P2|P6', 'B|P2|P5', 'C|anomaly|MV6']);
    expect(run1.engineVersion).toBe('0.1.0');
    expect(run1.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run1.evidenceRecords.P6.rev).toBe(1);
    const inv = (await app.inject({ url: `/api/investigations/${invId}`, headers: VET })).json();
    expect(inv.tasks.map((t: { recordId: string }) => t.recordId).sort()).toEqual(['MV6', 'P6']);
  });

  it('ouvrir deux fois la même enquête ne crée pas de doublon', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/investigations', headers: VET, payload: { observationId: obsId, window: REFERENCE_PARAMS.window } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: invId, created: false });
  });

  it('demande la vérification de P6 ; l’agent corrige ; nouvelle analyse ; comparaison expliquée', async () => {
    const inv = (await app.inject({ url: `/api/investigations/${invId}`, headers: VET })).json();
    const task = inv.tasks.find((t: { recordId: string }) => t.recordId === 'P6');
    expect((await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/request`, headers: VET })).statusCode).toBe(200);
    const agentTasks = (await app.inject({ url: '/api/tasks', headers: AGENT })).json();
    expect(agentTasks.map((t: { recordId: string }) => t.recordId)).toEqual(['P6']);
    expect(agentTasks[0].record.rev).toBe(1);

    const fix = await app.inject({
      method: 'POST',
      url: '/api/records/P6/revisions',
      headers: AGENT,
      payload: { idempotencyKey: randomUUID(), baseRev: 1, start: REFERENCE_CORRECTION.start, end: REFERENCE_CORRECTION.end, reason: 'heures précisées par un agent' },
    });
    expect(fix.statusCode).toBe(201);
    expect(fix.json()).toMatchObject({ recordId: 'P6', rev: 2, previousRev: 1 });

    const rerun = await app.inject({ method: 'POST', url: `/api/investigations/${invId}/runs`, headers: VET, payload: { window: REFERENCE_PARAMS.window, maxDepth: 2 } });
    expect(rerun.statusCode).toBe(201);
    expect(rerun.json().seq).toBe(2);

    const cmp = (await app.inject({ url: `/api/investigations/${invId}/compare?a=1&b=2`, headers: VET })).json();
    expect(cmp.summary).toBe('1 résultat modifié, 1 ajouté, 0 retiré.');
    expect(cmp.changed[0].before.status).toBe('INSUFFICIENT_INFO');
    expect(cmp.changed[0].after.status).toBe('POTENTIAL_LINK');
    expect(cmp.added[0].key).toBe('B2|P6|MV5');
    expect(cmp.causes[0]).toMatch(/Révision 2 de P6/);

    // L'analyse n° 1 reste interprétable à partir de son instantané.
    const run1 = (await app.inject({ url: `/api/investigations/${invId}/runs/1`, headers: VET })).json();
    expect(run1.evidenceRecords.P6.rev).toBe(1);
    expect(run1.output.results.find((x: { key: string }) => x.key === 'B|P2|P6').status).toBe('INSUFFICIENT_INFO');
    const revs = (await app.inject({ url: '/api/records/P6/revisions', headers: VET })).json();
    expect(revs.map((r: { rev: number }) => r.rev)).toEqual([1, 2]);
    const done = (await app.inject({ url: `/api/investigations/${invId}`, headers: VET })).json();
    expect(done.tasks.find((t: { recordId: string }) => t.recordId === 'P6')).toMatchObject({ status: 'DONE', doneRev: 2 });
  });
});

describe('Synchronisation : idempotence et conflits', () => {
  it('SYN-04 double envoi : une seule ligne en base', async () => {
    const p = obsPayload();
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/sync/observations', headers: AGENT, payload: p }),
      app.inject({ method: 'POST', url: '/api/sync/observations', headers: AGENT, payload: p }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    const n = (await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM observations WHERE idempotency_key = $1', [p.idempotencyKey])).rows[0]!.n;
    expect(n).toBe(1);
  });

  it('SYN-05 réponse perdue puis renvoi : le serveur rend l’existant, sans doublon', async () => {
    const p = obsPayload();
    await app.inject({ method: 'POST', url: '/api/sync/observations', headers: AGENT, payload: p });
    const again = await app.inject({ method: 'POST', url: '/api/sync/observations', headers: AGENT, payload: p });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ duplicate: true, observation: { id: p.clientId } });
  });

  it('même identifiant client avec une autre clé : conflit 409', async () => {
    const p = obsPayload();
    await app.inject({ method: 'POST', url: '/api/sync/observations', headers: AGENT, payload: p });
    const r = await app.inject({ method: 'POST', url: '/api/sync/observations', headers: AGENT, payload: { ...p, idempotencyKey: randomUUID() } });
    expect(r.statusCode).toBe(409);
  });

  it('SYN-06 correction fondée sur une révision dépassée : 409, rien d’écrasé', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/records/P6/revisions',
      headers: AGENT,
      payload: { idempotencyKey: randomUUID(), baseRev: 1, start: { precision: 'INSTANT', at: '2026-03-01T06:00:00Z' }, end: { precision: 'INSTANT', at: '2026-03-01T07:00:00Z' }, reason: 'autre source' },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'CONFLICT', currentRev: 2 });
    const revs = (await db.query<{ rev: number }>("SELECT rev FROM record_revisions WHERE record_id = 'P6' ORDER BY rev")).rows.map((x) => x.rev);
    expect(revs).toEqual([1, 2]);
  });

  it('correction rejouée avec la même clé : pas de troisième révision', async () => {
    const key = randomUUID();
    const payload = { idempotencyKey: key, baseRev: 1, start: { precision: 'INSTANT', at: '2026-03-01T10:00:00Z' }, end: { precision: 'INSTANT', at: '2026-03-01T11:00:00Z' }, reason: 'test rejeu' };
    const a = await app.inject({ method: 'POST', url: '/api/records/P4/revisions', headers: AGENT, payload });
    const b = await app.inject({ method: 'POST', url: '/api/records/P4/revisions', headers: AGENT, payload });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().duplicate).toBe(true);
    const revs = (await db.query<{ rev: number }>("SELECT rev FROM record_revisions WHERE record_id = 'P4'")).rows;
    expect(revs).toHaveLength(2);
  });
});

describe('Sécurité (démonstration locale)', () => {
  it('sans rôle : 401', async () => {
    expect((await app.inject({ url: '/api/animals' })).statusCode).toBe(401);
  });

  it('SEC-01 un agent ne peut pas consulter les enquêtes : 403', async () => {
    expect((await app.inject({ url: '/api/investigations', headers: AGENT })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/observations', headers: AGENT })).statusCode).toBe(403);
  });

  it('isolation : un vétérinaire d’une autre organisation ne voit ni l’enquête ni l’animal', async () => {
    const invs = (await app.inject({ url: '/api/investigations', headers: VET })).json();
    const r = await app.inject({ url: `/api/investigations/${invs[0].id}`, headers: OTHER_VET });
    expect(r.statusCode).toBe(404);
    expect((await app.inject({ url: '/api/animals/B-017', headers: OTHER_VET })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/investigations', headers: OTHER_VET })).json()).toEqual([]);
  });

  it('SEC-02 validation serveur : champs invalides signalés par champ', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/sync/observations', headers: AGENT, payload: obsPayload({ note: 'x', eventTime: { precision: 'DAY', date: '12/03/2026' } }) });
    expect(r.statusCode).toBe(400);
    expect(Object.keys(r.json().fields).sort()).toEqual(['eventTime.date', 'note']);
    const r2 = await app.inject({ method: 'POST', url: '/api/sync/observations', headers: AGENT, payload: obsPayload({ animalId: 'Z-001' }) });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().fields.animalId).toMatch(/périmètre/);
    const r3 = await app.inject({ method: 'POST', url: '/api/records/P6/revisions', headers: AGENT, payload: { idempotencyKey: randomUUID(), baseRev: 2, start: { precision: 'INSTANT', at: '2026-03-01T15:00:00Z' }, end: { precision: 'INSTANT', at: '2026-03-01T11:00:00Z' }, reason: 'inversé' } });
    expect(r3.statusCode).toBe(400);
  });

  it('un vétérinaire ne corrige pas directement : 403 (correction réservée à l’agent)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/records/P6/revisions', headers: VET, payload: {} });
    expect(r.statusCode).toBe(403);
  });

  it('SEC-04 réinitialisation refusée hors mode démonstration', async () => {
    const strict = await buildApp({ db, demoMode: false });
    expect((await strict.inject({ method: 'POST', url: '/api/demo/reset' })).statusCode).toBe(403);
    await strict.close();
  });

  it('erreur interne sans fuite de détail', async () => {
    const r = await app.inject({ url: '/api/investigations/not-a-uuid', headers: VET });
    expect(r.statusCode).toBe(404);
    expect(JSON.stringify(r.json())).not.toMatch(/stack|sql|pglite/i);
  });

  it('SEC-03 aucun secret dans le dépôt versionnable', () => {
    const root = resolve(__dirname, '../../..');
    const skip = new Set(['node_modules', '.git', 'dist', 'data', 'test-results', 'playwright-report']);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        if (skip.has(f)) continue;
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/^\.env($|\.)/.test(f) && f !== '.env.example') offenders.push(p);
        else if (/\.(ts|tsx|js|json|yml|yaml|md|html)$/.test(f) && /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/.test(readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('Constats de la revue indépendante', () => {
  it('clé d’idempotence réutilisée avec un autre contenu : 409, aucune fausse réussite', async () => {
    const key = randomUUID();
    const base = { idempotencyKey: key, baseRev: 2, start: { precision: 'INSTANT', at: '2026-03-01T10:00:00Z' }, end: { precision: 'INSTANT', at: '2026-03-01T11:00:00Z' }, reason: 'première' };
    const cur = (await db.query<{ rev: number }>("SELECT MAX(rev)::int AS rev FROM record_revisions WHERE record_id = 'P5'")).rows[0]!.rev;
    const first = await app.inject({ method: 'POST', url: '/api/records/P5/revisions', headers: AGENT, payload: { ...base, baseRev: cur } });
    expect(first.statusCode).toBe(201);
    const other = await app.inject({ method: 'POST', url: '/api/records/P5/revisions', headers: AGENT, payload: { ...base, baseRev: cur, reason: 'contenu différent' } });
    expect(other.statusCode).toBe(409);
    expect(other.json().error).toBe('IDEMPOTENCY_CONFLICT');
    const elsewhere = await app.inject({ method: 'POST', url: '/api/records/P4/revisions', headers: AGENT, payload: { ...base, baseRev: cur } });
    expect(elsewhere.statusCode).toBe(409);
  });

  it('paramètres de requête invalides : 400 explicite, pas 500', async () => {
    expect((await app.inject({ url: `/api/animals?q=${'x'.repeat(50)}`, headers: VET })).statusCode).toBe(400);
    const invs = (await app.inject({ url: '/api/investigations', headers: VET })).json();
    expect((await app.inject({ url: `/api/investigations/${invs[0].id}/compare`, headers: VET })).statusCode).toBe(400);
  });

  it('rejeu d’une observation par un autre utilisateur : refusé', async () => {
    const p = obsPayload();
    expect((await app.inject({ method: 'POST', url: '/api/sync/observations', headers: AGENT, payload: p })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/sync/observations', headers: VET, payload: p })).statusCode).toBe(409);
  });
});

describe('Réinitialisation de démonstration', () => {
  it('remet le jeu B-017 à l’état initial, éventuellement avec le signalement', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/demo/reset', payload: { withObservation: true } })).statusCode).toBe(403); // en-tête manquant
    expect((await app.inject({ method: 'POST', url: '/api/demo/reset', headers: { 'x-sentinelle-demo': 'reset', origin: 'https://evil.example', host: 'localhost' }, payload: {} })).statusCode).toBe(403);
    const r = await app.inject({ method: 'POST', url: '/api/demo/reset', headers: { 'x-sentinelle-demo': 'reset' }, payload: { withObservation: true } });
    expect(r.statusCode).toBe(200);
    // Le signalement B-017 du scénario, plus les 3 observations du jeu vivant (datées relativement au jour de la réinitialisation).
    const afterReset = (await app.inject({ url: '/api/observations', headers: VET })).json() as { animalId: string }[];
    expect(afterReset.filter((o) => o.animalId === 'B-017')).toHaveLength(1);
    expect(afterReset).toHaveLength(4);
    const p6 = (await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM record_revisions WHERE record_id = 'P6'")).rows[0]!.n;
    expect(p6).toBe(1);
  });
});
