import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import {
  type AnalysisOutput,
  type AnalysisParams,
  type DataSnapshot,
  type Movement,
  type Presence,
  analyze,
  diffAnalyses,
  ENGINE_VERSION,
  bounds,
  presenceBounds,
  RULE_RB1,
  stableStringify,
} from '@sentinelle/domain';
import {
  type ApiError,
  CreateInvestigationSchema,
  ObservationSyncSchema,
  RecordCorrectionSchema,
  RecordDataSchema,
  RunRequestSchema,
} from '@sentinelle/contracts';
import type { Db, Queryable } from './db.js';
import { resetAndSeed } from './seed.js';
import { HttpError, parse, sha256, type User } from './http.js';
import { findReplay, lock, requestHash, saveReplay } from './idempotency.js';
import { type AuthConfig, registerAuth, sessionUser } from './auth.js';
import { registerImport } from './import.js';
import { registerFarm } from './farm.js';
import { registerBeacons, shareBeaconReads } from './beacons.js';
import { type AssistantOptions, registerAssistant } from './assistant.js';
import { registerLive } from './live.js';
import { registerBaoule, type BaouleOptions } from './baoule.js';
import { maskEmail, type AlertNotifier } from './notify.js';
import { type StructuringProvider, type SummaryProvider, registerAssist, structuringFromLlm, summaryFromLlm } from './assist.js';
import type { LlmClient } from './llm.js';

export interface AppOptions {
  db: Db;
  demoMode: boolean;
  webDist?: string;
  logger?: boolean;
  auth?: Partial<AuthConfig>;
  /** Client LLM configuré côté serveur (null = IA désactivée). */
  llm?: LlmClient | null;
  /** Surcharges pour les tests. */
  structuringProvider?: StructuringProvider | null;
  summaryProvider?: SummaryProvider | null;
  aiLimits?: { timeoutMs?: number; maxCallsPerDay?: number };
  /** Assistant « Parler à mon élevage » : modèle configuré côté serveur (absent = lecture directe, sans IA). */
  assistant?: AssistantOptions;
  /** E-mail d'alerte d'éloignement : prêt à envoyer (notifier), ou la raison pour laquelle il ne l'est pas. Absent = désactivé. */
  alertEmail?: { notifier: AlertNotifier | null; reason: string | null };
  /** Voix en baoulé par un service local de parole ; absente ou null = non proposée. */
  baoule?: BaouleOptions | null;
  /** Durée (ms) pendant laquelle une lecture des balises est partagée entre tous les écrans d'une organisation. 0 ou absent : chaque demande relit. */
  beaconReadCacheMs?: number;
  /** Version servie (commit Git relevé au démarrage) : permet de savoir, depuis le lien public, quelle version répond. */
  version?: string;
}

