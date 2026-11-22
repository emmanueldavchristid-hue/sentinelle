import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BeaconsData, IncidentData, ToolResult } from '@sentinelle/contracts';
import { buildApp } from '../src/app.js';
import { type Db, migrate } from '../src/db.js';
import { checkAlertEmail, incidentLink, incidentMail, MailError, maskEmail, resendMailer, type MailMessage, type Mailer } from '../src/notify.js';
import { resetAndSeed } from '../src/seed.js';
import { openTestDb } from './helpers.js';

/**
 * E-mail d'alerte : testé contre un faux fournisseur (aucun message réel ne part d'ici). L'essai réel se fait à la demande,
 * par « pnpm alert:check --envoyer », vers le destinataire de test configuré.
 */
const FAKE_KEY = 're_cle_fictive_de_test_0123456789';
const FARMER = { 'x-demo-user': 'U-ELEVEUR' };
const OK = { enabled: true, provider: 'resend', apiKey: FAKE_KEY, to: 'yvan@exemple.org', from: 'Sentinelle <onboarding@resend.dev>', publicUrl: 'https://demo.exemple.org' };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Configuration de l’e-mail d’alerte', () => {
  it('désactivé par défaut ; chaque manque est nommé, jamais la valeur de la clé', () => {
    expect(checkAlertEmail({ ...OK, enabled: false })).toMatchObject({ ready: false, reason: expect.stringMatching(/ALERT_EMAIL=on/) });
    expect(checkAlertEmail({ ...OK, apiKey: '' }).reason).toMatch(/RESEND_API_KEY/);
    expect(checkAlertEmail({ ...OK, to: 'pas une adresse' }).reason).toMatch(/ALERT_EMAIL_TO/);
    expect(checkAlertEmail({ ...OK, to: 'a@b.fr, c@d.fr' }).reason).toMatch(/une seule/);
    expect(checkAlertEmail({ ...OK, publicUrl: '' }).reason).toMatch(/PUBLIC_URL/);
    expect(checkAlertEmail({ ...OK, provider: 'autre' }).reason).toMatch(/inconnu/);
    expect(checkAlertEmail(OK)).toEqual({ ready: true, reason: null });
    for (const c of [{ ...OK, enabled: false }, { ...OK, to: '' }, { ...OK, publicUrl: '' }]) expect(checkAlertEmail(c).reason).not.toContain(FAKE_KEY);
    expect(maskEmail('yvan@exemple.org')).toBe('y•••@exemple.org');
  });

  it('message : faits de l’incident, lien direct sans secret ni coordonnée, source simulée dite', () => {
    const n = { mailer: {} as Mailer, to: OK.to, publicUrl: 'https://demo.exemple.org/' };
    const m = incidentMail(n, { incidentId: 'INC-1A2B3', label: 'Poulet <A>', animalId: 'B-071', radiusM: 20, distanceM: 45.4, accuracyM: 5, simulated: false, observedAt: '22/11/2026 01:02:03' });
    expect(m.to).toBe(OK.to);
    expect(m.subject).toBe('[Sentinelle, démonstration] Balise « Poulet <A> » hors de sa zone');
    expect(m.text).toContain('La balise de démonstration « Poulet <A> », associée à B-071, a été mesurée hors de sa zone le 22/11/2026 01:02:03.');
    expect(m.text).toContain('Mesure : 45 m du repère (précision ± 5 m), pour un seuil de 20 m. Source : GPS du téléphone.');
    expect(m.text).toContain('https://demo.exemple.org/#/elevage/incident/INC-1A2B3');
    expect(m.text).toContain('données synthétiques');
    expect(m.text).not.toMatch(/évad|latitude|longitude|token|jeton/i);
    // Le nom libre de la balise ne peut pas injecter de balisage dans le message.
    expect(m.html).toContain('Poulet &lt;A&gt;');
    expect(m.html).not.toContain('<A>');
    expect(m.idempotencyKey).toBe('sentinelle-incident/INC-1A2B3');
    expect(incidentMail(n, { incidentId: 'INC-1', label: 'X', animalId: null, radiusM: 30, distanceM: 50, accuracyM: null, simulated: true, observedAt: 'x' }).text).toMatch(/distance SIMULÉE à la main/);
    expect(incidentLink('https://a.b/', 'INC-9')).toBe('https://a.b/#/elevage/incident/INC-9');
  });
});

