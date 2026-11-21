import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssistantReply, ChangesData, ObservationDraftData, ToolResult } from '@sentinelle/contracts';
import { buildApp } from '../src/app.js';
import { recognize } from '../src/assistant.js';
import { checkAssistantConfig } from '../src/config.js';
import { type Db, migrate } from '../src/db.js';
import { GeminiError, geminiModel, listGeminiModels, pcmToWav, type AssistantModel } from '../src/gemini.js';
import { resetAndSeed } from '../src/seed.js';
import { openTestDb } from './helpers.js';

let db: Db;
const FARMER = { 'x-demo-user': 'U-ELEVEUR' };
const FAKE_KEY = 'cle-fictive-de-test-0123456789';

beforeAll(async () => {
  db = await openTestDb();
  await migrate(db);
  await resetAndSeed(db, { living: true });
});
afterAll(async () => {
  await db.close();
});

const ask = async (app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>) => {
  const r = await app.inject({ method: 'POST', url: '/api/assistant/ask', headers: FARMER, payload });
  return { status: r.statusCode, body: r.json() as AssistantReply };
};

describe('Configuration de l’assistant', () => {
  it('sans clé : désactivé, message lisible, nom de variable et emplacement indiqués, aucune valeur affichée', () => {
    const r = checkAssistantConfig({ geminiApiKey: '', googleApiKeyAlsoSet: false, geminiModel: '' });
    expect(r.ready).toBe(false);
    expect(r.messages.join(' ')).toMatch(/GEMINI_API_KEY/);
    expect(r.messages.join(' ')).toMatch(/\.env/);
  });
  it('clé sans modèle, clé mal formée, double variable : états distincts, la clé n’apparaît jamais', () => {
    const noModel = checkAssistantConfig({ geminiApiKey: FAKE_KEY, googleApiKeyAlsoSet: false, geminiModel: '' });
    expect(noModel.ready).toBe(false);
    expect(noModel.messages.join(' ')).toMatch(/GEMINI_MODEL/);
    expect(checkAssistantConfig({ geminiApiKey: 'trop court', googleApiKeyAlsoSet: false, geminiModel: 'm' }).ready).toBe(false);
    const ok = checkAssistantConfig({ geminiApiKey: FAKE_KEY, googleApiKeyAlsoSet: true, geminiModel: 'modele-de-test' });
    expect(ok.ready).toBe(true);
    expect(ok.messages.join(' ')).toMatch(/GOOGLE_API_KEY est aussi définie/);
    for (const r of [noModel, ok]) expect(r.messages.join(' ')).not.toContain(FAKE_KEY);
  });
});

