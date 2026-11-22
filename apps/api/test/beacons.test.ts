import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssistantReply, Beacon, BeaconsData, IncidentData, SituationData, SourceData, ToolResult } from '@sentinelle/contracts';
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

describe('Incident d’éloignement : un par épisode, avec ses faits, relu avec l’état actuel', () => {
  let id = '';
  let token = '';
  let first = '';
  const incident = async (which = 'latest', headers = FARMER) => app.inject({ url: `/api/farm/incidents/${which}`, headers });
  const text = (r: ToolResult<IncidentData | null>) => r.statements.map((s) => s.text).join(' | ');
  const step = async (reading: Record<string, unknown>) => {
    await wait(950); // une mesure par seconde au plus
    expect((await send(id, token, reading)).statusCode).toBe(201);
  };

  it('sans incident : le dit, sans rien inventer', async () => {
    await app.inject({ method: 'POST', url: '/api/demo/reset', headers: { 'x-sentinelle-demo': 'reset' }, payload: {} });
    const r = (await incident()).json() as ToolResult<IncidentData | null>;
    expect(r.tool).toBe('incident');
    expect(r.data).toBeNull();
    expect(r.statements[0]).toMatchObject({ nature: 'MISSING', text: 'Aucun incident de balise n’est enregistré.' });
  });

  it('dans la zone ou incertain : aucun incident ; hors zone : un incident, et un seul pour tout l’épisode', async () => {
    ({ id, token } = (await pair({ label: 'Poulet A', animalId: 'B-071', radiusM: 20 })).json());
    await step({ distanceM: 10, accuracyM: 3 });
    await step({ distanceM: 25, accuracyM: 10 });
    expect((await list()).data.incidents).toEqual([]);
    await step({ distanceM: 45, accuracyM: 5 });
    await step({ distanceM: 60, accuracyM: 5 });
    await step({ distanceM: 22, accuracyM: 10 }); // incertain : ne ferme pas l'incident
    const l = await list();
    expect(l.data.incidents).toHaveLength(1);
    expect(l.data.incidents![0]).toMatchObject({ deviceId: id, label: 'Poulet A', animalId: 'B-071', closedAt: null });
    first = l.data.incidents![0]!.id;
    expect(first).toMatch(/^INC-[0-9A-F]{5}$/);

    const r = (await incident(first)).json() as ToolResult<IncidentData>;
    expect(r.params.incidentId).toBe(first);
    // Ce qui a été détecté et quand, la mesure et la règle qui le justifient, la précision, puis l'état ACTUEL.
    expect(r.statements[0]!.text).toMatch(new RegExp(`^Incident ${first} : la balise de démonstration « Poulet A », associée à B-071, a été mesurée hors de sa zone le \\d{2}/\\d{2}/\\d{4}`));
    expect(text(r)).toMatch(/45 m du repère \(précision ± 5 m\), pour un seuil de 20 m\. Source : GPS du téléphone/);
    expect(text(r)).toMatch(/Distance la plus grande mesurée pendant l’incident : 60 m/);
    expect(text(r)).toMatch(/Incident toujours ouvert/);
    expect(r.statements.at(-1)!.text).toMatch(/^État actuel\. .*incertain\. 22 m du repère/);
    expect(r.data).toMatchObject({ radiusM: 20, maxDistanceM: 60, closeReason: null, trigger: { distanceM: 45, accuracyM: 5, source: 'PHONE_GPS' } });
    expect(r.data.current!.status).toBe('UNCERTAIN');
    expect(r.sources.map((s) => s.ref)).toEqual([`INCIDENT:${first}`, `DEVICE:${id}`, 'ANIMAL:B-071']);
    expect(r.limits.join(' ')).toMatch(/ce n’est pas une mesure radio de la proximité avec l’ordinateur/);
    expect(r.limits.join(' ')).toMatch(/aucun message n’est envoyé/);
  });

  it('retour dans la zone : l’incident est terminé, et la lecture donne l’état actuel, pas celui du moment de l’alerte', async () => {
    await step({ distanceM: 5, accuracyM: 2 });
    const r = (await incident(first)).json() as ToolResult<IncidentData>;
    expect(text(r)).toMatch(/Incident terminé le .* : la balise a de nouveau été mesurée dans la zone/);
    expect(r.statements.at(-1)!.text).toMatch(/^État actuel\. .*dans la zone\. 5 m du repère/);
    expect(r.data.closeReason).toBe('BACK_INSIDE');
    expect((await list()).data.alerts).toEqual([]);
  });

  it('nouvel éloignement : nouvel incident ; l’ouvert passe en tête ; la preuve s’ouvre ; une autre organisation ne voit rien', async () => {
    await step({ source: 'SIMULATED', distanceM: 50, accuracyM: null });
    const l = await list();
    expect(l.data.incidents).toHaveLength(2);
    expect(l.data.incidents![0]!.closedAt).toBeNull();
    expect(l.data.incidents![0]!.id).not.toBe(first);
    const latest = (await incident()).json() as ToolResult<IncidentData>;
    expect(latest.data.id).toBe(l.data.incidents![0]!.id);
    expect(latest.limits[0]).toMatch(/^DONNÉES SIMULÉES/);
    expect(text(latest)).toMatch(/Source : distance SIMULÉE à la main/);

    const proof = (await app.inject({ url: `/api/farm/sources?ref=INCIDENT:${first}`, headers: FARMER })).json() as ToolResult<SourceData>;
    expect(proof.data.kind).toBe('incident');
    expect(proof.data.fields.find((f) => f.label === 'Statut')!.value).toMatch(/^terminé le/);
    expect((await incident(first, OTHER_VET)).statusCode).toBe(404);
    expect((await incident('INC-00000')).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/farm/sources?ref=INCIDENT:${first}`, headers: OTHER_VET })).statusCode).toBe(404);
  });

  it('l’assistant relit lui-même l’incident ouvert à l’écran, sans demander de le raconter', async () => {
    expect(recognize('Explique-moi cet incident')).toBe('incident');
    expect(recognize('Pourquoi cette alerte ?')).toBe('incident');
    expect(recognize('Quel animal s’est éloigné ?')).toBe('beacons');
    expect(recognize('Qu’est-ce qui s’est passé depuis hier ?')).toBe('changes');
    const r = (await app.inject({ method: 'POST', url: '/api/assistant/ask', headers: FARMER, payload: { text: 'Explique-moi cet incident', contextIncidentId: first } })).json() as AssistantReply;
    expect(r.intent).toBe('incident');
    expect(r.results[0]!.tool).toBe('incident');
    expect(r.results[0]!.params.incidentId).toBe(first);
    expect(r.results[0]!.statements.at(-1)!.text).toMatch(/^État actuel\./);
  });

  it('arrêt de la balise : l’incident ouvert est terminé pour ce motif', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/farm/devices/${id}/stop`, headers: FARMER })).statusCode).toBe(200);
    const r = (await incident()).json() as ToolResult<IncidentData>;
    expect(r.data.closeReason).toBe('DEVICE_STOPPED');
    expect(text(r)).toMatch(/la balise a été arrêtée/);
    expect((await list()).data.incidents!.every((i) => i.closedAt !== null)).toBe(true);
  });
});