describe('Fournisseur Resend (faux serveur local)', () => {
  let server: Server;
  let base = '';
  const seen: { headers: IncomingMessage['headers']; url: string; body: Record<string, unknown> }[] = [];
  let next: { status: number; body: unknown } = { status: 200, body: { id: 'msg-123' } };
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        seen.push({ headers: req.headers, url: req.url ?? '', body: JSON.parse(raw || '{}') });
        res.writeHead(next.status, { 'content-type': 'application/json' }).end(JSON.stringify(next.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const msg: MailMessage = { to: 'yvan@exemple.org', subject: 'Sujet', text: 'Texte', html: '<p>Texte</p>', idempotencyKey: 'sentinelle-incident/INC-1' };

  it('envoi : clé en en-tête, agent utilisateur, clé d’idempotence, corps attendu, identifiant rendu', async () => {
    const mailer = resendMailer({ apiKey: FAKE_KEY, from: 'Sentinelle <onboarding@resend.dev>', baseUrl: base });
    expect(await mailer.send(msg)).toEqual({ id: 'msg-123' });
    const r = seen.at(-1)!;
    expect(r.url).toBe('/emails');
    expect(r.url).not.toContain(FAKE_KEY);
    expect(r.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(r.headers['user-agent']).toBe('sentinelle-demo/1.0');
    expect(r.headers['idempotency-key']).toBe('sentinelle-incident/INC-1');
    expect(r.body).toEqual({ from: 'Sentinelle <onboarding@resend.dev>', to: ['yvan@exemple.org'], subject: 'Sujet', text: 'Texte', html: '<p>Texte</p>' });
  });

  it('refus du fournisseur : message clair selon le cas, jamais la clé', async () => {
    const mailer = resendMailer({ apiKey: FAKE_KEY, from: 'x@resend.dev', baseUrl: base });
    const fail = async (status: number, body: unknown) => {
      next = { status, body };
      const e = await mailer.send(msg).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(MailError);
      expect((e as MailError).message).not.toContain(FAKE_KEY);
      return e as MailError;
    };
    expect((await fail(401, { name: 'validation_error', message: `API key is invalid ${FAKE_KEY}` })).code).toBe('KEY');
    expect((await fail(403, { name: 'validation_error', message: 'You can only send testing emails to your own email address (a@b.c).' })).code).toBe('RECIPIENT');
    expect((await fail(403, { name: 'validation_error', message: 'The exemple.org domain is not verified.' })).code).toBe('RECIPIENT');
    const quota = await fail(429, { name: 'daily_quota_exceeded', message: 'You have exceeded your daily email sending quota.' });
    expect(quota.code).toBe('QUOTA');
    expect(quota.message).toBe('Quota d’envoi du service atteint.');
    expect((await fail(422, { name: 'missing_required_field', message: 'Missing `to` field.' })).code).toBe('VALIDATION');
    expect((await fail(500, { name: 'application_error' })).code).toBe('PROVIDER');
    next = { status: 200, body: { id: 'msg-123' } };
    const down = await resendMailer({ apiKey: FAKE_KEY, from: 'x@resend.dev', baseUrl: 'http://127.0.0.1:1' }).send(msg).catch((x: unknown) => x);
    expect((down as MailError).code).toBe('NETWORK');
  });
});

describe('Incident d’éloignement : un e-mail par épisode, statut réel conservé', () => {
  let db: Db;
  beforeAll(async () => {
    db = await openTestDb();
    await migrate(db);
    await resetAndSeed(db, { living: true });
  });
  afterAll(async () => {
    await db.close();
  });

  async function rig(mailer: Mailer | null) {
    const app = await buildApp({ db, demoMode: true, alertEmail: { notifier: mailer ? { mailer, to: 'yvan@exemple.org', publicUrl: 'https://demo.exemple.org' } : null, reason: mailer ? null : 'E-mail d’alerte non activé (ALERT_EMAIL=on dans le fichier .env pour l’activer).' } });
    const { id, token } = (await app.inject({ method: 'POST', url: '/api/farm/devices', headers: FARMER, payload: { label: 'Poulet A', animalId: 'B-071', radiusM: 20 } })).json();
    const send = async (distanceM: number, accuracyM: number | null = 3) => {
      await wait(950);
      expect((await app.inject({ method: 'POST', url: `/api/devices/${id}/readings`, headers: { 'x-device-token': token }, payload: { source: 'PHONE_GPS', observedAt: new Date().toISOString(), distanceM, accuracyM } })).statusCode).toBe(201);
    };
    const incident = async () => (await app.inject({ url: '/api/farm/incidents/latest', headers: FARMER })).json() as ToolResult<IncidentData>;
    const stop = async () => {
      await app.inject({ method: 'POST', url: `/api/farm/devices/${id}/stop`, headers: FARMER });
      await app.close();
    };
    return { app, id, send, incident, stop };
  }
  const settled = async (read: () => Promise<ToolResult<IncidentData>>) => {
    for (let i = 0; i < 100; i++) {
      const r = await read();
      if (r.data?.email && r.data.email.status !== 'SENDING') return r;
      await wait(20);
    }
    throw new Error('statut d’envoi jamais arrêté');
  };

  it('envoi activé : un message à l’ouverture de l’incident, aucun pour les mesures suivantes, un nouveau au nouvel épisode', async () => {
    const sent: MailMessage[] = [];
    const r = await rig({ provider: 'Faux fournisseur', send: async (m) => (sent.push(m), { id: 'msg-1' }) });
    await r.send(5);
    expect(sent).toHaveLength(0);
    await r.send(45);
    await r.send(60);
    await r.send(70);
    const first = await settled(r.incident);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('yvan@exemple.org');
    expect(sent[0]!.text).toContain(`https://demo.exemple.org/#/elevage/incident/${first.data.id}`);
    expect(sent[0]!.text).toContain('« Poulet A », associée à B-071');
    expect(sent[0]!.idempotencyKey).toBe(`sentinelle-incident/${first.data.id}`);
    // Le statut gardé est celui du fournisseur : accepté, pour une adresse masquée. Jamais « reçu » ni « lu ».
    expect(first.data.email).toMatchObject({ status: 'SENT', provider: 'Faux fournisseur', to: 'y•••@exemple.org', error: null });
    const text = first.statements.map((s) => s.text).join(' | ');
    expect(text).toMatch(/Un e-mail d’alerte a été accepté par le service d’envoi \(Faux fournisseur\) à \d{2}:\d{2}:\d{2}, pour y•••@exemple\.org\. Accepté ne veut pas dire lu\./);
    expect(text).not.toContain('yvan@exemple.org');
    expect(first.statements.at(-1)!.text).toMatch(/^État actuel\./);
    expect(first.limits.join(' ')).toMatch(/Un e-mail d’alerte au plus part par épisode/);
    const health = (await r.app.inject({ url: '/api/health' })).json() as { alertEmail: Record<string, unknown> };
    expect(health.alertEmail).toEqual({ enabled: true, provider: 'Faux fournisseur', to: 'y•••@exemple.org', reason: null });
    const list = (await r.app.inject({ url: '/api/farm/devices', headers: FARMER })).json() as ToolResult<BeaconsData>;
    expect(list.data.incidents![0]!.email?.status).toBe('SENT');

    await r.send(4);
    await r.send(50);
    const second = await settled(r.incident);
    expect(second.data.id).not.toBe(first.data.id);
    expect(sent).toHaveLength(2);
    await r.stop();
  });

  it('échec du fournisseur : l’incident existe quand même, et l’échec est dit avec sa raison', async () => {
    const r = await rig({
      provider: 'Faux fournisseur',
      send: async () => {
        throw new MailError('QUOTA', 'Quota d’envoi du service atteint.');
      },
    });
    await r.send(45);
    const inc = await settled(r.incident);
    expect(inc.data.email).toMatchObject({ status: 'FAILED', error: 'Quota d’envoi du service atteint.' });
    expect(inc.statements.map((s) => s.text).join(' ')).toMatch(/L’e-mail d’alerte n’est pas parti\. Quota d’envoi du service atteint\./);
    await r.stop();
  });

  it('envoi non activé : aucun message, et la lecture de l’incident le dit', async () => {
    const r = await rig(null);
    await r.send(45);
    await wait(150);
    const inc = await r.incident();
    expect(inc.data.email).toBeNull();
    expect(inc.statements.map((s) => s.text).join(' ')).toMatch(/Aucun e-mail n’a été envoyé pour cet incident : l’envoi d’e-mails n’est pas activé sur ce serveur\./);
    expect(inc.limits.join(' ')).toMatch(/aucun message n’est envoyé/);
    const health = (await r.app.inject({ url: '/api/health' })).json() as { alertEmail: { enabled: boolean; reason: string } };
    expect(health.alertEmail.enabled).toBe(false);
    expect(health.alertEmail.reason).toMatch(/ALERT_EMAIL=on/);
    await r.stop();
  });
});
