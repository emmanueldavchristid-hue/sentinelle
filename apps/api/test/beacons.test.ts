import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearingOf, type AssistantReply, type Beacon, type BeaconsData, type IncidentData, type SituationData, type SourceData, type ToolResult } from '@sentinelle/contracts';
import { buildApp } from '../src/app.js';
import { recognize } from '../src/assistant.js';
import { AUTO_MAX_ACTIVE, offsetFromAnchor, zoneOf } from '../src/beacons.js';
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

describe('Suivi GPS : position relative au repère, trajectoire, direction', () => {
  it('direction dite seulement quand elle a un sens', () => {
    expect(bearingOf(0, 50)).toBe('nord');
    expect(bearingOf(40, 40)).toBe('nord-est');
    expect(bearingOf(60, 0)).toBe('est');
    expect(bearingOf(0, -30)).toBe('sud');
    expect(bearingOf(-20, 20)).toBe('nord-ouest');
    // Trop près du repère pour la précision annoncée : on ne dit pas de quel côté.
    expect(bearingOf(2, 1)).toBeNull();
    expect(bearingOf(6, 6, 15)).toBeNull();
    expect(bearingOf(null, null)).toBeNull();
    expect(bearingOf(undefined, 12)).toBeNull();
  });

  it('la trajectoire est conservée dans l’ordre, la direction est dite, aucune coordonnée géographique n’existe en base', async () => {
    await app.inject({ method: 'POST', url: '/api/demo/reset', headers: { 'x-sentinelle-demo': 'reset' }, payload: {} });
    const { id, token } = (await pair({ label: 'Poulet A', animalId: 'B-071', radiusM: 30 })).json();
    const step = async (reading: Record<string, unknown>) => {
      await wait(950);
      return send(id, token, reading);
    };
    expect((await step({ distanceM: 0, accuracyM: 4, eastM: 0, northM: 0 })).statusCode).toBe(201);
    expect((await step({ distanceM: 14.1, accuracyM: 4, eastM: 10, northM: 10 })).statusCode).toBe(201);
    expect((await step({ distanceM: 42.4, accuracyM: 4, eastM: 30, northM: 30 })).statusCode).toBe(201);
    // Une mesure sans position relative (ancienne balise, ou pas de position) n'entre pas dans la trajectoire.
    expect((await step({ distanceM: null, accuracyM: null })).statusCode).toBe(201);
    expect((await step({ distanceM: 56.6, accuracyM: 4, eastM: 40, northM: 40 })).statusCode).toBe(201);

    const b = (await list()).data.beacons.find((x) => x.id === id)!;
    expect(b.status).toBe('OUTSIDE');
    expect(b.latest).toMatchObject({ eastM: 40, northM: 40, distanceM: expect.closeTo(56.6, 1) });
    expect(b.track!.map((t) => [t.eastM, t.northM])).toEqual([[0, 0], [10, 10], [30, 30], [40, 40]]);
    expect(b.track!.at(-1)).toMatchObject({ zone: 'OUTSIDE', source: 'PHONE_GPS' });
    const r = await list();
    expect(r.statements.map((x) => x.text).join(' ')).toMatch(/HORS de la zone\. 57 m du repère, vers le nord-est \(précision ± 4 m\)/);
    expect(r.limits.join(' ')).toMatch(/Aucune coordonnée géographique n’est transmise/);
    // L'incident ouvert le dit aussi, dans l'état actuel.
    const inc = (await app.inject({ url: '/api/farm/incidents/latest', headers: FARMER })).json() as ToolResult<IncidentData>;
    expect(inc.statements.at(-1)!.text).toMatch(/^État actuel\. .*vers le nord-est/);
    // Le schéma ne prévoit aucune colonne de coordonnées : seules des distances relatives au repère sont gardées.
    const cols = (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'device_readings'`)).rows.map((c) => c.column_name);
    expect(cols).toEqual(expect.arrayContaining(['east_m', 'north_m', 'distance_m']));
    expect(cols.some((c) => /lat|lon|coord/.test(c))).toBe(false);
  });

  it('position relative incomplète ou incohérente avec la distance : refusée', async () => {
    const { id, token } = (await pair({ label: 'Poulet B', radiusM: 30 })).json();
    await wait(950);
    expect((await send(id, token, { distanceM: 20, accuracyM: 4, eastM: 20 })).statusCode).toBe(400);
    await wait(950);
    // 20 m annoncés, mais une position relative à 71 m du repère : l'une des deux valeurs est fausse.
    const bad = await send(id, token, { distanceM: 20, accuracyM: 4, eastM: 50, northM: 50 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().fields.eastM).toMatch(/incohérente avec la distance/);
    await wait(950);
    expect((await send(id, token, { source: 'SIMULATED', distanceM: 20, accuracyM: null, eastM: 20, northM: 0 })).statusCode).toBe(201);
    const b = (await list()).data.beacons.find((x) => x.id === id)!;
    expect(b.track).toHaveLength(1);
    expect(b.track![0]).toMatchObject({ source: 'SIMULATED', eastM: 20, northM: 0 });
    expect((await list()).data.simulated).toBe(true);
  });
});

describe('Suivi automatique : ouvrir le lien suffit, repère commun, distance calculée par le serveur', () => {
  /** Point de départ (Abidjan), avec des décimales reconnaissables : on vérifie plus bas qu'elles ne ressortent nulle part. */
  const HOME = { latitude: 5.36123, longitude: -4.00831 };
  const M_PER_DEG = (6_371_000 * Math.PI) / 180;
  const at = (northM: number, eastM = 0) => ({ latitude: HOME.latitude + northM / M_PER_DEG, longitude: HOME.longitude + eastM / (M_PER_DEG * Math.cos((HOME.latitude * Math.PI) / 180)) });
  const auto = (payload: Record<string, unknown> = {}, on = app) => on.inject({ method: 'POST', url: '/api/devices/auto', payload });
  const pos = (d: { id: string; token: string }, p: { latitude: number; longitude: number }, more: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/api/devices/${d.id}/position`, headers: { 'x-device-token': d.token }, payload: { accuracyM: 5, observedAt: new Date().toISOString(), ...p, ...more } });
  const beacon = async (id: string) => (await list()).data.beacons.find((b) => b.id === id)!;
  const anchorOn = (id: string, headers: Record<string, string> = FARMER) => app.inject({ method: 'POST', url: `/api/farm/devices/${id}/anchor`, headers });
  /** Toutes les réponses lues pendant ces tests : aucune ne doit porter de coordonnée. */
  const seen: string[] = [];
  const keep = <T extends { body: string }>(r: T): T => (seen.push(r.body), r);
  let a = { id: '', token: '', label: '' };
  let b = { id: '', token: '', label: '' };
  let last = { id: '', token: '', label: '' };

  it('calcul de la position relative : 100 m au nord donne nord 100 et est 0, sans coordonnée dans le résultat', () => {
    const n = offsetFromAnchor(HOME, at(100));
    expect(n.northM).toBeCloseTo(100, 3);
    expect(n.eastM).toBeCloseTo(0, 6);
    expect(n.distanceM).toBeCloseTo(100, 3);
    const e = offsetFromAnchor(HOME, at(0, 50));
    expect(e.eastM).toBeCloseTo(50, 3);
    expect(e.northM).toBeCloseTo(0, 6);
    const sw = offsetFromAnchor(HOME, at(-30, -40));
    expect(sw.distanceM).toBeCloseTo(50, 2);
    // De part et d'autre de l'antiméridien : l'écart de longitude est pris par le plus court chemin.
    expect(offsetFromAnchor({ latitude: 0, longitude: 179.9999 }, { latitude: 0, longitude: -179.9999 }).eastM).toBeCloseTo(22.24, 1);
    expect(Object.keys(n).sort()).toEqual(['distanceM', 'eastM', 'northM']);
  });

  it('enregistrement sans session ni QR : nom numéroté, aucun animal, seuil de 30 m, jeton haché, balise marquée automatique en base', async () => {
    await resetAndSeed(db, { living: true });
    const r1 = keep(await auto());
    expect(r1.statusCode).toBe(201);
    const first = r1.json() as { id: string; token: string; label: string; radiusM: number };
    expect(first).toMatchObject({ label: 'Appareil 1', radiusM: 30 });
    expect(first.id).toMatch(/^BAL-[0-9A-F]{4}$/);
    expect(first.token.length).toBeGreaterThan(20);
    a = keep(await auto({ kind: 'PHONE' })).json();
    b = keep(await auto({ kind: 'COMPUTER' })).json();
    expect(a.label).toBe('Téléphone 2');
    expect(b.label).toBe('Ordinateur 3');
    expect((await auto({ kind: 'MONTRE' })).statusCode).toBe(400);
    const rows = (await db.query<{ id: string; origin: string; kind: string | null; animal_id: string | null; token_hash: string; created_by: string; org_id: string; radius_m: number }>('SELECT * FROM devices ORDER BY auto_seq')).rows;
    expect(rows.map((x) => [x.origin, x.kind, x.animal_id, x.created_by, x.org_id, x.radius_m])).toEqual([
      ['AUTO', null, null, 'U-ELEVEUR', 'ORG-DEMO', 30],
      ['AUTO', 'PHONE', null, 'U-ELEVEUR', 'ORG-DEMO', 30],
      ['AUTO', 'COMPUTER', null, 'U-ELEVEUR', 'ORG-DEMO', 30],
    ]);
    expect(rows[1]!.token_hash).not.toBe(a.token);
    expect(rows[1]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    // Une balise associée à la main reste distinguable en base.
    const manual = (await pair({ label: 'Poulet A' })).json() as { id: string };
    expect((await db.query<{ origin: string }>('SELECT origin FROM devices WHERE id = $1', [manual.id])).rows[0]!.origin).toBe('MANUAL');
    const l = await list();
    expect(l.data.anchor).toBeNull();
    expect(l.data.beacons.filter((x) => x.auto).map((x) => [x.label, x.status, x.animalId, x.canAnchor])).toEqual([
      ['Ordinateur 3', 'NEVER', null, false],
      ['Téléphone 2', 'NEVER', null, false],
      ['Appareil 1', 'NEVER', null, false],
    ]);
    expect(l.data.beacons.find((x) => x.id === manual.id)!.auto).toBe(false);
    // L'autre organisation ne voit aucun de ces appareils.
    expect((await list(OTHER_VET)).data.beacons).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `/api/farm/devices/${manual.id}/stop`, headers: FARMER })).statusCode).toBe(200);
  });

  it('hors mode démonstration : la route d’enregistrement automatique répond 404 et ne crée rien', async () => {
    const strict = await buildApp({ db, demoMode: false });
    const count = async () => Number((await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM devices')).rows[0]!.n);
    const before = await count();
    const r = await auto({ kind: 'PHONE' }, strict);
    expect(r.statusCode).toBe(404);
    expect(await count()).toBe(before);
    await strict.close();
  });

  it('position refusée sans jeton valide, mal formée, ou datée trop loin de l’heure du serveur', async () => {
    expect((await pos({ id: a.id, token: 'mauvais-jeton' }, HOME)).statusCode).toBe(401);
    expect((await pos(a, { latitude: 95, longitude: 0 })).statusCode).toBe(400);
    expect((await pos(a, HOME, { accuracyM: -1 })).statusCode).toBe(400);
    expect((await pos(a, HOME, { observedAt: '2020-01-01T00:00:00Z' })).statusCode).toBe(400);
    expect((await list()).data.anchor).toBeNull();
  });

  it('le repère se prend tout seul : la première position reçue le fixe, et cet appareil est à 0 m', async () => {
    const r = keep(await pos(a, HOME));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ accepted: true, zone: 'INSIDE', radiusM: 30 });
    // Une mesure par seconde au plus, comme pour les autres balises.
    expect((await pos(a, at(80))).statusCode).toBe(202);
    const l = await list();
    expect(l.data.anchor).toMatchObject({ byDeviceId: a.id, byLabel: 'Téléphone 2', how: 'FIRST_POSITION', accuracyM: 5 });
    expect(Date.parse(l.data.anchor!.setAt)).toBeGreaterThan(Date.now() - 60_000);
    const mine = l.data.beacons.find((x) => x.id === a.id)!;
    expect(mine).toMatchObject({ status: 'INSIDE', auto: true, kind: 'PHONE', canAnchor: true });
    expect(mine.latest).toMatchObject({ source: 'PHONE_GPS', distanceM: 0, eastM: 0, northM: 0, accuracyM: 5, zone: 'INSIDE' });
    expect(l.statements.at(-1)!.text).toMatch(/^Repère commun des appareils suivis automatiquement : fixé à la première position reçue, celle de l’appareil « Téléphone 2 », le \d{2}\/\d{2}\/\d{4}/);
    expect(l.limits.join(' ')).toMatch(/La position d’une mesure n’est ni stockée ni renvoyée ; seule celle du repère est gardée sur le serveur/);
    // Aucune balise associée à la main n'est active : on ne prétend pas qu'« aucune coordonnée n'est transmise ».
    expect(l.limits.join(' ')).not.toMatch(/Aucune coordonnée géographique n’est transmise/);
  });

  it('distance et décalage calculés par le serveur : 100 m au nord du repère donne nord 100, est 0, hors zone', async () => {
    const r = keep(await pos(b, at(100)));
    expect(r.json()).toMatchObject({ accepted: true, zone: 'OUTSIDE' });
    const other = await beacon(b.id);
    expect(other.latest!.northM).toBeCloseTo(100, 0);
    expect(other.latest!.eastM).toBeCloseTo(0, 0);
    expect(other.latest!.distanceM).toBeCloseTo(100, 0);
    // Un ordinateur n'a pas de GPS : sa mesure ne s'appelle pas « GPS du téléphone ».
    expect(other.latest!.source).toBe('BROWSER_POSITION');
    const l = keep(await app.inject({ url: '/api/farm/devices', headers: FARMER })).json() as ToolResult<BeaconsData>;
    expect(l.data.alerts).toEqual([b.id]);
    const sentence = l.statements.find((s) => s.text.includes('« Ordinateur 3 » : HORS'))!.text;
    expect(sentence).toMatch(/100 m du repère, vers le nord \(précision ± 5 m\), pour un seuil de 30 m/);
    expect(sentence).toMatch(/source : position donnée par le navigateur de l’appareil \(pas forcément un GPS\)/);
    expect(l.limits.join(' ')).toMatch(/Un ordinateur n’a en général pas de GPS/);
    // Vers l'est, puis la trajectoire suit les positions reçues ; un appareil immobile n'ajoute pas de points superposés.
    await wait(950);
    expect((await pos(a, at(0, 20))).json().zone).toBe('INSIDE');
    await wait(950);
    expect((await pos(a, at(0, 20))).statusCode).toBe(201);
    expect((await pos(b, at(120, 10))).statusCode).toBe(201);
    const moved = await beacon(a.id);
    expect(moved.latest!.eastM).toBeCloseTo(20, 0);
    expect(moved.latest!.northM).toBeCloseTo(0, 0);
    expect(moved.recent).toHaveLength(3);
    expect(moved.track!.map((t) => [Math.round(t.eastM), Math.round(t.northM)])).toEqual([[0, 0], [20, 0]]);
    expect((await beacon(b.id)).track!.map((t) => [Math.round(t.eastM), Math.round(t.northM)])).toEqual([[0, 100], [10, 120]]);
    // Mauvaise précision : la distance dépasse le seuil, mais on ne tranche pas.
    await wait(950);
    expect((await pos(a, at(0, 45), { accuracyM: 60 })).json().zone).toBe('UNCERTAIN');
  });

  it('chaque chemin garde sa route : un appareil suivi automatiquement n’annonce pas de distance, une balise associée à la main n’envoie pas sa position', async () => {
    expect((await send(a.id, a.token, { distanceM: 3, accuracyM: 2 })).statusCode).toBe(409);
    const manual = (await pair({ label: 'Poulet B' })).json() as { id: string; token: string };
    expect((await pos(manual, HOME)).statusCode).toBe(409);
    // Le repère ne peut être placé que sur un appareil dont le serveur vient de recevoir la position.
    expect((await anchorOn(manual.id)).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/farm/devices/${manual.id}/stop`, headers: FARMER })).statusCode).toBe(200);
  });

  it('aucune route ne renvoie de latitude ni de longitude ; en base, seul le repère en porte', async () => {
    for (const url of ['/api/farm/devices', `/api/farm/sources?ref=DEVICE:${a.id}`, `/api/farm/sources?ref=DEVICE:${b.id}`, '/api/farm/incidents/latest', '/api/farm/situation', '/api/farm/changes']) {
      const r = keep(await app.inject({ url, headers: FARMER }));
      expect(r.statusCode, url).toBe(200);
    }
    const inc = (await list()).data.incidents![0]!;
    expect(inc.deviceId).toBe(b.id);
    keep(await app.inject({ url: `/api/farm/sources?ref=INCIDENT:${inc.id}`, headers: FARMER }));
    keep(await app.inject({ url: `/api/devices/${a.id}`, headers: { 'x-device-token': a.token } }));
    keep(await app.inject({ method: 'POST', url: '/api/assistant/ask', headers: FARMER, payload: { text: 'Quel animal s’est éloigné ?' } }));
    // La preuve d'un appareil suivi automatiquement dit ce qu'il est et par rapport à quel repère il est mesuré, sans position.
    const proof = (await app.inject({ url: `/api/farm/sources?ref=DEVICE:${b.id}`, headers: FARMER })).json() as ToolResult<SourceData>;
    expect(proof.data.fields.find((f) => f.label === 'Dispositif')!.value).toBe('Ordinateur 3 (ordinateur suivi automatiquement depuis l’ouverture du lien, pas un capteur posé sur un animal)');
    expect(proof.data.fields.find((f) => f.label === 'Repère')!.value).toMatch(/^repère commun, fixé à la première position reçue, celle de Téléphone 2, le /);
    expect(proof.data.fields.find((f) => f.label === 'Dernière mesure')!.value).toMatch(/· position donnée par le navigateur de l’appareil/);
    expect(seen.length).toBeGreaterThan(12);
    for (const body of seen) {
      expect(body).not.toMatch(/latitude|longitude|"lat"|"lon"|"lng"|coord/i);
      expect(body).not.toMatch(/5\.36\d|4\.008\d/);
    }
    // En base : les mesures, les balises, les incidents et le journal ne portent que des mètres ; seul le repère a une position.
    const cols = async (table: string) => (await db.query<{ column_name: string }>('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table])).rows.map((c) => c.column_name);
    for (const table of ['device_readings', 'devices', 'device_incidents']) expect((await cols(table)).some((c) => /lat|lon|coord/.test(c)), table).toBe(false);
    expect(await cols('org_anchors')).toEqual(expect.arrayContaining(['latitude', 'longitude']));
    const journal = JSON.stringify((await db.query('SELECT action, entity, entity_id, detail FROM audit_events')).rows);
    expect(journal).toMatch(/DEVICE_AUTO_REGISTERED/);
    expect(journal).toMatch(/ANCHOR_SET/);
    expect(journal).not.toMatch(/5\.36\d|4\.008\d|latitude/);
  });

  it('déplacement du repère sur un appareil : réservé à une session, anciennes mesures effacées, incident terminé pour ce motif, distances recalculées', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/farm/devices/${b.id}/anchor` })).statusCode).toBe(401);
    expect((await anchorOn(b.id, OTHER_VET)).statusCode).toBe(404);
    expect((await anchorOn('BAL-ZZZZ')).statusCode).toBe(404);
    const openBefore = (await list()).data.incidents!.find((i) => !i.closedAt)!;
    expect(openBefore.deviceId).toBe(b.id);
    const before = { phone: (await beacon(a.id)).latest!, desk: (await beacon(b.id)).latest! };
    const r = keep(await anchorOn(b.id));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, anchor: { byDeviceId: b.id, byLabel: 'Ordinateur 3', how: 'MOVED', accuracyM: 5 } });
    expect(r.body).not.toMatch(/latitude|longitude|5\.36\d|4\.008\d/);
    // Les points calculés par rapport à l'ancien repère sont effacés : aucun n'est plus rendu, ni en dernière mesure, ni en trajectoire.
    const seq = Number((await db.query<{ seq: number }>('SELECT seq FROM org_anchors')).rows[0]!.seq);
    expect(seq).toBe(2);
    expect((await db.query<{ anchor_seq: number }>('SELECT anchor_seq FROM device_readings WHERE anchor_seq IS NOT NULL')).rows.map((x) => x.anchor_seq)).toEqual([seq, seq]);
    // À la place : la dernière position de chaque appareil, ré-exprimée par rapport au nouveau repère, avec ses instants d'origine.
    let l = await list();
    const [phoneNow, deskNow] = [l.data.beacons.find((x) => x.id === a.id)!, l.data.beacons.find((x) => x.id === b.id)!];
    expect(deskNow.latest).toMatchObject({ distanceM: 0, eastM: 0, northM: 0, zone: 'INSIDE', source: 'BROWSER_POSITION', observedAt: before.desk.observedAt });
    expect(deskNow.track).toHaveLength(1);
    expect(deskNow.recent).toHaveLength(1);
    // Le téléphone était à 45 m à l'est de l'ancien repère (± 60 m) : il est à 125 m du nouveau, au sud-est. Rien n'est rajeuni.
    expect(phoneNow.latest).toMatchObject({ zone: 'OUTSIDE', accuracyM: 60, source: 'PHONE_GPS', observedAt: before.phone.observedAt });
    expect(phoneNow.latest!.northM).toBeCloseTo(-120, 0);
    expect(phoneNow.latest!.eastM).toBeCloseTo(35, 0);
    expect(Math.abs(Date.parse(phoneNow.latest!.receivedAt) - Date.parse(before.phone.receivedAt))).toBeLessThan(1000);
    expect(phoneNow.track).toHaveLength(1);
    // La ré-expression n'ouvre pas d'incident : l'ancien est terminé parce que le repère a bougé, la prochaine mesure reçue décidera.
    expect(l.data.incidents!.every((i) => i.closedAt !== null)).toBe(true);
    expect(l.data.incidents!.find((i) => i.id === openBefore.id)).toMatchObject({ closeReason: 'ANCHOR_MOVED' });
    const inc = (await app.inject({ url: `/api/farm/incidents/${openBefore.id}`, headers: FARMER })).json() as ToolResult<IncidentData>;
    expect(inc.statements.map((s) => s.text).join(' ')).toMatch(/Incident terminé le .* : le repère commun a été déplacé/);
    expect(inc.limits.join(' ')).toMatch(/calculée par le serveur à partir de la position envoyée par l’appareil et du repère commun : ce n’est pas une mesure radio/);
    // Nouvelles positions, nouveau repère : l'ordinateur est à 0 m, le téléphone revenu au point de départ est à 120 m au sud.
    await wait(950);
    expect((await pos(b, at(120, 10))).json().zone).toBe('INSIDE');
    expect((await pos(a, HOME)).json().zone).toBe('OUTSIDE');
    l = await list();
    expect(l.data.beacons.find((x) => x.id === b.id)!.latest).toMatchObject({ distanceM: 0, eastM: 0, northM: 0 });
    const phone = l.data.beacons.find((x) => x.id === a.id)!;
    expect(phone.latest!.northM).toBeCloseTo(-120, 0);
    expect(phone.latest!.eastM).toBeCloseTo(-10, 0);
    expect(phone.track!.map((t) => [Math.round(t.eastM), Math.round(t.northM)])).toEqual([[35, -120], [-10, -120]]);
    // Cette mesure-là, reçue pour de bon, ouvre l'incident.
    expect(l.data.incidents!.find((i) => !i.closedAt)).toMatchObject({ deviceId: a.id });
    expect(l.statements.find((s) => s.text.includes('« Téléphone 2 » : HORS'))!.text).toMatch(/120 m du repère, vers le sud/);
    expect(l.statements.at(-1)!.text).toMatch(/Repère commun des appareils suivis automatiquement : placé sur l’appareil « Ordinateur 3 » le /);
    expect(l.data.anchor).toMatchObject({ byDeviceId: b.id, how: 'MOVED' });
  });

  it('« Arrêter le suivi » depuis l’appareil, ou depuis l’écran de l’éleveur : plus aucune position acceptée, et le dire', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/devices/${a.id}/stop`, headers: { 'x-device-token': 'x' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/devices/${a.id}/stop`, headers: { 'x-device-token': a.token } })).statusCode).toBe(200);
    // Sans effet la seconde fois, sans erreur : l'appareil peut répéter sa demande.
    expect((await app.inject({ method: 'POST', url: `/api/devices/${a.id}/stop`, headers: { 'x-device-token': a.token } })).statusCode).toBe(200);
    await wait(950);
    const refused = await pos(a, HOME);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: 'STOPPED' });
    expect(await beacon(a.id)).toMatchObject({ status: 'STOPPED', canAnchor: false });
    // L'incident ouvert par le téléphone est terminé parce qu'il a été arrêté.
    expect((await list()).data.incidents!.find((i) => i.deviceId === a.id)).toMatchObject({ closeReason: 'DEVICE_STOPPED' });
    expect((await app.inject({ method: 'POST', url: `/api/farm/devices/${b.id}/stop`, headers: FARMER })).statusCode).toBe(200);
    expect((await pos(b, HOME)).statusCode).toBe(409);
    expect((await anchorOn(b.id)).statusCode).toBe(409);
  });

  it('borne : quarante appareils suivis automatiquement au plus, refus net au-delà ; la limite de cinq ne vaut que pour les balises associées à la main', async () => {
    await resetAndSeed(db, { living: true });
    const made: { id: string; token: string; label: string }[] = [];
    for (let i = 0; i < AUTO_MAX_ACTIVE; i++) {
      const r = await auto({ kind: i % 2 ? 'PHONE' : 'COMPUTER' });
      expect(r.statusCode).toBe(201);
      made.push(r.json());
    }
    expect(AUTO_MAX_ACTIVE).toBe(40);
    expect(made.at(-1)!.label).toBe('Téléphone 40');
    expect(new Set(made.map((m) => m.id)).size).toBe(40);
    const full = await auto();
    expect(full.statusCode).toBe(409);
    expect(full.json()).toMatchObject({ reason: 'AUTO_LIMIT' });
    expect(full.json().message).toMatch(/^40 appareils sont déjà suivis automatiquement/);
    // Les quarante sont tous rendus à l'écran de l'éleveur, et cinq balises associées à la main restent possibles à côté.
    expect((await list()).data.beacons.filter((x) => x.auto && x.status !== 'STOPPED')).toHaveLength(40);
    for (let i = 0; i < 5; i++) expect((await pair({ label: `Poulet ${i}` })).statusCode).toBe(201);
    expect((await pair({ label: 'Poulet de trop' })).statusCode).toBe(409);
    expect((await list()).data.beacons.filter((x) => x.status !== 'STOPPED')).toHaveLength(45);
    // Un appareil arrêté libère une place ; le numéro, lui, ne revient pas en arrière.
    expect((await app.inject({ method: 'POST', url: `/api/devices/${made[0]!.id}/stop`, headers: { 'x-device-token': made[0]!.token } })).statusCode).toBe(200);
    const next = await auto();
    expect(next.statusCode).toBe(201);
    expect(next.json().label).toBe('Appareil 41');
    last = next.json();
  });

  it('la réinitialisation efface le repère : la première position reçue ensuite le fixe de nouveau', async () => {
    // Quarante appareils sont de nouveau actifs : la borne tient toujours.
    expect((await auto({ kind: 'PHONE' })).statusCode).toBe(409);
    await resetAndSeed(db, { living: true });
    expect(Number((await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM org_anchors')).rows[0]!.n)).toBe(0);
    expect((await list()).data.anchor).toBeNull();
    // Un appareil d'avant la réinitialisation n'existe plus : son jeton ne vaut plus rien, il doit se réenregistrer.
    expect((await pos(last, HOME)).statusCode).toBe(401);
    const again = (await auto({ kind: 'PHONE' })).json() as { id: string; token: string; label: string };
    expect(again.label).toBe('Téléphone 1');
    expect((await pos(again, at(500, 500))).json().zone).toBe('INSIDE');
    const l = await list();
    expect(l.data.anchor).toMatchObject({ byDeviceId: again.id, how: 'FIRST_POSITION' });
    expect(l.data.beacons[0]!.latest).toMatchObject({ distanceM: 0 });
  });
});