export async function buildApp(opts: AppOptions) {
  const { db } = opts;
  const startedAt = new Date().toISOString();
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof HttpError) {
      const body: ApiError & Record<string, unknown> = { error: err.code, message: err.message, ...err.extra };
      return reply.status(err.status).send(body);
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: 'BAD_REQUEST', message: 'Requête invalide' });
    app.log.error(err);
    if (!opts.logger) console.error('[sentinelle] erreur 500 :', err);
    return reply.status(500).send({ error: 'INTERNAL', message: 'Erreur interne du serveur' });
  });

  // En-têtes de sécurité de base.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    // Micro : dictée seulement, sur action explicite. Position : suivi des balises (page « balise », et suivi automatique en mode
    // démonstration) ; le navigateur demande l'autorisation, et un bandeau dit sur l'appareil qu'il est suivi.
    reply.header('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self)');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    return payload;
  });

  // Requêtes modifiantes hors mode démo : l'en-tête Origin, s'il est présent, doit correspondre à l'hôte (protection CSRF en plus de SameSite=Strict).
  app.addHook('onRequest', async (req) => {
    if (opts.demoMode || req.method === 'GET' || req.method === 'HEAD') return;
    const origin = req.headers.origin;
    if (!origin) return;
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    if (host !== req.headers.host) throw new HttpError(403, 'FORBIDDEN', 'Origine refusée');
  });

  /**
   * Session.
   * - Mode démonstration : en-tête x-demo-user (sélecteur de rôle, PAS une authentification sécurisée).
   * - Hors mode démonstration : cookie de session httpOnly obtenu par identifiant + mot de passe.
   */
  async function currentUser(req: FastifyRequest): Promise<User> {
    const fromCookie = await sessionUser(db, req);
    if (fromCookie) return fromCookie;
    if (!opts.demoMode) throw new HttpError(401, 'UNAUTHENTICATED', 'Connexion requise');
    const id = req.headers['x-demo-user'];
    if (typeof id !== 'string' || !id) throw new HttpError(401, 'UNAUTHENTICATED', 'Choisissez un rôle (mode démonstration)');
    const u = (await db.query<User>('SELECT id, org_id, name, role FROM users WHERE id = $1', [id])).rows[0];
    if (!u) throw new HttpError(401, 'UNAUTHENTICATED', 'Utilisateur de démonstration inconnu');
    return u;
  }
  function requireRole(u: User, ...roles: User['role'][]) {
    if (!roles.includes(u.role)) throw new HttpError(403, 'FORBIDDEN', 'Accès refusé pour ce rôle');
  }
  async function audit(q: Queryable, u: User | null, action: string, entity: string, entityId: string, detail: unknown = {}) {
    await q.query('INSERT INTO audit_events(org_id, actor_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5,$6)', [
      u?.org_id ?? null,
      u?.id ?? null,
      action,
      entity,
      entityId,
      JSON.stringify(detail),
    ]);
  }

  // ---------- Lecture des données courantes (dernière révision de chaque enregistrement) ----------
  async function currentRecords(q: Queryable, orgId: string): Promise<(Presence | Movement)[]> {
    const rows = (
      await q.query<{ record_id: string; rev: number; data: unknown }>(
        `SELECT DISTINCT ON (record_id) record_id, rev, data FROM record_revisions WHERE org_id = $1 ORDER BY record_id, rev DESC`,
        [orgId],
      )
    ).rows;
    return rows.map((r) => ({ id: r.record_id, rev: r.rev, ...(typeof r.data === 'string' ? JSON.parse(r.data) : (r.data as object)) }) as Presence | Movement);
  }

  async function buildSnapshot(q: Queryable, orgId: string): Promise<DataSnapshot> {
    const animals = (await q.query<{ id: string; tag: string }>('SELECT id, tag FROM animals WHERE org_id = $1 ORDER BY id', [orgId])).rows;
    const locations = (
      await q.query<{ id: string; code: string; name: string; kind: 'FARM' | 'MARKET'; pos_x: number | null; pos_y: number | null }>(
        'SELECT id, code, name, kind, pos_x, pos_y FROM locations WHERE org_id = $1 ORDER BY id',
        [orgId],
      )
    ).rows.map((l) => ({ id: l.id, code: l.code, name: l.name, kind: l.kind, ...(l.pos_x != null ? { position: { x: Number(l.pos_x), y: Number(l.pos_y) } } : {}) }));
    const recs = await currentRecords(q, orgId);
    return {
      animals,
      locations,
      presences: recs.filter((r): r is Presence => r.kind === 'presence'),
      movements: recs.filter((r): r is Movement => r.kind === 'movement'),
    };
  }

  const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

  async function runAnalysis(q: Queryable, u: User, investigationId: string, params: AnalysisParams) {
    await lock(q, `investigation:${investigationId}`);
    const snapshot = await buildSnapshot(q, u.org_id);
    const output = analyze(snapshot, params);
    const snapshotHash = sha256(stableStringify(snapshot));
    const seq = Number((await q.query<{ n: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM analysis_runs WHERE investigation_id = $1', [investigationId])).rows[0]!.n);
    await q.query(
      `INSERT INTO analysis_runs(id, investigation_id, seq, engine_version, params, snapshot, snapshot_hash, output, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [randomUUID(), investigationId, seq, ENGINE_VERSION, JSON.stringify(params), JSON.stringify(snapshot), snapshotHash, JSON.stringify(output), u.id],
    );
    // Tâches de vérification proposées par le moteur (une par enregistrement et type, sans doublon).
    for (const r of output.results) {
      if (!r.task) continue;
      await q.query(
        `INSERT INTO verification_tasks(id, org_id, investigation_id, record_id, kind, label) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (investigation_id, record_id, kind) DO NOTHING`,
        [randomUUID(), u.org_id, investigationId, r.task.recordId, r.task.kind, r.task.label],
      );
    }
    await audit(q, u, 'ANALYSIS_RUN', 'investigation', investigationId, { seq, snapshotHash, engineVersion: ENGINE_VERSION });
    return { seq, snapshotHash };
  }

  async function getInvestigation(q: Queryable, u: User, id: string) {
    if (!z.uuid().safeParse(id).success) throw new HttpError(404, 'NOT_FOUND', 'Enquête introuvable');
    const inv = (await q.query<{ id: string; org_id: string; observation_id: string; status: string; created_at: string }>('SELECT * FROM investigations WHERE id = $1', [id])).rows[0];
    // Isolation des organisations : un dossier d'une autre organisation est indiscernable d'un dossier inexistant.
    if (!inv || inv.org_id !== u.org_id) throw new HttpError(404, 'NOT_FOUND', 'Enquête introuvable');
    return inv;
  }

  function observationDto(o: Record<string, unknown>) {
    return {
      id: o.id,
      animalId: o.animal_id,
      locationId: o.location_id,
      eventTime: json(o.event_time),
      note: o.note,
      authorId: o.author_id,
      recordedAtClient: o.recorded_at_client,
      receivedAt: o.received_at,
      status: o.status,
      investigationId: o.investigation_id ?? null,
    };
  }

  // ---------- Routes publiques ----------
  const ctx = { app, db, demoMode: opts.demoMode, currentUser, requireRole, audit: (q: Queryable, u: User | null, a: string, e: string, id: string, d?: unknown) => audit(q, u, a, e, id, d) };
  registerAuth(ctx, opts.auth);
  registerImport(ctx);
  const notifier = opts.alertEmail?.notifier ?? null;
  const farm = registerFarm(ctx, { emailReady: !!notifier });
  shareBeaconReads(db, opts.beaconReadCacheMs ?? 0);
  registerBeacons(ctx, notifier);
  const live = registerLive(ctx, farm, opts.assistant?.live ?? null);
  const baoule = registerBaoule(ctx, farm, opts.baoule ?? null);
  const assistant = registerAssistant(ctx, farm, { ...(opts.assistant ?? { model: null }), liveStatus: live.status, baouleStatus: baoule.status });
  const llm = opts.llm ?? null;
  const assist = registerAssist(
    { ...ctx, getInvestigation },
    {
      structuring: opts.structuringProvider !== undefined ? opts.structuringProvider : llm ? structuringFromLlm(llm) : null,
      summary: opts.summaryProvider !== undefined ? opts.summaryProvider : llm ? summaryFromLlm(llm) : null,
    },
    opts.aiLimits,
  );

  app.get('/api/health', async () => ({
    ok: true,
    db: db.mode,
    demoMode: opts.demoMode,
    engineVersion: ENGINE_VERSION,
    version: opts.version ?? null,
    startedAt,
    ai: assist.status(),
    assistant: assistant.status(),
    // E-mail d'alerte : état sans valeur secrète ; le destinataire n'apparaît que masqué.
    alertEmail: notifier ? { enabled: true, provider: notifier.mailer.provider, to: maskEmail(notifier.to), reason: null } : { enabled: false, provider: null, to: null, reason: opts.alertEmail?.reason ?? 'E-mail d’alerte non activé sur ce serveur.' },
    serverTime: new Date().toISOString(),
  }));

  app.get('/api/demo/users', async () => {
    if (!opts.demoMode) throw new HttpError(404, 'NOT_FOUND', 'Mode démonstration désactivé');
    const rows = (await db.query<User & { org_name: string }>('SELECT u.id, u.name, u.role, u.org_id, o.name AS org_name FROM users u JOIN organizations o ON o.id = u.org_id ORDER BY u.org_id, u.role, u.id')).rows;
    return { mode: 'Mode démonstration — pas d’authentification sécurisée', users: rows };
  });

  app.post('/api/demo/reset', async (req) => {
    if (!opts.demoMode) throw new HttpError(403, 'FORBIDDEN', 'Réinitialisation désactivée hors mode démonstration');
    // En-tête personnalisé obligatoire : une page d'un autre site ne peut pas l'envoyer sans autorisation CORS (protection CSRF).
    if (req.headers['x-sentinelle-demo'] !== 'reset') throw new HttpError(403, 'FORBIDDEN', 'Réinitialisation refusée : en-tête de confirmation manquant');
    const origin = req.headers.origin;
    if (origin) {
      let host: string | null = null;
      try {
        host = new URL(origin).host;
      } catch {
        host = null;
      }
      if (host !== req.headers.host) throw new HttpError(403, 'FORBIDDEN', 'Origine refusée');
    }
    const body = (req.body ?? {}) as { withObservation?: unknown };
    await resetAndSeed(db, { withObservation: body.withObservation === true, living: true });
    return { ok: true };
  });

  // ---------- Session ----------
  app.get('/api/me', async (req) => {
    const u = await currentUser(req);
    const org = (await db.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [u.org_id])).rows[0];
    return { ...u, orgName: org?.name };
  });

  // ---------- Référentiel ----------
  app.get('/api/locations', async (req) => {
    const u = await currentUser(req);
    return (await db.query('SELECT id, code, name, kind, pos_x AS "x", pos_y AS "y" FROM locations WHERE org_id = $1 ORDER BY code', [u.org_id])).rows;
  });

  async function animalCard(q: Queryable, u: User, id: string) {
    const animal = (await q.query<{ id: string; tag: string; species: string }>('SELECT id, tag, species FROM animals WHERE id = $1 AND org_id = $2', [id, u.org_id])).rows[0];
    if (!animal) throw new HttpError(404, 'NOT_FOUND', 'Animal introuvable dans votre périmètre');
    const recs = (await currentRecords(q, u.org_id)).filter((r) => r.animalId === id);
    const presences = recs.filter((r): r is Presence => r.kind === 'presence').sort((a, b) => presenceBounds(a.start, a.end).startMax - presenceBounds(b.start, b.end).startMax);
    const movements = recs.filter((r): r is Movement => r.kind === 'movement');
    const open = presences.find((p) => p.end === null);
    const observations = (
      await q.query('SELECT o.*, i.id AS investigation_id FROM observations o LEFT JOIN investigations i ON i.observation_id = o.id WHERE o.animal_id = $1 AND o.org_id = $2 ORDER BY o.received_at DESC', [id, u.org_id])
    ).rows.map(observationDto);
    return { animal, currentLocationId: open?.locationId ?? null, presences, movements, observations };
  }

  app.get('/api/animals', async (req) => {
    const u = await currentUser(req);
    const qs = parse(z.object({ q: z.string().max(40).optional() }), req.query ?? {});
    const term = `%${(qs.q ?? '').trim().toUpperCase()}%`;
    const animals = (await db.query<{ id: string; tag: string; species: string }>('SELECT id, tag, species FROM animals WHERE org_id = $1 AND UPPER(tag) LIKE $2 ORDER BY tag LIMIT 50', [u.org_id, term])).rows;
    const recs = await currentRecords(db, u.org_id);
    return animals.map((a) => ({ ...a, currentLocationId: recs.find((r) => r.kind === 'presence' && r.animalId === a.id && r.end === null)?.['locationId' as never] ?? null }));
  });

  app.get('/api/animals/:id', async (req) => {
    const u = await currentUser(req);
    return animalCard(db, u, (req.params as { id: string }).id);
  });

  /** Préchargement limité des fiches autorisées, pour consultation hors connexion. */
  app.get('/api/preload', async (req) => {
    const u = await currentUser(req);
    const ids = (await db.query<{ id: string }>('SELECT id FROM animals WHERE org_id = $1 ORDER BY tag LIMIT 50', [u.org_id])).rows;
    const locations = (await db.query('SELECT id, code, name, kind, pos_x AS "x", pos_y AS "y" FROM locations WHERE org_id = $1 ORDER BY code', [u.org_id])).rows;
    const cards = [];
    for (const { id } of ids) cards.push(await animalCard(db, u, id));
    return { generatedAt: new Date().toISOString(), locations, cards };
  });

  // ---------- Synchronisation des observations (idempotente) ----------
  app.post('/api/sync/observations', async (req, reply: FastifyReply) => {
    const u = await currentUser(req);
    const body = parse(ObservationSyncSchema, req.body);
    const fields: Record<string, string> = {};
    if (!(await db.query('SELECT 1 FROM animals WHERE id = $1 AND org_id = $2', [body.animalId, u.org_id])).rows.length) fields.animalId = 'Animal inconnu dans votre périmètre';
    if (!(await db.query('SELECT 1 FROM locations WHERE id = $1 AND org_id = $2', [body.locationId, u.org_id])).rows.length) fields.locationId = 'Lieu inconnu dans votre périmètre';
    if (Object.keys(fields).length) throw new HttpError(400, 'VALIDATION', 'Données invalides', { fields });

    const inserted = await db.tx(async (q) => {
      const r = await q.query(
        `INSERT INTO observations(id, idempotency_key, payload_version, org_id, animal_id, location_id, event_time, note, author_id, recorded_at_client)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING *`,
        [body.clientId, body.idempotencyKey, body.payloadVersion, u.org_id, body.animalId, body.locationId, JSON.stringify(body.eventTime), body.note, u.id, body.recordedAtClient],
      );
      if (r.rows[0]) await audit(q, u, 'OBSERVATION_RECEIVED', 'observation', body.clientId);
      return r.rows[0];
    });
    if (inserted) return reply.status(201).send({ duplicate: false, observation: observationDto(inserted) });
    // Rejeu (réponse perdue, double envoi) : on renvoie l'enregistrement existant, sans doublon.
    const existing = (await db.query('SELECT * FROM observations WHERE idempotency_key = $1 AND org_id = $2 AND author_id = $3 AND id = $4', [body.idempotencyKey, u.org_id, u.id, body.clientId])).rows[0];
    if (!existing) throw new HttpError(409, 'CONFLICT', 'Identifiant client déjà utilisé par une autre opération');
    // Le reçu dit la vérité : un rejeu n'est un doublon que si le contenu est identique. Sinon rien n'est modifié et on le dit.
    const same =
      existing.animal_id === body.animalId &&
      existing.location_id === body.locationId &&
      existing.note === body.note &&
      stableStringify(json(existing.event_time)) === stableStringify(body.eventTime);
    if (!same) {
      throw new HttpError(409, 'CONTENT_MISMATCH', 'Cette déclaration a déjà été reçue avec un contenu différent : rien n’a été modifié. Pour corriger, enregistrez une nouvelle observation.', {
        observation: observationDto(existing),
      });
    }
    return reply.status(200).send({ duplicate: true, observation: observationDto(existing) });
  });

  // ---------- Signalements ----------
  app.get('/api/observations', async (req) => {
    const u = await currentUser(req);
    requireRole(u, 'VET');
    return (
      await db.query('SELECT o.*, i.id AS investigation_id FROM observations o LEFT JOIN investigations i ON i.observation_id = o.id WHERE o.org_id = $1 ORDER BY o.received_at DESC', [u.org_id])
    ).rows.map(observationDto);
  });

  app.post('/api/observations/:id/close', async (req) => {
    const u = await currentUser(req);
    requireRole(u, 'VET');
    const id = (req.params as { id: string }).id;
    const body = parse(z.object({ note: z.string().trim().min(3, 'Motif requis').max(500) }), req.body);
    const r = await db.query(
      `UPDATE observations SET status = 'CLOSED', reviewed_by = $1, reviewed_at = now(), review_note = $2 WHERE id::text = $3 AND org_id = $4 AND status = 'NEW' RETURNING id`,
      [u.id, body.note, id, u.org_id],
    );
    if (!r.rows.length) throw new HttpError(404, 'NOT_FOUND', 'Signalement introuvable ou déjà traité');
    await audit(db, u, 'OBSERVATION_CLOSED', 'observation', id, body);
    return { ok: true };
  });

  // ---------- Enquêtes ----------
  app.post('/api/investigations', async (req, reply) => {
    const u = await currentUser(req);
    requireRole(u, 'VET');
    const body = parse(CreateInvestigationSchema, req.body);
    const result = await db.tx(async (q) => {
      await lock(q, `observation:${body.observationId}`);
      const obs = (await q.query<{ id: string; animal_id: string; status: string }>('SELECT id, animal_id, status FROM observations WHERE id = $1 AND org_id = $2', [body.observationId, u.org_id])).rows[0];
      if (!obs) throw new HttpError(404, 'NOT_FOUND', 'Signalement introuvable');
      const existing = (await q.query<{ id: string }>('SELECT id FROM investigations WHERE observation_id = $1', [obs.id])).rows[0];
      if (existing) return { id: existing.id, created: false };
      if (obs.status !== 'NEW') throw new HttpError(409, 'CONFLICT', 'Signalement déjà classé');
      const id = randomUUID();
      await q.query('INSERT INTO investigations(id, org_id, observation_id, created_by) VALUES ($1,$2,$3,$4)', [id, u.org_id, obs.id, u.id]);
      await q.query(`UPDATE observations SET status = 'UNDER_INVESTIGATION', reviewed_by = $1, reviewed_at = now() WHERE id = $2`, [u.id, obs.id]);
      await audit(q, u, 'INVESTIGATION_OPENED', 'investigation', id, { observationId: obs.id });
      await runAnalysis(q, u, id, { subjectAnimalId: obs.animal_id, window: body.window, rules: [RULE_RB1], maxDepth: body.maxDepth, maxResults: 200, minOverlapMinutes: 0 });
      return { id, created: true };
    });
    return reply.status(result.created ? 201 : 200).send(result);
  });

  app.get('/api/investigations', async (req) => {
    const u = await currentUser(req);
    requireRole(u, 'VET');
    return (
      await db.query(
        `SELECT i.id, i.status, i.created_at AS "createdAt", o.animal_id AS "animalId", o.location_id AS "locationId", o.note
         FROM investigations i JOIN observations o ON o.id = i.observation_id WHERE i.org_id = $1 ORDER BY i.created_at DESC`,
        [u.org_id],
      )
    ).rows;
  });

  app.get('/api/investigations/:id', async (req) => {
    const u = await currentUser(req);
    requireRole(u, 'VET');
    const inv = await getInvestigation(db, u, (req.params as { id: string }).id);
    const obs = (await db.query('SELECT o.*, i.id AS investigation_id FROM observations o LEFT JOIN investigations i ON i.observation_id = o.id WHERE o.id = $1', [inv.observation_id])).rows[0]!;
    const runs = (
      await db.query<{ seq: number; engine_version: string; snapshot_hash: string; created_at: string; params: unknown; output: unknown }>(
        'SELECT seq, engine_version, snapshot_hash, created_at, params, output FROM analysis_runs WHERE investigation_id = $1 ORDER BY seq',
        [inv.id],
      )
    ).rows.map((r) => {
      const out = json<AnalysisOutput>(r.output);
      const counts: Record<string, number> = {};
      for (const x of out.results) counts[x.status] = (counts[x.status] ?? 0) + 1;
      return { seq: r.seq, engineVersion: r.engine_version, snapshotHash: r.snapshot_hash, createdAt: r.created_at, params: json(r.params), counts };
    });
    const tasks = (
      await db.query(
        `SELECT id, record_id AS "recordId", kind, label, status, created_at AS "createdAt", requested_at AS "requestedAt", done_at AS "doneAt", done_rev AS "doneRev"
         FROM verification_tasks WHERE investigation_id = $1 ORDER BY kind DESC, record_id`,
        [inv.id],
      )
    ).rows;
    const locations = (await db.query('SELECT id, code, name, kind, pos_x AS "x", pos_y AS "y" FROM locations WHERE org_id = $1 ORDER BY code', [u.org_id])).rows;
    return { investigation: { id: inv.id, status: inv.status, createdAt: inv.created_at }, observation: observationDto(obs), runs, tasks, locations };
  });

  app.get('/api/investigations/:id/runs/:seq', async (req) => {
    const u = await currentUser(req);
    requireRole(u, 'VET');
    const p = req.params as { id: string; seq: string };
    const inv = await getInvestigation(db, u, p.id);
    const r = (await db.query<Record<string, unknown>>('SELECT * FROM analysis_runs WHERE investigation_id = $1 AND seq = $2', [inv.id, Number(p.seq) || 0])).rows[0];
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'Analyse introuvable');
    const snapshot = json<DataSnapshot>(r.snapshot);
    const output = json<AnalysisOutput>(r.output);
    // Enregistrements justificatifs, lus dans l'INSTANTANÉ de cette analyse (pas dans l'état courant).
    const ids = new Set(output.results.flatMap((x) => x.evidence.map((e) => e.recordId)));
    const evidenceRecords = Object.fromEntries([...snapshot.presences, ...snapshot.movements].filter((x) => ids.has(x.id)).map((x) => [x.id, x]));
    return { seq: r.seq, engineVersion: r.engine_version, snapshotHash: r.snapshot_hash, createdAt: r.created_at, params: json(r.params), output, evidenceRecords, animals: snapshot.animals };
  });

  app.post('/api/investigations/:id/runs', async (req, reply) => {
    const u = await currentUser(req);
    requireRole(u, 'VET');
    const inv = await getInvestigation(db, u, (req.params as { id: string }).id);
    const body = parse(RunRequestSchema, req.body);
    const obs = (await db.query<{ animal_id: string }>('SELECT animal_id FROM observations WHERE id = $1', [inv.observation_id])).rows[0]!;
    const r = await db.tx((q) =>
      runAnalysis(q, u, inv.id, { subjectAnimalId: obs.animal_id, window: body.window, rules: [RULE_RB1], maxDepth: body.maxDepth, maxResults: 200, minOverlapMinutes: body.minOverlapMinutes }),
    );
    return reply.status(201).send(r);
  });

  app.get('/api/investigations/:id/compare', async (req) => {
    const u = await currentUser(req);
    requireRole(u, 'VET');
    const inv = await getInvestigation(db, u, (req.params as { id: string }).id);
    const qs = parse(z.object({ a: z.coerce.number().int().min(1), b: z.coerce.number().int().min(1) }), req.query ?? {});
    const load = async (seq: number) => {
      const r = (await db.query<{ snapshot: unknown; output: unknown }>('SELECT snapshot, output FROM analysis_runs WHERE investigation_id = $1 AND seq = $2', [inv.id, seq])).rows[0];
      if (!r) throw new HttpError(404, 'NOT_FOUND', `Analyse n° ${seq} introuvable`);
      return { snapshot: json<DataSnapshot>(r.snapshot), output: json<AnalysisOutput>(r.output) };
    };
    const A = await load(qs.a);
    const B = await load(qs.b);
    return { a: qs.a, b: qs.b, ...diffAnalyses(A.output, B.output, A.snapshot, B.snapshot) };
  });

  // ---------- Tâches de vérification ----------
  app.get('/api/tasks', async (req) => {
    const u = await currentUser(req);
    const statuses = u.role === 'AGENT' ? ['REQUESTED', 'DONE'] : ['OPEN', 'REQUESTED', 'DONE'];
    const tasks = (
      await db.query<{ recordId: string } & Record<string, unknown>>(
        `SELECT id, investigation_id AS "investigationId", record_id AS "recordId", kind, label, status, requested_at AS "requestedAt", done_at AS "doneAt", done_rev AS "doneRev"
         FROM verification_tasks WHERE org_id = $1 AND status = ANY($2) ORDER BY status DESC, requested_at NULLS LAST, record_id`,
        [u.org_id, statuses],
      )
    ).rows;
    const recs = new Map((await currentRecords(db, u.org_id)).map((r) => [r.id, r]));
    return tasks.map((t) => ({ ...t, record: recs.get(t.recordId) ?? null }));
  });

  app.post('/api/tasks/:id/request', async (req) => {
    const u = await currentUser(req);
    requireRole(u, 'VET');
    const id = (req.params as { id: string }).id;
    const r = await db.query(`UPDATE verification_tasks SET status = 'REQUESTED', requested_at = now() WHERE id::text = $1 AND org_id = $2 AND status = 'OPEN' RETURNING id`, [id, u.org_id]);
    if (!r.rows.length) throw new HttpError(404, 'NOT_FOUND', 'Tâche introuvable ou déjà demandée');
    await audit(db, u, 'TASK_REQUESTED', 'task', id);
    return { ok: true };
  });

  // ---------- Correction : nouvelle révision, jamais d'écrasement ----------
  app.post('/api/records/:id/revisions', async (req, reply) => {
    const u = await currentUser(req);
    requireRole(u, 'AGENT');
    const recordId = (req.params as { id: string }).id;
    const body = parse(RecordCorrectionSchema, req.body);
    const hash = requestHash(body as Record<string, unknown>);
    const replay = await findReplay(db, body.idempotencyKey, u, 'record_revision', recordId, hash);
    if (replay) return reply.status(200).send({ ...replay, duplicate: true });

    if (body.kind === 'presence') {
      const b = presenceBounds(body.start, body.end);
      if (b.endMax < b.startMin) throw new HttpError(400, 'VALIDATION', 'Données invalides', { fields: { end: 'La fin doit suivre le début' } });
    } else if (bounds(body.arrival).max < bounds(body.departure).min) {
      throw new HttpError(400, 'VALIDATION', 'Données invalides', { fields: { arrival: 'L’arrivée doit suivre le départ' } });
    }

    const response = await db.tx(async (q) => {
      await lock(q, `record:${u.org_id}:${recordId}`);
      const again = await findReplay(q, body.idempotencyKey, u, 'record_revision', recordId, hash);
      if (again) return { ...(again as { recordId: string; rev: number; previousRev: number }), replayed: true };
      const cur = (
        await q.query<{ rev: number; kind: string; data: unknown }>('SELECT rev, kind, data FROM record_revisions WHERE record_id = $1 AND org_id = $2 ORDER BY rev DESC LIMIT 1', [recordId, u.org_id])
      ).rows[0];
      if (!cur) throw new HttpError(404, 'NOT_FOUND', 'Enregistrement introuvable');
      if (cur.kind !== body.kind) throw new HttpError(400, 'VALIDATION', 'Type de correction incompatible avec l’enregistrement');
      if (cur.rev !== body.baseRev) {
        throw new HttpError(409, 'CONFLICT', `Conflit : la révision ${cur.rev} existe déjà (vous corrigiez la révision ${body.baseRev}). Rien n’a été écrasé.`, {
          currentRev: cur.rev,
          current: json(cur.data),
        });
      }
      const prev = json<Record<string, unknown>>(cur.data);
      const changes = body.kind === 'presence' ? { start: body.start, end: body.end } : { departure: body.departure, arrival: body.arrival };
      const data = parse(RecordDataSchema, { ...prev, ...changes, verification: 'DECLARED', revisionNote: body.reason, source: `${u.name}` });
      const rev = cur.rev + 1;
      await q.query('INSERT INTO record_revisions(record_id, rev, org_id, kind, data, author_id, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)', [recordId, rev, u.org_id, body.kind, JSON.stringify(data), u.id, body.reason]);
      await q.query(`UPDATE verification_tasks SET status = 'DONE', done_at = now(), done_rev = $1 WHERE record_id = $2 AND org_id = $3 AND status <> 'DONE'`, [rev, recordId, u.org_id]);
      const res = { recordId, rev, previousRev: cur.rev };
      await saveReplay(q, body.idempotencyKey, u, 'record_revision', recordId, hash, res);
      await audit(q, u, 'RECORD_REVISED', 'record', recordId, { rev, reason: body.reason });
      return res;
    });
    if ('replayed' in response) {
      const { replayed: _r, ...rest } = response;
      return reply.status(200).send({ ...rest, duplicate: true });
    }
    return reply.status(201).send({ ...response, duplicate: false });
  });

  /** Historique du dossier : journal d'audit de l'enquête, du signalement, des tâches et des enregistrements concernés. */
  app.get('/api/investigations/:id/history', async (req) => {
    const u = await currentUser(req);
    requireRole(u, 'VET');
    const inv = await getInvestigation(db, u, (req.params as { id: string }).id);
    const tasks = (await db.query<{ id: string; record_id: string }>('SELECT id::text AS id, record_id FROM verification_tasks WHERE investigation_id = $1', [inv.id])).rows;
    return (
      await db.query(
        `SELECT a.at, a.action, a.entity, a.entity_id AS "entityId", a.detail, u.name AS "actor"
         FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.org_id = $1 AND (
           (a.entity = 'investigation' AND a.entity_id = $2) OR (a.entity = 'observation' AND a.entity_id = $3)
           OR (a.entity = 'task' AND a.entity_id = ANY($4)) OR (a.entity = 'record' AND a.entity_id = ANY($5)))
         ORDER BY a.at, a.id`,
        [u.org_id, inv.id, inv.observation_id, tasks.map((t) => t.id), tasks.map((t) => t.record_id)],
      )
    ).rows.map((r) => ({ ...r, detail: json((r as { detail: unknown }).detail) }));
  });

  app.get('/api/records/:id/revisions', async (req) => {
    const u = await currentUser(req);
    const id = (req.params as { id: string }).id;
    return (
      await db.query('SELECT rev, data, author_id AS "authorId", reason, recorded_at AS "recordedAt" FROM record_revisions WHERE record_id = $1 AND org_id = $2 ORDER BY rev', [id, u.org_id])
    ).rows.map((r) => ({ ...r, data: json((r as { data: unknown }).data) }));
  });

  app.get('/api/*', async () => {
    throw new HttpError(404, 'NOT_FOUND', 'Route inconnue');
  });

  // ---------- Interface web compilée (un seul serveur pour la démo) ----------
  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: opts.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Route inconnue' });
      // Un fichier absent (script d’une ancienne compilation, image) est une vraie erreur 404 : jamais la page HTML à sa place.
      if (req.url.startsWith('/assets/') || /\.[a-z0-9]{2,5}(\?.*)?$/i.test(req.url)) return reply.status(404).type('text/plain; charset=utf-8').send('Fichier introuvable');
      return reply.type('text/html').sendFile('index.html');
    });
  }

  return app;
}
