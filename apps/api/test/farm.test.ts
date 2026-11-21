import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { animalMatchKey, extractAnimalIds, normalizeAnimalQuery, type ChangesData, type FindAnimalData, type ObservationDraftData, type SituationData, type SourceData, type ToolResult, type AnimalData, type MissingData } from '@sentinelle/contracts';
import { buildApp } from '../src/app.js';
import { type Db, migrate } from '../src/db.js';
import { resetAndSeed } from '../src/seed.js';
import { LIVING_OBSERVATION_IDS } from '../src/seed-living.js';
import { startOfYesterday } from '../src/farm.js';
import { openTestDb } from './helpers.js';

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
const FARMER = { 'x-demo-user': 'U-ELEVEUR' };
const VET = { 'x-demo-user': 'U-VET' };
const OTHER_VET = { 'x-demo-user': 'U-VET-AUTRE' };
// Jour de réinitialisation fixé : le jeu vivant est daté relativement à lui, « hier » est donc toujours peuplé.
const NOW = new Date();

const get = async <T>(url: string, headers = FARMER) => {
  const r = await app.inject({ url, headers });
  return { status: r.statusCode, body: r.json() as ToolResult<T> };
};

beforeAll(async () => {
  db = await openTestDb();
  await migrate(db);
  await resetAndSeed(db, { living: true, now: NOW });
  app = await buildApp({ db, demoMode: true });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe('Identifiants d’animaux', () => {
  it('normalise les saisies rapides ou dictées', () => {
    expect(normalizeAnimalQuery('b 017')).toBe('B-017');
    expect(normalizeAnimalQuery('B017')).toBe('B-017');
    expect(normalizeAnimalQuery(' b-017 ')).toBe('B-017');
    expect(animalMatchKey('b 17')).toBe(animalMatchKey('B-017'));
    expect(extractAnimalIds('Montre-moi b 017 s’il te plaît')).toContain('B-017');
  });
});

describe('Lecture de l’exploitation (fonctions appelées par les écrans et par l’assistant)', () => {
  it('situation : animaux, sites, changements récents, manques, synchronisation, avec sources et limites', async () => {
    const { status, body } = await get<SituationData>('/api/farm/situation');
    expect(status).toBe(200);
    expect(body.tool).toBe('situation');
    expect(body.data.animals).toEqual({ total: 8, located: 4, unlocated: 4 });
    expect(body.data.sites.find((s) => s.id === 'C')?.animalsPresent).toBe(3); // B-017, B-071, B-073
    expect(body.data.sites.find((s) => s.id === 'A')?.animalsPresent).toBe(1); // B-072 depuis hier
    expect(body.data.lots).toEqual([]);
    expect(body.data.recent.counts).toEqual({ added: 4, corrected: 1, tasks: 0, total: 5 });
    expect(body.data.sync.lastServerReceipt).toBeTruthy();
    expect(body.data.sync.datasetResetAt).toBeTruthy();
    expect(body.limits.join(' ')).toMatch(/Aucun capteur/);
    expect(body.sources.length).toBeGreaterThan(0);
    for (const s of body.statements) expect(['FACT', 'COMPUTED', 'MISSING', 'SUGGESTION', 'DOCUMENT']).toContain(s.nature);
  });

  it('changements depuis hier : événements réels du jeu, chacun avec ses trois dates et une source consultable', async () => {
    const { body } = await get<ChangesData>('/api/farm/changes');
    expect(body.period?.from).toBe(startOfYesterday(body.asOf));
    expect(body.data.counts).toEqual({ added: 4, corrected: 1, tasks: 0, total: 5 });
    expect(body.data.events.map((e) => e.ref).sort()).toEqual([`OBS:${LIVING_OBSERVATION_IDS.appetite}`, `OBS:${LIVING_OBSERVATION_IDS.gait}`, 'REC:MV7@1', 'REC:P10@1', 'REC:P8@2'].sort());
    const obs = body.data.events.find((e) => e.ref === `OBS:${LIVING_OBSERVATION_IDS.appetite}`)!;
    expect(obs.eventTime?.precision).toBe('INSTANT');
    expect(obs.deviceRecordedAt).toBeTruthy();
    expect(Date.parse(obs.recordedAt)).toBeGreaterThan(Date.parse(obs.deviceRecordedAt!));
    expect(body.data.events.find((e) => e.ref === 'REC:P8@2')?.change).toBe('CORRECTED');
    // Chaque source citée s'ouvre.
    for (const s of body.sources) {
      const r = await get<SourceData>(`/api/farm/sources?ref=${encodeURIComponent(s.ref)}`);
      expect(r.status, s.ref).toBe(200);
      expect(r.body.data.fields.length).toBeGreaterThan(0);
    }
    const p8 = await get<SourceData>('/api/farm/sources?ref=REC:P8@1');
    expect(p8.body.data.title).toMatch(/remplacée par la révision 2, conservée/);
    expect(p8.body.data.revisions).toHaveLength(2);
  });

  it('une période vide le dit sans conclure sur l’état des animaux', async () => {
    const from = new Date(Date.now() - 1000).toISOString();
    const { body } = await get<ChangesData>(`/api/farm/changes?from=${encodeURIComponent(from)}`);
    expect(body.data.counts.total).toBe(0);
    expect(body.statements[0]?.nature).toBe('MISSING');
    expect(body.statements[0]?.text).toMatch(/cela ne dit rien de l’état des animaux/);
  });

  it('recherche : « B 017 », « b017 » et « b 17 » trouvent B-017 ; une phrase aussi', async () => {
    for (const q of ['B 017', 'b017', 'b 17', 'Montre-moi B-017', 'montre moi b 017']) {
      const { body } = await get<FindAnimalData>(`/api/farm/animals?q=${encodeURIComponent(q)}`);
      expect(body.data.matches.map((m) => m.id), q).toEqual(['B-017']);
      expect(body.data.matches[0]?.currentSiteId).toBe('C');
    }
    const none = await get<FindAnimalData>('/api/farm/animals?q=Z-999');
    expect(none.body.data.matches).toEqual([]);
    expect(none.body.statements[0]?.nature).toBe('MISSING');
    const partial = await get<FindAnimalData>('/api/farm/animals?q=B-07');
    expect(partial.body.data.matches.map((m) => m.id)).toEqual(['B-071', 'B-072', 'B-073']);
  });

  it('fiche animale : chronologie avec déplacements, lieu actuel, absence d’observation dite sans conclure', async () => {
    const { body } = await get<AnimalData>('/api/farm/animals/B-017');
    expect(body.data.currentSiteId).toBe('C');
    expect(body.data.timeline.filter((e) => e.type === 'MOVEMENT').map((e) => e.ref)).toEqual(['REC:MV2@1', 'REC:MV1@1']);
    expect(body.data.siteIds.sort()).toEqual(['A', 'C', 'M']);
    expect(body.statements.some((s) => s.nature === 'MISSING' && /Aucune observation enregistrée/.test(s.text) && /ne renseigne pas sur son état/.test(s.text))).toBe(true);
    expect((await get('/api/farm/animals/Z-001')).status).toBe(404); // autre organisation
    expect((await get('/api/farm/animals/INCONNU')).status).toBe(404);
  });

  it('informations manquantes : lieu actuel absent, dates inconnues, incohérence, chacune avec sa source', async () => {
    const { body } = await get<MissingData>('/api/farm/missing');
    expect(body.data.counts.NO_CURRENT_SITE).toBe(4); // B-031, B-044, B-052, B-060
    expect(body.data.counts.INCONSISTENT).toBe(1); // MV6 : arrivée avant départ
    expect(body.data.items.find((i) => i.kind === 'UNKNOWN_TIME' && i.ref === 'REC:P9@1')).toBeTruthy();
    expect(body.limits[0]).toMatch(/Contrôles effectués/);
  });

  it('isolation : une autre organisation ne voit ni les événements ni les sources', async () => {
    const other = await get<ChangesData>('/api/farm/changes', OTHER_VET);
    expect(other.body.data.counts.total).toBe(0);
    expect((await get(`/api/farm/sources?ref=OBS:${LIVING_OBSERVATION_IDS.appetite}`, OTHER_VET)).status).toBe(404);
    expect((await get('/api/farm/sources?ref=REC:P8@2', OTHER_VET)).status).toBe(404);
    expect((await app.inject({ url: '/api/farm/situation' })).statusCode).toBe(401);
  });

  it('paramètres invalides : 400 ou 404, jamais 500', async () => {
    for (const url of ['/api/farm/changes?from=hier', '/api/farm/changes?from=2026-02-30T00:00:00Z', '/api/farm/changes?from=2020-01-01T00:00:00Z', '/api/farm/animals?q=', '/api/farm/sources?ref=', '/api/farm/sources?ref=OBS:pas-un-uuid', '/api/farm/sources?ref=REC:P8@99999999999', '/api/farm/sources?ref=TASK:1.5', '/api/farm/sources?ref=n%27importe%20quoi']) {
      const r = await app.inject({ url, headers: FARMER });
      expect([400, 404], url).toContain(r.statusCode);
    }
  });
});

describe('Écriture confirmée : brouillon, confirmation, reçu, puis lecture mise à jour', () => {
  const draft = async (payload: Record<string, unknown>) => (await app.inject({ method: 'POST', url: '/api/farm/observations/draft', headers: FARMER, payload })).json() as ToolResult<ObservationDraftData>;

  it('le brouillon n’écrit rien et expose cible, lieu déduit, date à confirmer et texte', async () => {
    const before = (await get<ChangesData>('/api/farm/changes')).body.data.counts.total;
    const d = await draft({ text: 'Ajoute une observation sur b 017 : mange moins depuis ce matin' });
    expect(d.data.animal).toMatchObject({ value: 'B-017', status: 'OK' });
    expect(d.data.site).toMatchObject({ value: 'C', status: 'DEDUCED' });
    expect(d.data.eventTime.status).toBe('TO_CONFIRM');
    expect(d.data.eventTime.value).toEqual({ precision: 'DAY', date: new Date().toISOString().slice(0, 10) });
    expect(d.data.note).toMatchObject({ value: 'Mange moins depuis ce matin', status: 'OK' });
    expect(d.data.ready).toBe(true);
    expect(d.statements[0]).toMatchObject({ nature: 'SUGGESTION' });
    expect((await get<ChangesData>('/api/farm/changes')).body.data.counts.total).toBe(before);
  });

  it('champs manquants ou ambigus : le brouillon n’est pas prêt et dit pourquoi', async () => {
    const noAnimal = await draft({ text: 'Elle boite un peu' });
    expect(noAnimal.data.animal.status).toBe('MISSING');
    expect(noAnimal.data.eventTime.status).toBe('MISSING');
    expect(noAnimal.data.ready).toBe(false);
    const two = await draft({ text: 'B-017 et B-031 toussent, hier à 16h30' });
    expect(two.data.animal.status).toBe('AMBIGUOUS');
    expect(two.data.animal.candidates?.map((c) => c.id)).toEqual(['B-017', 'B-031']);
    expect(two.data.eventTime.value?.precision).toBe('INSTANT');
    const ctx = await draft({ text: 'Refuse de se lever hier', contextAnimalId: 'B-071' });
    expect(ctx.data.animal).toMatchObject({ value: 'B-071', status: 'DEDUCED' });
    const unlocated = await draft({ text: 'B-044 mange normalement aujourd’hui' });
    expect(unlocated.data.site.status).toBe('MISSING');
    const impossible = await draft({ text: 'B-017 : boiterie constatée le 30/02/2026' });
    expect(impossible.data.eventTime).toMatchObject({ status: 'MISSING' });
    expect(impossible.data.eventTime.message).toMatch(/n’existe pas dans le calendrier/);
    const unknownAnimal = await draft({ text: 'X-999 mange moins ce matin' });
    expect(unknownAnimal.data.animal.status).toBe('MISSING');
  });

  it('après confirmation : reçu serveur, événement visible, même question mise à jour, écart expliqué', async () => {
    const first = (await get<ChangesData>('/api/farm/changes')).body;
    const d = (await draft({ text: 'B-017 : mange moins depuis ce matin' })).data;
    const payload = { payloadVersion: 1, clientId: randomUUID(), idempotencyKey: randomUUID(), animalId: d.animal.value, locationId: d.site.value, eventTime: d.eventTime.value, note: d.note.value, recordedAtClient: new Date().toISOString() };
    const receipt = await app.inject({ method: 'POST', url: '/api/sync/observations', headers: FARMER, payload });
    expect(receipt.statusCode).toBe(201);
    expect(receipt.json().observation.receivedAt).toBeTruthy();

    const second = (await get<ChangesData>('/api/farm/changes')).body;
    expect(second.data.counts.total).toBe(first.data.counts.total + 1);
    expect(second.data.events[0]?.ref).toBe(`OBS:${payload.clientId}`);

    // « Pourquoi ta réponse a changé ? » : ce qui a été reçu entre les deux états.
    const why = (await get<ChangesData>(`/api/farm/changes?from=${encodeURIComponent(first.asOf)}&to=${encodeURIComponent(second.asOf)}`)).body;
    expect(why.data.counts).toEqual({ added: 1, corrected: 0, tasks: 0, total: 1 });
    expect(why.data.events.map((e) => e.ref)).toEqual([`OBS:${payload.clientId}`]);

    const card = (await get<AnimalData>('/api/farm/animals/B-017')).body;
    expect(card.data.timeline[0]?.ref).toBe(`OBS:${payload.clientId}`);
    expect(card.statements.some((s) => /Dernière observation reçue : « Mange moins depuis ce matin »/.test(s.text))).toBe(true);

    // Doublon probable signalé au brouillon suivant.
    const again = await draft({ text: 'B-017 : mange moins depuis ce matin' });
    expect(again.data.possibleDuplicate?.ref).toBe(`OBS:${payload.clientId}`);

    // Rejeu identique : doublon dit comme tel. Rejeu avec un contenu différent : 409, rien n'est modifié.
    expect((await app.inject({ method: 'POST', url: '/api/sync/observations', headers: FARMER, payload })).json().duplicate).toBe(true);
    const tampered = await app.inject({ method: 'POST', url: '/api/sync/observations', headers: FARMER, payload: { ...payload, note: 'Tout autre contenu' } });
    expect(tampered.statusCode).toBe(409);
    expect(tampered.json().error).toBe('CONTENT_MISMATCH');
    const stored = (await get<SourceData>(`/api/farm/sources?ref=OBS:${payload.clientId}`)).body;
    expect(stored.data.fields.find((f) => f.label === 'Texte saisi')?.value).toBe('Mange moins depuis ce matin');
  });

  it('une date impossible est refusée à l’enregistrement', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/sync/observations', headers: FARMER, payload: { payloadVersion: 1, clientId: randomUUID(), idempotencyKey: randomUUID(), animalId: 'B-017', locationId: 'C', eventTime: { precision: 'DAY', date: '2026-02-30' }, note: 'Date impossible', recordedAtClient: new Date().toISOString() } });
    expect(r.statusCode).toBe(400);
  });

  it('le vétérinaire autorisé voit les mêmes observations dans ses signalements', async () => {
    const list = (await app.inject({ url: '/api/observations', headers: VET })).json() as { animalId: string }[];
    expect(list.filter((o) => o.animalId === 'B-017')).toHaveLength(1);
  });
});
