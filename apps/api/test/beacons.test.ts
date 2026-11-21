import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssistantReply, Beacon, BeaconsData, SituationData, SourceData, ToolResult } from '@sentinelle/contracts';
import { buildApp } from '../src/app.js';
import { recognize } from '../src/assistant.js';
import { zoneOf } from '../src/beacons.js';
import { type Db, migrate } from '../src/db.js';
import { resetAndSeed } from '../src/seed.js';
import { openTestDb } from './helpers.js';

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
const FARMER = { 'x-demo-user': 'U-ELEVEUR' };
const OTHER_VET = { 'x-demo-user': 'U-VET-AUTRE' };

beforeAll(async () => {
  db = await openTestDb();
  await migrate(db);
  await resetAndSeed(db, { living: true });
  app = await buildApp({ db, demoMode: true });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const pair = async (payload: Record<string, unknown> = { animalId: 'B-071' }, headers = FARMER) => app.inject({ method: 'POST', url: '/api/farm/devices', headers, payload });
const send = (id: string, token: string, reading: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/devices/${id}/readings`, headers: { 'x-device-token': token }, payload: { source: 'PHONE_GPS', observedAt: new Date().toISOString(), ...reading } });
const list = async (headers = FARMER) => (await app.inject({ url: '/api/farm/devices', headers })).json() as ToolResult<BeaconsData>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Statut d’une mesure : la précision compte', () => {
  it('hors zone seulement si le seuil est dépassé même avec la précision ; sinon incertain', () => {
    expect(zoneOf(62, 8, 30)).toBe('OUTSIDE');
    expect(zoneOf(12, 8, 30)).toBe('INSIDE');
    expect(zoneOf(35, 15, 30)).toBe('UNCERTAIN');
    expect(zoneOf(25, 15, 30)).toBe('UNCERTAIN');
    expect(zoneOf(null, null, 30)).toBe('NO_FIX');
    expect(zoneOf(31, null, 30)).toBe('OUTSIDE');
  });
});

describe('Balise de démonstration : association, mesures, alerte, preuve', () => {
  let id = '';
  let token = '';

  it('sans balise : le dit, et rappelle qu’aucun capteur n’est connecté', async () => {
    const r = await list();
    expect(r.tool).toBe('beacons');
    expect(r.data.beacons).toEqual([]);
    expect(r.statements[0]).toMatchObject({ nature: 'MISSING' });
    expect(r.statements[0]!.text).toMatch(/Aucun capteur n’est connecté/);
  });

  it('association à un animal : jeton rendu une seule fois, seul son hachage est stocké', async () => {
    expect((await pair({ animalId: 'X-999' })).statusCode).toBe(400);
    expect((await pair({ animalId: 'B-071', radiusM: 2 })).statusCode).toBe(400);
    const r = await pair({ animalId: 'b-071', radiusM: 30 });
    expect(r.statusCode).toBe(201);
    ({ id, token } = r.json());
    expect(id).toMatch(/^BAL-[0-9A-F]{4}$/);
    expect(token.length).toBeGreaterThan(20);
    const stored = (await db.query<{ token_hash: string }>('SELECT token_hash FROM devices WHERE id = $1', [id])).rows[0]!.token_hash;
    expect(stored).not.toBe(token);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    const before = await list();
    expect(before.data.beacons[0]).toMatchObject({ id, animalId: 'B-071', status: 'NEVER', latest: null });
    expect(before.statements.at(-1)!.text).toMatch(/aucune mesure reçue\. Cela ne dit rien de l’endroit/);
  });

  it('mesure refusée sans jeton valide, avec un mauvais format ou un instant incohérent', async () => {
    expect((await send(id, 'mauvais-jeton', { distanceM: 5, accuracyM: 3 })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/devices/${id}/readings`, payload: { source: 'PHONE_GPS', observedAt: new Date().toISOString(), distanceM: 5, accuracyM: 3 } })).statusCode).toBe(401);
    expect((await send(id, token, { distanceM: -4, accuracyM: 3 })).statusCode).toBe(400);
    expect((await send(id, token, { source: 'SATELLITE', distanceM: 4, accuracyM: 3 })).statusCode).toBe(400);
    expect((await send(id, token, { observedAt: '2020-01-01T00:00:00Z', distanceM: 4, accuracyM: 3 })).statusCode).toBe(400);
    expect((await send('BAL-ZZZZ', token, { distanceM: 4, accuracyM: 3 })).statusCode).toBe(401);
  });

  it('dans la zone, puis incertain, puis hors zone : le statut suit les mesures, avec leurs instants, unité, précision et source', async () => {
    const inside = await send(id, token, { distanceM: 6, accuracyM: 4 });
    expect(inside.statusCode).toBe(201);
    expect(inside.json()).toMatchObject({ accepted: true, zone: 'INSIDE', radiusM: 30 });
    expect((await send(id, token, { distanceM: 80, accuracyM: 4 })).statusCode).toBe(202); // une mesure par seconde au plus
    let r = await list();
    expect(r.data.beacons[0]).toMatchObject({ status: 'INSIDE', outsideSince: null });
    expect(r.data.alerts).toEqual([]);
    expect(r.statements[0]!.text).toMatch(/Aucune balise n’est hors de sa zone/);

    await wait(1000);
    expect((await send(id, token, { distanceM: 34, accuracyM: 12 })).json().zone).toBe('UNCERTAIN');
    r = await list();
    expect(r.data.beacons[0]!.status).toBe('UNCERTAIN');
    expect(r.data.alerts).toEqual([]);
    expect(r.statements.at(-1)!.text).toMatch(/la précision ne permet pas de dire si elle est dedans ou dehors/);

    await wait(1000);
    expect((await send(id, token, { distanceM: 62, accuracyM: 8 })).json().zone).toBe('OUTSIDE');
    r = await list();
    const b = r.data.beacons[0]!;
    expect(b).toMatchObject({ status: 'OUTSIDE', radiusM: 30 });
    expect(b.latest).toMatchObject({ source: 'PHONE_GPS', distanceM: 62, accuracyM: 8, zone: 'OUTSIDE' });
    expect(Date.parse(b.latest!.receivedAt)).toBeGreaterThanOrEqual(Date.parse(b.latest!.observedAt) - 2000);
    expect(b.outsideSince).toBe(b.latest!.observedAt);
    expect(r.data.alerts).toEqual([id]);
    expect(r.statements[0]!.text).toBe(`Une balise est hors de sa zone : ${id} (associée à B-071).`);
    expect(r.statements[1]!.text).toMatch(new RegExp(`^Balise de démonstration ${id}, associée à B-071 : HORS de la zone\\. 62 m du repère \\(précision ± 8 m\\), pour un seuil de 30 m`));
    expect(r.statements[1]!.text).toMatch(/source : GPS du téléphone/);
    expect(r.limits.join(' ')).toMatch(/ne mesure ni la position exacte ni l’état de l’animal/);
    expect(r.limits.join(' ')).not.toMatch(/SIMULÉES/);
  });

  it('question « quel animal s’est éloigné ? » : la réponse parle de la balise, cite sa source, et la preuve s’ouvre', async () => {
    expect(recognize('C’est quel animal qui s’est éloigné ?')).toBe('beacons');
    expect(recognize('Une balise est-elle sortie de la zone ?')).toBe('beacons');
    const reply = (await app.inject({ method: 'POST', url: '/api/assistant/ask', headers: FARMER, payload: { text: 'C’est quel animal qui s’est éloigné ?' } })).json() as AssistantReply;
    expect(reply).toMatchObject({ mode: 'direct', intent: 'beacons' });
    expect(reply.results[0]!.statements[0]!.text).toMatch(/associée à B-071/);
    expect(reply.results[0]!.statements[0]!.text).not.toMatch(/évad|s’est enfui/);
    const src = (await app.inject({ url: `/api/farm/sources?ref=DEVICE:${id}`, headers: FARMER })).json() as ToolResult<SourceData>;
    expect(src.data.kind).toBe('device');
    expect(src.data.fields.find((f) => f.label === 'Dispositif')!.value).toMatch(/téléphone, pas un capteur posé sur un animal/);
    expect(src.data.fields.find((f) => f.label === 'Dernière mesure')!.value).toMatch(/62 m ± 8 m · hors de la zone · observée .* · reçue .* · GPS du téléphone/);
    expect(src.data.fields.filter((f) => f.label.startsWith('Mesure précédente'))).toHaveLength(2);
  });

  it('mesure simulée : marquée comme telle dans la donnée, la phrase et les limites', async () => {
    await wait(1000);
    expect((await send(id, token, { source: 'SIMULATED', distanceM: 120, accuracyM: 50 })).json().zone).toBe('OUTSIDE');
    const r = await list();
    expect(r.data.simulated).toBe(true);
    expect(r.data.beacons[0]!.latest).toMatchObject({ source: 'SIMULATED', accuracyM: 0 });
    expect(r.limits[0]).toMatch(/^DONNÉES SIMULÉES/);
    expect(r.statements[1]!.text).toMatch(/source : distance SIMULÉE à la main/);
  });

  it('retour dans la zone : l’alerte disparaît, l’historique des mesures reste dans la preuve', async () => {
    await wait(1000);
    expect((await send(id, token, { distanceM: 4, accuracyM: 3 })).json().zone).toBe('INSIDE');
    const r = await list();
    expect(r.data.alerts).toEqual([]);
    expect(r.data.beacons[0]).toMatchObject({ status: 'INSIDE', outsideSince: null });
    expect(r.data.beacons[0]!.recent.map((x) => x.zone)).toEqual(['INSIDE', 'OUTSIDE', 'OUTSIDE', 'UNCERTAIN', 'INSIDE']);
  });

  it('le téléphone lit l’état enregistré par le serveur avec son jeton ; une autre organisation ne voit rien', async () => {
    const mine = (await app.inject({ url: `/api/devices/${id}`, headers: { 'x-device-token': token } })).json() as Beacon;
    expect(mine).toMatchObject({ id, animalId: 'B-071', status: 'INSIDE' });
    expect((await app.inject({ url: `/api/devices/${id}`, headers: { 'x-device-token': 'x' } })).statusCode).toBe(401);
    expect((await list(OTHER_VET)).data.beacons).toEqual([]);
    expect((await app.inject({ url: `/api/farm/sources?ref=DEVICE:${id}`, headers: OTHER_VET })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/farm/devices/${id}/stop`, headers: OTHER_VET })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/farm/devices' })).statusCode).toBe(401);
  });

  it('arrêt : plus aucune mesure acceptée, la balise est dite arrêtée ; la situation de l’exploitation n’est pas modifiée', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/farm/devices/${id}/stop`, headers: FARMER })).statusCode).toBe(200);
    await wait(1000);
    expect((await send(id, token, { distanceM: 90, accuracyM: 3 })).statusCode).toBe(409);
    const r = await list();
    expect(r.data.beacons[0]!.status).toBe('STOPPED');
    expect(r.data.alerts).toEqual([]);
    const s = (await app.inject({ url: '/api/farm/situation', headers: FARMER })).json() as ToolResult<SituationData>;
    expect(s.data.animals.total).toBe(8); // une balise ne crée ni animal ni événement d'élevage
    expect(s.data.recent.counts.total).toBe(5);
  });

  it('balise nommée sans animal (« Poulet A ») : le nom remplace l’identifiant dans les phrases, sans créer d’animal', async () => {
    const r = await pair({ label: 'Poulet A', radiusM: 15 });
    expect(r.statusCode).toBe(201);
    const b = r.json() as { id: string; token: string; animalId: string | null; label: string };
    expect(b).toMatchObject({ label: 'Poulet A', animalId: null });
    expect((await send(b.id, b.token, { distanceM: 40, accuracyM: 5 })).json().zone).toBe('OUTSIDE');
    const l = await list();
    expect(l.statements[0]!.text).toBe('Une balise est hors de sa zone : « Poulet A ».');
    expect(l.statements[1]!.text).toMatch(/^Balise de démonstration « Poulet A » : HORS de la zone\. 40 m du repère \(précision ± 5 m\), pour un seuil de 15 m/);
    const s = (await app.inject({ url: '/api/farm/situation', headers: FARMER })).json() as ToolResult<SituationData>;
    expect(s.data.animals.total).toBe(8);
  });

  it('la réinitialisation de la démonstration efface les balises', async () => {
    await resetAndSeed(db, { living: true });
    expect((await list()).data.beacons).toEqual([]);
  });
});