describe('Mode direct (sans IA) : règles fixes, mêmes fonctions que les écrans', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({ db, demoMode: true });
  });
  afterAll(() => app.close());

  it('reconnaît les six phrases du parcours', () => {
    expect(recognize('Qu’est-ce qui a changé depuis hier ?')).toBe('changes');
    expect(recognize('Montre-moi cet animal B-017')).toBe('animal');
    expect(recognize('Quelles informations manquent ?')).toBe('missing');
    expect(recognize('Pourquoi me montres-tu cette observation ?')).toBe('why_shown');
    expect(recognize('Ajoute cet événement : B-017 mange moins')).toBe('draft');
    expect(recognize('Maintenant, qu’est-ce que cela change ?')).toBe('changes');
    expect(recognize('Pourquoi ta réponse a changé ?')).toBe('why_changed');
    expect(recognize('Quel temps fera-t-il demain ?')).toBe('unknown');
  });

  it('annonce que l’assistant IA n’est pas configuré, et répond quand même à partir des données', async () => {
    const st = (await app.inject({ url: '/api/assistant/status', headers: FARMER })).json();
    expect(st).toMatchObject({ configured: false, provider: null });
    const health = (await app.inject({ url: '/api/health' })).json();
    expect(health.assistant.configured).toBe(false);

    const { body } = await ask(app, { text: 'Qu’est-ce qui a changé depuis hier ?' });
    expect(body).toMatchObject({ mode: 'direct', provider: null, intent: 'changes', text: null, ungrounded: false });
    expect(body.notice).toMatch(/sans IA/);
    expect((body.results[0] as ToolResult<ChangesData>).data.counts.total).toBe(5);
    expect(body.results[0]!.sources.length).toBe(5);
  });

  it('« Montre-moi b 017 » ouvre la fiche ; une demande inconnue le dit sans inventer', async () => {
    const shown = (await ask(app, { text: 'Montre-moi b 017' })).body;
    expect(shown.intent).toBe('animal');
    expect(shown.results[0]).toMatchObject({ tool: 'animal', params: { animalId: 'B-017' } });
    const unknown = (await ask(app, { text: 'Quel temps fera-t-il demain ?' })).body;
    expect(unknown).toMatchObject({ intent: 'unknown', results: [] });
    expect(unknown.notice).toMatch(/Je ne reconnais pas/);
  });

  it('« Ajoute… » renvoie un brouillon, jamais un enregistrement', async () => {
    const before = (await ask(app, { text: 'Qu’est-ce qui a changé depuis hier ?' })).body.results[0] as ToolResult<ChangesData>;
    const d = (await ask(app, { text: 'Ajoute une observation sur B-017 : boit moins depuis hier' })).body;
    expect(d.intent).toBe('draft');
    expect((d.results[0] as ToolResult<ObservationDraftData>).data).toMatchObject({ animal: { value: 'B-017' }, note: { value: 'Boit moins depuis hier' }, ready: true });
    const after = (await ask(app, { text: 'Qu’est-ce qui a changé depuis hier ?' })).body.results[0] as ToolResult<ChangesData>;
    expect(after.data.counts.total).toBe(before.data.counts.total);
  });

  it('« Pourquoi ta réponse a changé ? » : sans deux états, le dit ; avec, montre l’écart', async () => {
    expect((await ask(app, { text: 'Pourquoi ta réponse a changé ?' })).body.notice).toMatch(/pas deux réponses à comparer/);
    const from = new Date(Date.now() - 5000).toISOString();
    const to = new Date().toISOString();
    const why = (await ask(app, { text: 'Pourquoi ta réponse a changé ?', compare: { from, to } })).body;
    expect(why.intent).toBe('why_changed');
    expect(why.results[0]!.statements[0]!.text).toMatch(/Aucun enregistrement n’a été reçu entre vos deux questions/);
  });

  it('entrées invalides : 400, jamais 500', async () => {
    expect((await ask(app, { text: '' })).status).toBe(400);
    expect((await ask(app, { text: 'x'.repeat(601) })).status).toBe(400);
    expect((await ask(app, { text: 'Pourquoi ta réponse a changé ?', compare: { from: 'hier', to: 'demain' } })).status).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/assistant/ask', payload: { text: 'test' } })).statusCode).toBe(401);
  });
});

