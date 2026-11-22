import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssistantStatus, BaouleReply, SituationData, ToolResult } from '@sentinelle/contracts';
import { buildApp } from '../src/app.js';
import { bciNorm, composeAnswer, matchIntent, similarity } from '../src/baoule.js';
import { BAOULE_PHRASES, bciNumber } from '../src/baoule-phrases.js';
import { type Db, migrate } from '../src/db.js';
import { resetAndSeed } from '../src/seed.js';
import { openTestDb } from './helpers.js';

/**
 * Note vocale en baoulé, testée contre un FAUX service de parole : aucun modèle n'est chargé ici. Ces tests vérifient la
 * chaîne (question rapprochée, lecture des données, gabarits, nombres par règle), pas la justesse du baoulé ni la qualité
 * de l'écoute et de la voix, qui relèvent d'un locuteur et d'un essai réel (docs/BAOULE.md).
 */
const FARMER = { 'x-demo-user': 'U-ELEVEUR' };
const WAV = Buffer.alloc(2000, 1).toString('base64');
const Q = BAOULE_PHRASES.questions;

describe('Nombres en baoulé, écrits par règle', () => {
  it('unités, dizaines, centaines, milliers ; rien pour zéro ni hors bornes', () => {
    expect(bciNumber(1)).toBe('kun');
    expect(bciNumber(8)).toBe('mɔcuɛ');
    expect(bciNumber(10)).toBe('blu');
    expect(bciNumber(11)).toBe('blu nin kun');
    expect(bciNumber(20)).toBe('ablaɔn');
    expect(bciNumber(57)).toBe('ablenun nin nso');
    expect(bciNumber(100)).toBe('ya kun');
    expect(bciNumber(345)).toBe('ya nsan nin ablanan nin nnun');
    expect(bciNumber(2000)).toBe('akpi nnyɔn');
    for (const n of [0, -3, 1.5, 10_000, Number.NaN]) expect(bciNumber(n)).toBeNull();
  });

  it('deux nombres différents ne s’écrivent jamais de la même façon (1 à 9 999)', () => {
    const seen = new Set<string>();
    for (let n = 1; n <= 9999; n++) seen.add(bciNumber(n)!);
    expect(seen.size).toBe(9999);
  });
});

describe('Rapprochement d’une question entendue', () => {
  it('ignore la casse, la ponctuation et l’hésitation entre ɛ/e et ɔ/o', () => {
    expect(bciNorm('Ngue yɛ ɔ kacili, kɛ ɔ fin anuman’n ?')).toBe('ngue ye o kacili ke o fin anuman n');
    expect(similarity('ngue ye o kacili ke o fin anuman', Q.changes[0]!)).toBeGreaterThan(0.9);
  });

  it('retrouve chaque question de référence, même transcrite approximativement', () => {
    for (const intent of ['situation', 'changes', 'missing', 'beacons'] as const) {
      for (const form of Q[intent]) expect(matchIntent(form, Q)).toMatchObject({ intent, score: 1 });
    }
    expect(matchIntent('ngue ye o kacili ke o fi anuma', Q).intent).toBe('changes');
  });

  it('ne devine pas : français, bruit ou phrase sans rapport donnent « non reconnue »', () => {
    expect(matchIntent('', Q).intent).toBe('unknown');
    expect(matchIntent('ɛ', Q).intent).toBe('unknown');
    expect(matchIntent('like nga nzowa seli kɛ ɔ yo min i', Q).intent).toBe('unknown');
    expect(matchIntent('bonjour je voudrais acheter trois sacs de ciment', Q).intent).toBe('unknown');
  });

  it('une formulation enregistrée par un locuteur est reconnue ensuite', () => {
    const own = { ...Q, beacons: [...Q.beacons, 'saki bo tula wɛtɛ kpa'] };
    expect(matchIntent('saki bo tula wete kpa', Q).intent).toBe('unknown');
    expect(matchIntent('saki bo tula wete kpa', own).intent).toBe('beacons');
  });
});