describe('Mode IA : le modèle n’agit que par les fonctions validées', () => {
  const scripted = (run: AssistantModel['runWithTools']): AssistantModel => ({ provider: 'Faux modèle', model: 'test', runWithTools: run });

  it('appelle une fonction réelle, cite ses sources, et le texte est étiqueté comme formulé par l’IA', async () => {
    const app = await buildApp({
      db,
      demoMode: true,
      assistant: {
        model: scripted(async (i) => {
          const r = (await i.callTool('list_changes', {})) as { statements: { sources: string[] }[] };
          const ref = r.statements.flatMap((s) => s.sources)[0];
          return { text: `Cinq enregistrements ont été reçus depuis hier, dont [${ref}].`, calls: [{ name: 'list_changes', args: {} }] };
        }),
      },
    });
    const { body } = await ask(app, { text: 'Quoi de neuf sur la ferme ?' });
    expect(body).toMatchObject({ mode: 'ai', provider: 'Faux modèle (test)', ungrounded: false });
    expect(body.notice).toMatch(/Les faits et les sources viennent des données, pas du modèle/);
    expect(body.results[0]!.tool).toBe('changes');
    await app.close();
  });

  it('question de lecture reconnue : la lecture de référence est faite par le serveur, fournie au modèle, et présentée en premier', async () => {
    let seen = '';
    const app = await buildApp({
      db,
      demoMode: true,
      assistant: {
        model: scripted(async (i) => {
          seen = i.user;
          await i.callTool('get_situation', {}); // le modèle choisit un autre outil : la référence reste en tête
          return { text: 'Cinq enregistrements ont été reçus depuis hier.', calls: [] };
        }),
      },
    });
    const { body } = await ask(app, { text: 'Qu’est-ce qui a changé depuis hier ?' });
    expect(seen).toMatch(/Lecture déjà effectuée par le serveur pour cette question, fonction changes/);
    expect(seen).toContain('REC:P8@2');
    expect(body.mode).toBe('ai');
    expect(body.results.map((r) => r.tool)).toEqual(['changes', 'situation']);
    expect(body.results[0]!.params).toMatchObject({ sinceYesterday: true });
    await app.close();
  });

  it('écarte une réponse citant une source inexistante, et repasse en lecture directe', async () => {
    const app = await buildApp({ db, demoMode: true, assistant: { model: scripted(async () => ({ text: 'Voir [OBS:00000000-0000-4000-8000-00000000dead].', calls: [] })) } });
    const { body } = await ask(app, { text: 'Qu’est-ce qui a changé depuis hier ?' });
    expect(body.mode).toBe('direct');
    expect(body.notice).toMatch(/citait une source absente/);
    expect(body.results[0]!.tool).toBe('changes');
    await app.close();
  });

  it('sans lecture de données, le texte est présenté comme une suggestion', async () => {
    const app = await buildApp({ db, demoMode: true, assistant: { model: scripted(async () => ({ text: 'Bonjour, que souhaitez-vous consulter ?', calls: [] })) } });
    const { body } = await ask(app, { text: 'Bonjour' });
    expect(body).toMatchObject({ mode: 'ai', ungrounded: true });
    expect(body.notice).toMatch(/suggestion, pas comme un fait/);
    await app.close();
  });

  it('panne, délai ou quota du fournisseur : message lisible et lecture directe, jamais de fausse réponse IA', async () => {
    const app = await buildApp({
      db,
      demoMode: true,
      assistant: {
        maxRequestsPerSession: 1,
        model: scripted(async () => {
          throw new GeminiError(429, 'RESOURCE_EXHAUSTED', 'Quota Gemini atteint (429) : réessayez plus tard, ou vérifiez les limites du projet Google.');
        }),
      },
    });
    const first = (await ask(app, { text: 'Qu’est-ce qui a changé depuis hier ?' })).body;
    expect(first.mode).toBe('direct');
    expect(first.notice).toMatch(/Quota Gemini atteint.*Lecture directe des données à la place, sans IA/);
    const second = (await ask(app, { text: 'Qu’est-ce qui a changé depuis hier ?' })).body;
    expect(second.notice).toMatch(/Limite de 1 demandes/);
    await app.close();
  });

  it('prepare_observation demandé par le modèle ne produit qu’un brouillon', async () => {
    const app = await buildApp({
      db,
      demoMode: true,
      assistant: {
        model: scripted(async (i) => {
          await i.callTool('prepare_observation', { animalId: 'B-071', note: 'Se couche souvent', date: '2026-02-30' });
          await i.callTool('fonction_inexistante', {});
          return { text: 'J’ai préparé un brouillon : vérifiez-le puis confirmez à l’écran.', calls: [] };
        }),
      },
    });
    const { body } = await ask(app, { text: 'Note que B-071 se couche souvent' });
    const draft = body.results[0] as ToolResult<ObservationDraftData>;
    expect(draft.tool).toBe('prepare_observation');
    expect(draft.data.animal.value).toBe('B-071');
    expect(draft.data.eventTime.status).toBe('MISSING'); // la date impossible proposée par le modèle n'est pas retenue
    expect(body.results).toHaveLength(1);
    const n = (await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM observations WHERE note = 'Se couche souvent'`)).rows[0]!.n;
    expect(n).toBe(0);
    await app.close();
  });
});

describe('Brouillon demandé par le modèle : ses propositions sont recoupées avec la phrase de l’utilisateur', () => {
  const scripted = (run: AssistantModel['runWithTools']): AssistantModel => ({ provider: 'Faux modèle', model: 'test', runWithTools: run });
  const draftWith = async (text: string, args: Record<string, unknown>, contextAnimalId?: string) => {
    const app = await buildApp({ db, demoMode: true, assistant: { model: scripted(async (i) => (await i.callTool('prepare_observation', args), { text: 'Brouillon préparé.', calls: [] })) } });
    const { body } = await ask(app, { text, ...(contextAnimalId ? { contextAnimalId } : {}) });
    await app.close();
    return (body.results.find((r) => r.tool === 'prepare_observation') as ToolResult<ObservationDraftData>).data;
  };
  const today = new Date().toISOString().slice(0, 10);

  it('« ce matin » : aucune heure n’est supposée, même si le modèle en propose une (cas réel constaté le 21/11 : 08:00)', async () => {
    const d = await draftWith('Note que B-017 mange moins depuis ce matin', { animalId: 'B-017', note: 'mange moins depuis ce matin', date: today, time: '08:00' });
    expect(d.eventTime.value).toEqual({ precision: 'DAY', date: today });
    expect(d.eventTime.status).toBe('TO_CONFIRM');
    expect(d.note.value).toBe('Mange moins depuis ce matin');
    expect(d.animal).toMatchObject({ value: 'B-017', status: 'OK' });
  });

  it('une heure écrite par l’utilisateur est gardée ; une date proposée sans appui dans la phrase reste à confirmer, sans heure', async () => {
    const written = await draftWith('B-017 a refusé de boire hier à 16h30', { animalId: 'B-017', note: 'a refusé de boire', date: today, time: '09:00' });
    expect(written.eventTime.value?.precision).toBe('INSTANT');
    expect((written.eventTime.value as { at: string }).at.slice(11, 16)).toBe('16:30');
    expect(written.eventTime.status).toBe('OK');
    const proposed = await draftWith('B-017 boite un peu', { animalId: 'B-017', note: 'boite un peu', date: today, time: '10:00' });
    expect(proposed.eventTime.value).toEqual({ precision: 'DAY', date: today });
    expect(proposed.eventTime.status).toBe('TO_CONFIRM');
    expect(proposed.eventTime.message).toMatch(/proposée par l’assistant/);
  });

  it('animal ou lieu absents de la phrase : proposés par le modèle, donc signalés « à vérifier » ou écartés', async () => {
    const d = await draftWith('Elle mange moins aujourd’hui', { animalId: 'B-071', siteId: 'A', note: 'mange moins' });
    expect(d.animal).toMatchObject({ value: 'B-071', status: 'DEDUCED' });
    expect(d.animal.message).toMatch(/n’est pas nommé dans votre phrase/);
    expect(d.site).toMatchObject({ value: 'C', status: 'DEDUCED' }); // lieu actuel enregistré de B-071, pas le lieu avancé par le modèle
    const namedSite = await draftWith('B-071 mange moins aujourd’hui au Marché M', { animalId: 'B-071', siteId: 'M', note: 'mange moins' });
    expect(namedSite.site).toMatchObject({ value: 'M', status: 'OK' });
  });
});

describe('Dictée : relais serveur, enregistrement court, rien de conservé', () => {
  /** WAV PCM 16 bits, 16 kHz, mono, silence de la durée demandée. */
  const wav = (seconds: number) => {
    const data = Buffer.alloc(Math.round(seconds * 32_000));
    const head = Buffer.alloc(44);
    head.write('RIFF', 0, 'ascii');
    head.writeUInt32LE(36 + data.length, 4);
    head.write('WAVEfmt ', 8, 'ascii');
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22);
    head.writeUInt32LE(16_000, 24);
    head.writeUInt32LE(32_000, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write('data', 36, 'ascii');
    head.writeUInt32LE(data.length, 40);
    return Buffer.concat([head, data]).toString('base64');
  };
  const post = (app: Awaited<ReturnType<typeof buildApp>>, payload: unknown, headers: Record<string, string> = FARMER) => app.inject({ method: 'POST', url: '/api/assistant/transcribe', headers, payload: payload as object });
  const voiceModel = (transcribe: NonNullable<AssistantModel['transcribe']>): AssistantModel => ({ provider: 'Faux modèle', model: 'test', runWithTools: async () => ({ text: '', calls: [] }), transcribe });

  it('sans assistant configuré : 503 lisible, et l’état annonce la dictée indisponible', async () => {
    const app = await buildApp({ db, demoMode: true });
    const r = await post(app, { mimeType: 'audio/wav', audio: wav(1) });
    expect(r.statusCode).toBe(503);
    expect(r.json().message).toMatch(/Dictée indisponible.*Utilisez le texte/);
    expect((await app.inject({ url: '/api/health' })).json().assistant.voice).toEqual({ available: false, maxSeconds: 30, speech: false });
    await app.close();
  });

  it('transcrit un enregistrement court et rend le texte à relire ; ni l’audio ni le texte ne sont journalisés', async () => {
    let got: { mimeType: string; size: number } | null = null;
    const app = await buildApp({ db, demoMode: true, assistant: { voiceMaxSeconds: 10, model: voiceModel(async (i) => ((got = { mimeType: i.mimeType, size: i.audioBase64.length }), 'Ajoute une observation sur B-017. Elle mange moins depuis ce matin.')) } });
    const r = await post(app, { mimeType: 'audio/wav', audio: wav(2) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ text: 'Ajoute une observation sur B-017. Elle mange moins depuis ce matin.', provider: 'Faux modèle (test)' });
    expect(r.json().notice).toMatch(/relisez-la.*n’est pas conservé/);
    expect(got).toMatchObject({ mimeType: 'audio/wav' });
    expect((await app.inject({ url: '/api/health' })).json().assistant.voice).toEqual({ available: true, maxSeconds: 10, speech: false });
    const logged = (await db.query<{ detail: unknown }>(`SELECT detail FROM audit_events WHERE action = 'ASSISTANT_TRANSCRIBE' ORDER BY id DESC LIMIT 1`)).rows[0]!.detail;
    expect(JSON.stringify(logged)).not.toMatch(/mange moins|UklGR/);
    // Le texte transcrit suit le parcours écrit : il ne produit qu'un brouillon.
    const direct = await buildApp({ db, demoMode: true });
    const draft = (await ask(direct, { text: r.json().text })).body.results.find((x) => x.tool === 'prepare_observation') as ToolResult<ObservationDraftData>;
    expect(draft.data.animal.value).toBe('B-017');
    expect(draft.data.note.value).toBe('Elle mange moins depuis ce matin.');
    await direct.close();
    await app.close();
  });

  it('entrées refusées : trop long, trop court, pas un WAV, autre format, non connecté ; panne du fournisseur dite clairement', async () => {
    const app = await buildApp({ db, demoMode: true, assistant: { voiceMaxSeconds: 5, model: voiceModel(async () => { throw new GeminiError(503, 'UNAVAILABLE', 'Service Gemini indisponible (503).'); }) } });
    expect((await post(app, { mimeType: 'audio/wav', audio: wav(8) })).json().fields.audio).toMatch(/limité à 5 secondes/);
    expect((await post(app, { mimeType: 'audio/wav', audio: wav(0.1) })).statusCode).toBe(400);
    expect((await post(app, { mimeType: 'audio/wav', audio: Buffer.alloc(4000, 7).toString('base64') })).json().fields.audio).toMatch(/WAV attendu/);
    expect((await post(app, { mimeType: 'audio/webm', audio: wav(1) })).statusCode).toBe(400);
    expect((await post(app, { mimeType: 'audio/wav', audio: 'pas du base64 !' })).statusCode).toBe(400);
    expect((await post(app, { mimeType: 'audio/wav', audio: wav(1) }, {})).statusCode).toBe(401);
    const down = await post(app, { mimeType: 'audio/wav', audio: wav(1) });
    expect(down.statusCode).toBe(502);
    expect(down.json().message).toMatch(/Service Gemini indisponible.*Utilisez le texte/);
    await app.close();
  });
});

describe('Réponse parlée : le texte affiché est rendu en son, rien n’est conservé', () => {
  const speakModel = (speak: NonNullable<AssistantModel['speak']>): AssistantModel => ({ provider: 'Faux modèle', model: 'test', runWithTools: async () => ({ text: '', calls: [] }), speak });
  const post = (app: Awaited<ReturnType<typeof buildApp>>, payload: unknown, headers: Record<string, string> = FARMER) => app.inject({ method: 'POST', url: '/api/assistant/speak', headers, payload: payload as object });

  it('sans modèle vocal : 503 lisible, et l’état annonce que la voix de l’appareil prend le relais', async () => {
    const app = await buildApp({ db, demoMode: true });
    const r = await post(app, { text: 'Bonjour' });
    expect(r.statusCode).toBe(503);
    expect(r.json().message).toMatch(/voix de synthèse de l’appareil prend le relais/);
    expect((await app.inject({ url: '/api/health' })).json().assistant.voice.speech).toBe(false);
    await app.close();
  });

  it('rend un son WAV pour le texte fourni, sans journaliser le texte ; entrées invalides et panne dites clairement', async () => {
    let asked = '';
    const sound = pcmToWav(Buffer.alloc(48_000), 24_000);
    const app = await buildApp({ db, demoMode: true, assistant: { model: speakModel(async (i) => ((asked = i.text), sound)) } });
    expect((await app.inject({ url: '/api/health' })).json().assistant.voice.speech).toBe(true);
    const r = await post(app, { text: 'Cinq enregistrements ont été reçus depuis hier.' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('audio/wav');
    expect(r.rawPayload.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(r.rawPayload.length).toBe(sound.length);
    expect(asked).toBe('Cinq enregistrements ont été reçus depuis hier.');
    const logged = (await db.query<{ detail: unknown }>(`SELECT detail FROM audit_events WHERE action = 'ASSISTANT_SPEAK' ORDER BY id DESC LIMIT 1`)).rows[0]!.detail;
    expect(JSON.stringify(logged)).not.toMatch(/enregistrements/);
    expect((await post(app, { text: '' })).statusCode).toBe(400);
    expect((await post(app, { text: 'x'.repeat(901) })).statusCode).toBe(400);
    expect((await post(app, { text: 'Bonjour' }, {})).statusCode).toBe(401);
    await app.close();

    const down = await buildApp({ db, demoMode: true, assistant: { model: speakModel(async () => { throw new GeminiError(503, 'UNAVAILABLE', 'Service Gemini indisponible (503).'); }) } });
    const failed = await post(down, { text: 'Bonjour' });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().message).toMatch(/Service Gemini indisponible/);
    await down.close();
  });
});

describe('Client Gemini (format des requêtes vérifié contre un faux serveur HTTP ; aucun appel réel à Google)', () => {
  let server: Server;
  let base = '';
  const seen: { url: string; key: string | undefined; body: Record<string, unknown> | null }[] = [];
  let mode: 'tools' | 'error429' = 'tools';

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
        seen.push({ url: req.url ?? '', key: req.headers['x-goog-api-key'] as string | undefined, body });
        res.setHeader('content-type', 'application/json');
        if (mode === 'error429') {
          res.statusCode = 429;
          return res.end(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `détail interne avec ${FAKE_KEY}` } }));
        }
        if (req.method === 'GET') return res.end(JSON.stringify({ models: [{ name: 'models/modele-a', displayName: 'Modèle A', supportedGenerationMethods: ['generateContent'] }] }));
        const contents = (body?.contents ?? []) as { parts: Record<string, unknown>[] }[];
        const answered = contents.some((c) => c.parts.some((p) => 'functionResponse' in p));
        res.end(
          JSON.stringify({
            candidates: [{ content: { role: 'model', parts: answered ? [{ text: 'réflexion', thought: true }, { text: 'Réponse finale.' }] : [{ functionCall: { name: 'get_situation', args: {}, id: 'appel-1' }, thoughtSignature: 'signature-opaque' }] } }],
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('boucle d’outils : clé en en-tête (jamais dans l’URL), signature renvoyée telle quelle, résultat de fonction transmis', async () => {
    const m = geminiModel({ apiKey: FAKE_KEY, model: 'modele-a', baseUrl: base });
    let called = 0;
    const out = await m.runWithTools({ system: 'S', history: [{ role: 'user', text: 'avant' }], user: 'question', tools: [{ name: 'get_situation', description: 'd', parameters: { type: 'object', properties: {} } }], callTool: async () => (called++, { ok: true }), maxRounds: 3, signal: new AbortController().signal });
    expect(out).toEqual({ text: 'Réponse finale.', calls: [{ name: 'get_situation', args: {} }] });
    expect(called).toBe(1);
    const posts = seen.filter((s) => s.body);
    expect(posts).toHaveLength(2);
    for (const p of posts) {
      expect(p.url).toBe('/v1beta/models/modele-a:generateContent');
      expect(p.url).not.toContain(FAKE_KEY);
      expect(p.key).toBe(FAKE_KEY);
    }
    const second = posts[1]!.body as { contents: { role: string; parts: Record<string, unknown>[] }[]; systemInstruction: unknown; tools: unknown };
    expect(second.contents.map((c) => c.role)).toEqual(['user', 'user', 'model', 'user']);
    expect(second.contents[2]!.parts[0]).toMatchObject({ thoughtSignature: 'signature-opaque', functionCall: { name: 'get_situation' } });
    expect(second.contents[3]!.parts[0]).toEqual({ functionResponse: { name: 'get_situation', response: { result: { ok: true } }, id: 'appel-1' } });
    expect(second.systemInstruction).toEqual({ parts: [{ text: 'S' }] });
  });

  it('transcription : audio envoyé en « inlineData », clé en en-tête, texte rendu sans les parties de raisonnement', async () => {
    const before = seen.length;
    const m = geminiModel({ apiKey: FAKE_KEY, model: 'modele-a', baseUrl: base });
    // Le faux serveur répond « functionCall » tant qu'aucune réponse de fonction n'est présente : la transcription n'en lit que le texte.
    const text = await m.transcribe!({ audioBase64: 'QUJD', mimeType: 'audio/wav', signal: new AbortController().signal });
    expect(text).toBe('');
    const sent = seen[before]!;
    expect(sent.key).toBe(FAKE_KEY);
    expect(sent.url).toBe('/v1beta/models/modele-a:generateContent');
    const parts = (sent.body as { contents: { parts: Record<string, unknown>[] }[] }).contents[0]!.parts;
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'audio/wav', data: 'QUJD' } });
    expect(String(parts[0]!.text)).toMatch(/Transcris mot pour mot/);
  });

  it('synthèse vocale : seul le texte à dire est envoyé (aucune consigne), modèle vocal dédié, son rendu en WAV', async () => {
    const before = seen.length;
    const m = geminiModel({ apiKey: FAKE_KEY, model: 'modele-a', ttsModel: 'modele-voix', ttsVoice: 'Kore', baseUrl: base });
    // Le faux serveur ne renvoie pas de son : le client doit le dire clairement plutôt que de rendre un fichier vide.
    const err = await m.speak!({ text: 'Bonjour.', signal: new AbortController().signal }).catch((e) => e as GeminiError);
    expect(err).toBeInstanceOf(GeminiError);
    expect((err as GeminiError).code).toBe('EMPTY');
    const sent = seen[before]!;
    expect(sent.url).toBe('/v1beta/models/modele-voix:generateContent');
    expect(sent.key).toBe(FAKE_KEY);
    const body = sent.body as { contents: { parts: Record<string, unknown>[] }[]; generationConfig: Record<string, unknown> };
    expect(body.contents[0]!.parts).toEqual([{ text: 'Bonjour.' }]);
    expect(body.generationConfig).toEqual({ responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } });
    expect(geminiModel({ apiKey: FAKE_KEY, model: 'modele-a', baseUrl: base }).speak).toBeUndefined();
    expect(pcmToWav(Buffer.alloc(10), 24_000).subarray(0, 4).toString('ascii')).toBe('RIFF');
  });

  it('liste les modèles disponibles', async () => {
    expect(await listGeminiModels({ apiKey: FAKE_KEY, baseUrl: base })).toEqual([{ name: 'modele-a', displayName: 'Modèle A', methods: ['generateContent'] }]);
  });

  it('erreur du fournisseur : message lisible, sans la clé ni le détail brut', async () => {
    mode = 'error429';
    const m = geminiModel({ apiKey: FAKE_KEY, model: 'modele-a', baseUrl: base });
    const err = await m.runWithTools({ system: 'S', history: [], user: 'q', tools: [], callTool: async () => ({}), maxRounds: 1, signal: new AbortController().signal }).catch((e) => e as GeminiError);
    expect(err).toBeInstanceOf(GeminiError);
    expect((err as GeminiError).code).toBe('RESOURCE_EXHAUSTED');
    expect((err as GeminiError).message).toMatch(/Quota Gemini atteint/);
    expect((err as GeminiError).message).not.toContain(FAKE_KEY);
    mode = 'tools';
  });
});