describe('Note vocale en baoulé (faux service de parole)', () => {
  let db: Db;
  beforeAll(async () => {
    db = await openTestDb();
    await migrate(db);
    await resetAndSeed(db, { withObservation: false });
  });
  afterAll(async () => {
    await db.close();
  });

  /** Faux service : « entend » le texte qu'on lui prépare, « dit » en renvoyant le texte reçu, pour que le test le lise. */
  function rig(state: { hears: string; ttsFails?: boolean; down?: boolean; said: string[] }) {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (state.down) throw new Error('ECONNREFUSED');
      if (url.endsWith('/health')) return new Response(JSON.stringify({ stt: true, tts: true }), { status: 200 });
      if (url.endsWith('/stt')) return new Response(JSON.stringify({ text: state.hears }), { status: 200 });
      if (url.endsWith('/tts')) {
        if (state.ttsFails) return new Response('{}', { status: 503 });
        const text = (JSON.parse(String(init?.body)) as { text: string }).text;
        state.said.push(text);
        return new Response(Buffer.from(`WAV:${text}`), { status: 200, headers: { 'content-type': 'audio/wav' } });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    return buildApp({ db, demoMode: true, baoule: { url: 'http://faux-service', fetchImpl, examplesFile: null } });
  }
  const post = (app: Awaited<ReturnType<typeof rig>>, url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers: FARMER, payload: { mimeType: 'audio/wav', audio: WAV, ...payload } });

  it('sans activation : la voix en baoulé n’est pas proposée, et la route le dit', async () => {
    const app = await buildApp({ db, demoMode: true });
    const status = (await app.inject({ url: '/api/assistant/status', headers: FARMER })).json() as AssistantStatus;
    expect(status.voice?.baoule).toMatchObject({ enabled: false, available: false, validated: false, reason: expect.stringMatching(/non activée/) });
    expect((await post(app, '/api/assistant/baoule', {})).json()).toMatchObject({ error: 'BAOULE_DISABLED' });
    await app.close();
  });

  it('question reconnue : les faits viennent de la lecture des données, les nombres dits sont ceux qui ont été lus', async () => {
    const state = { hears: 'min nnɛn mun be ti sɛ', said: [] as string[] };
    const app = await rig(state);
    const truth = ((await app.inject({ url: '/api/farm/situation', headers: FARMER })).json() as ToolResult<SituationData>).data;
    const r = (await post(app, '/api/assistant/baoule', {})).json() as BaouleReply;
    expect(r).toMatchObject({ heard: state.hears, intent: 'situation', question: 'Quelle est la situation de mon élevage ?', validated: false });
    expect(r.reply).toMatchObject({ mode: 'direct', intent: 'situation', ungrounded: false });
    expect(r.reply.results[0]!.tool).toBe('situation');
    expect(r.reply.notice).toMatch(/rapprochée .* règle de ressemblance.*sans IA générative/);
    // Le nombre d'animaux lu est celui qui est dit, en toutes lettres, et rien d'autre.
    expect(r.spoken).toContain(`Be klɛli nnɛn ${bciNumber(truth.animals.total)}.`);
    expect(r.spokenFr).toContain(`${truth.animals.total} animaux sont enregistrés.`);
    expect(r.spoken).not.toMatch(/\d/);
    expect(r.spoken.endsWith(BAOULE_PHRASES.answers.screen.bci)).toBe(true);
    // Ce qui est envoyé à la voix est exactement le texte renvoyé à l'écran.
    expect(state.said).toEqual([r.spoken]);
    expect(Buffer.from(r.audio!, 'base64').toString()).toBe(`WAV:${r.spoken}`);
    await app.close();
  });

  it('question non reconnue : aucune donnée lue, aucune réponse devinée, la voix le dit', async () => {
    const state = { hears: 'like nga nzowa seli kɛ ɔ yo min i', said: [] as string[] };
    const app = await rig(state);
    const r = (await post(app, '/api/assistant/baoule', {})).json() as BaouleReply;
    expect(r).toMatchObject({ intent: 'unknown', question: null, spoken: BAOULE_PHRASES.answers.unknown.bci });
    expect(r.reply.results).toEqual([]);
    expect(r.reply.notice).toMatch(/non reconnue.*Aucune réponse n’est devinée/);
    await app.close();
  });

  it('formulation enregistrée par un locuteur : gardée comme point de comparaison, puis reconnue', async () => {
    const state = { hears: 'saki bo tula wɛtɛ kpa', said: [] as string[] };
    const app = await rig(state);
    expect(((await post(app, '/api/assistant/baoule', {})).json() as BaouleReply).intent).toBe('unknown');
    expect((await post(app, '/api/assistant/baoule/exemple', { intent: 'beacons' })).json()).toMatchObject({ intent: 'beacons', heard: state.hears, examples: 1 });
    expect((await post(app, '/api/assistant/baoule/exemple', { intent: 'météo' })).statusCode).toBe(400);
    const r = (await post(app, '/api/assistant/baoule', {})).json() as BaouleReply;
    expect(r.intent).toBe('beacons');
    expect(r.spoken).toContain(BAOULE_PHRASES.answers.beaconNone.bci);
    const status = (await app.inject({ url: '/api/assistant/status', headers: FARMER })).json() as AssistantStatus;
    expect(status.voice?.baoule?.examples).toBe(1);
    await app.close();
  });

  it('voix en panne : la lecture reste entière, et rien n’est présenté comme dit', async () => {
    const app = await rig({ hears: 'ngue yɛ ɔ ka', ttsFails: true, said: [] });
    const r = (await post(app, '/api/assistant/baoule', {})).json() as BaouleReply;
    expect(r).toMatchObject({ intent: 'missing', audio: null });
    expect(r.reply.results[0]!.tool).toBe('missing');
    await app.close();
  });

  it('service local injoignable : refus net, sans réponse simulée ; enregistrement invalide refusé', async () => {
    const app = await rig({ hears: '', down: true, said: [] });
    expect((await post(app, '/api/assistant/baoule', {})).json()).toMatchObject({ error: 'BAOULE_UNAVAILABLE' });
    expect((await post(app, '/api/assistant/baoule', { audio: 'abc' })).statusCode).toBe(400);
    expect((await post(app, '/api/assistant/baoule', { mimeType: 'audio/ogg' })).statusCode).toBe(400);
    await app.close();
  });

  it('gabarits : zéro donne la forme « aucun », un nombre hors bornes n’est pas dit', () => {
    const reply = (total: number) => ({ mode: 'direct', provider: null, intent: 'changes', text: null, notice: '', results: [{ tool: 'changes', data: { counts: { total }, events: [] } }], ungrounded: false, suggestions: [] }) as never;
    expect(composeAnswer('changes', reply(0)).bci).toContain(BAOULE_PHRASES.answers.changesNone.bci);
    expect(composeAnswer('changes', reply(3)).bci).toContain('like uflɛ nsan');
    expect(composeAnswer('changes', reply(123_456)).bci).toBe(BAOULE_PHRASES.answers.unknown.bci);
  });
});
