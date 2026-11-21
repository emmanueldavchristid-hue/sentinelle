import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { formatInstant } from '@sentinelle/domain';
import type { Beacon, BeaconReading, BeaconsData, SourceData, Statement, ToolResult, ZoneState } from '@sentinelle/contracts';
import type { Db, Queryable } from './db.js';
import { HttpError, parse, sha256, type User } from './http.js';

/**
 * Balises de démonstration : un téléphone joue le rôle d'un capteur de proximité (idée de Mouhi, 21/11).
 *
 * Ce que c'est : un contrat d'événement IoT minimal (dispositif, source, instant observé, instant reçu, unité, qualité)
 * et UN type de dispositif, la balise « téléphone ». Ce que ce n'est pas : une plateforme IoT, ni un matériel posé sur un animal.
 *
 * Règles de vérité :
 * - une balise mesure SA distance à un repère, pas la position ni l'état de l'animal auquel on l'associe ;
 * - la source de chaque mesure (GPS du téléphone, ou distance SIMULÉE à la main) est stockée et affichée dans chaque preuve ;
 * - « hors zone » n'est dit que si la distance dépasse le seuil même en tenant compte de la précision ; sinon « incertain » ;
 * - une balise muette n'est pas « sortie » : on dit seulement depuis quand rien n'a été reçu ;
 * - aucune coordonnée géographique n'est transmise ni stockée ; aucune notification externe n'est envoyée.
 */

export const SILENT_AFTER_SECONDS = 20;
const KEEP_READINGS = 300;
const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const fmtSec = (s: string) => `${formatInstant(Date.parse(s))}:${s.slice(17, 19)}`;
const meters = (n: number) => `${Math.round(n)} m`;

/** Statut d'une mesure selon le seuil : la précision compte, on ne tranche pas quand elle ne le permet pas. */
export function zoneOf(distanceM: number | null, accuracyM: number | null, radiusM: number): ZoneState {
  if (distanceM === null) return 'NO_FIX';
  const acc = accuracyM ?? 0;
  if (distanceM - acc > radiusM) return 'OUTSIDE';
  if (distanceM + acc <= radiusM) return 'INSIDE';
  return 'UNCERTAIN';
}

export const CreateBeaconSchema = z.object({
  animalId: z.string().trim().min(1, 'Indiquez l’animal associé').max(40),
  label: z.string().trim().min(1).max(60).optional(),
  radiusM: z.number().int().min(5, 'Seuil de 5 m au moins').max(500, 'Seuil de 500 m au plus').default(30),
});
export const ReadingSchema = z.object({
  source: z.enum(['PHONE_GPS', 'SIMULATED']),
  observedAt: z.iso.datetime({ offset: true }),
  distanceM: z.number().min(0).max(100_000).nullable(),
  accuracyM: z.number().min(0).max(100_000).nullable(),
});

interface DeviceRow {
  id: string;
  org_id: string;
  label: string;
  animal_id: string | null;
  radius_m: number;
  created_at: unknown;
  stopped_at: unknown;
}

const readingOf = (r: Record<string, unknown>): BeaconReading => ({
  source: r.source as BeaconReading['source'],
  observedAt: iso(r.observed_at),
  receivedAt: iso(r.received_at),
  distanceM: r.distance_m === null ? null : Number(r.distance_m),
  accuracyM: r.accuracy_m === null ? null : Number(r.accuracy_m),
  zone: r.zone as ZoneState,
});

async function loadBeacon(q: Queryable, d: DeviceRow, nowIso: string): Promise<Beacon> {
  const rows = (await q.query<Record<string, unknown>>('SELECT source, observed_at, received_at, distance_m, accuracy_m, zone FROM device_readings WHERE device_id = $1 ORDER BY id DESC LIMIT $2', [d.id, KEEP_READINGS])).rows.map(readingOf);
  const latest = rows[0] ?? null;
  const silentSeconds = latest ? Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(latest.receivedAt)) / 1000)) : null;
  let status: Beacon['status'];
  if (d.stopped_at) status = 'STOPPED';
  else if (!latest) status = 'NEVER';
  else if (silentSeconds! > SILENT_AFTER_SECONDS) status = 'SILENT';
  else status = latest.zone;
  // Début de la série continue de mesures « hors zone » : depuis quand la balise est dehors.
  let outsideSince: string | null = null;
  if (latest?.zone === 'OUTSIDE') for (const r of rows) if (r.zone === 'OUTSIDE') outsideSince = r.observedAt;
    else break;
  return { id: d.id, label: d.label, animalId: d.animal_id, radiusM: d.radius_m, createdAt: iso(d.created_at), stoppedAt: d.stopped_at ? iso(d.stopped_at) : null, latest, status, outsideSince, silentSeconds, recent: rows.slice(0, 5) };
}

const SOURCE_TEXT: Record<BeaconReading['source'], string> = { PHONE_GPS: 'GPS du téléphone', SIMULATED: 'distance SIMULÉE à la main' };

/** Phrase de statut d'une balise. Toujours « la balise », jamais « l'animal ». */
export function beaconSentence(b: Beacon): Statement {
  const who = `Balise de démonstration ${b.id}${b.animalId ? `, associée à ${b.animalId}` : ''}`;
  const src = [`DEVICE:${b.id}`, ...(b.animalId ? [`ANIMAL:${b.animalId}`] : [])];
  const l = b.latest;
  if (b.status === 'STOPPED') return { nature: 'FACT', text: `${who} : arrêtée le ${fmtSec(b.stoppedAt!)}.`, sources: src };
  if (!l) return { nature: 'MISSING', text: `${who} : aucune mesure reçue. Cela ne dit rien de l’endroit où elle se trouve.`, sources: src };
  const measured = l.distanceM === null ? 'aucune position disponible' : `${meters(l.distanceM)} du repère${l.accuracyM ? ` (précision ± ${meters(l.accuracyM)})` : ''}`;
  const when = `mesure du ${fmtSec(l.observedAt)}, reçue à ${fmtSec(l.receivedAt).slice(11)}, source : ${SOURCE_TEXT[l.source]}`;
  if (b.status === 'SILENT') return { nature: 'MISSING', text: `${who} : plus aucune mesure reçue depuis ${b.silentSeconds} secondes. Dernière mesure : ${measured} (${when}). Le silence d’une balise ne dit pas où elle se trouve.`, sources: src };
  if (b.status === 'OUTSIDE') return { nature: 'COMPUTED', text: `${who} : HORS de la zone. ${measured.charAt(0).toUpperCase() + measured.slice(1)}, pour un seuil de ${meters(b.radiusM)}${b.outsideSince ? `, depuis ${fmtSec(b.outsideSince).slice(11)}` : ''} (${when}).`, sources: src };
  if (b.status === 'INSIDE') return { nature: 'COMPUTED', text: `${who} : dans la zone. ${measured.charAt(0).toUpperCase() + measured.slice(1)}, pour un seuil de ${meters(b.radiusM)} (${when}).`, sources: src };
  if (b.status === 'UNCERTAIN') return { nature: 'MISSING', text: `${who} : incertain. ${measured.charAt(0).toUpperCase() + measured.slice(1)}, pour un seuil de ${meters(b.radiusM)} : la précision ne permet pas de dire si elle est dedans ou dehors (${when}).`, sources: src };
  return { nature: 'MISSING', text: `${who} : le téléphone n’a pas de position pour l’instant (${when}).`, sources: src };
}

export function beaconFunctions(db: Db) {
  const dbNow = async () => iso((await db.query<{ now: unknown }>('SELECT now() AS now')).rows[0]!.now);
  const devicesOf = async (orgId: string) => (await db.query<DeviceRow>('SELECT id, org_id, label, animal_id, radius_m, created_at, stopped_at FROM devices WHERE org_id = $1 ORDER BY created_at DESC LIMIT 20', [orgId])).rows;

  /** Lecture des balises de l'exploitation : même enveloppe que les autres fonctions (sources, dates, limites). */
  async function read(u: User): Promise<ToolResult<BeaconsData>> {
    const asOf = await dbNow();
    const beacons: Beacon[] = [];
    for (const d of await devicesOf(u.org_id)) beacons.push(await loadBeacon(db, d, asOf));
    const active = beacons.filter((b) => b.status !== 'STOPPED');
    const alerts = active.filter((b) => b.status === 'OUTSIDE');
    const simulated = active.some((b) => b.latest?.source === 'SIMULATED');
    const statements: Statement[] = active.length
      ? [
          alerts.length
            ? { nature: 'COMPUTED', text: `${alerts.length > 1 ? `${alerts.length} balises sont` : 'Une balise est'} hors de sa zone : ${alerts.map((b) => `${b.id}${b.animalId ? ` (associée à ${b.animalId})` : ''}`).join(', ')}.`, sources: alerts.map((b) => `DEVICE:${b.id}`) }
            : { nature: 'COMPUTED', text: `Aucune balise n’est hors de sa zone d’après les dernières mesures reçues (${active.length} balise${active.length > 1 ? 's' : ''} suivie${active.length > 1 ? 's' : ''}).`, sources: active.map((b) => `DEVICE:${b.id}`) },
          ...active.map(beaconSentence),
        ]
      : [{ nature: 'MISSING', text: 'Aucune balise n’est associée à un animal. Aucun capteur n’est connecté : rien n’est mesuré automatiquement.', sources: [] }];
    const limits = [
      'Une balise mesure sa propre distance à un repère choisi par l’utilisateur. Elle ne mesure ni la position exacte ni l’état de l’animal auquel elle est associée.',
      'Dispositif de démonstration : un téléphone tenu à la main. Aucun capteur n’est posé sur un animal.',
      `« Hors de la zone » n’est dit que si la distance dépasse le seuil même avec la précision annoncée. Une balise est dite muette après ${SILENT_AFTER_SECONDS} secondes sans mesure.`,
    ];
    if (simulated) limits.unshift('DONNÉES SIMULÉES : au moins une balise transmet une distance réglée à la main, pas une mesure.');
    return {
      tool: 'beacons',
      params: {},
      asOf,
      period: null,
      statements,
      data: { beacons, alerts: alerts.map((b) => b.id), simulated },
      sources: [...active.map((b) => ({ ref: `DEVICE:${b.id}`, label: `Balise ${b.id}` })), ...active.filter((b) => b.animalId).map((b) => ({ ref: `ANIMAL:${b.animalId}`, label: b.animalId! }))],
      limits,
    };
  }

  /** Preuve d'une balise : le dispositif et ses dernières mesures, avec source, instants, unité et statut. */
  async function source(u: User, id: string): Promise<SourceData | null> {
    const d = (await db.query<DeviceRow>('SELECT id, org_id, label, animal_id, radius_m, created_at, stopped_at FROM devices WHERE id = $1 AND org_id = $2', [id, u.org_id])).rows[0];
    if (!d) return null;
    const b = await loadBeacon(db, d, await dbNow());
    const zone: Record<ZoneState, string> = { INSIDE: 'dans la zone', OUTSIDE: 'hors de la zone', UNCERTAIN: 'incertain', NO_FIX: 'pas de position' };
    return {
      ref: `DEVICE:${b.id}`,
      kind: 'device',
      title: `Balise de démonstration ${b.id}`,
      fields: [
        { label: 'Dispositif', value: `${b.label} (téléphone, pas un capteur posé sur un animal)` },
        { label: 'Animal associé', value: b.animalId ?? 'aucun' },
        { label: 'Seuil de la zone', value: meters(b.radiusM) },
        { label: 'Statut', value: beaconSentence(b).text },
        { label: 'Associée le', value: fmtSec(b.createdAt) },
        ...b.recent.map((r, i) => ({
          label: i === 0 ? 'Dernière mesure' : `Mesure précédente ${i}`,
          value: `${r.distanceM === null ? 'pas de position' : meters(r.distanceM)}${r.accuracyM ? ` ± ${meters(r.accuracyM)}` : ''} · ${zone[r.zone]} · observée ${fmtSec(r.observedAt)} · reçue ${fmtSec(r.receivedAt).slice(11)} · ${SOURCE_TEXT[r.source]}`,
        })),
      ],
      event: null,
      revisions: [],
    };
  }

  return { read, source };
}

interface Ctx {
  app: FastifyInstance;
  db: Db;
  currentUser: (req: FastifyRequest) => Promise<User>;
  audit: (q: Queryable, u: User | null, action: string, entity: string, id: string, detail?: unknown) => Promise<void>;
}

export function registerBeacons(ctx: Ctx) {
  const { db } = ctx;

  /** Associe une balise de démonstration à un animal. Le jeton n'est renvoyé qu'une fois ; seul son hachage est stocké. */
  ctx.app.post('/api/farm/devices', async (req, reply) => {
    const u = await ctx.currentUser(req);
    const body = parse(CreateBeaconSchema, req.body);
    const animal = (await db.query<{ id: string }>('SELECT id FROM animals WHERE org_id = $1 AND (id = $2 OR UPPER(tag) = UPPER($2)) LIMIT 1', [u.org_id, body.animalId])).rows[0];
    if (!animal) throw new HttpError(400, 'VALIDATION', 'Données invalides', { fields: { animalId: 'Animal inconnu dans votre périmètre' } });
    const active = Number((await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM devices WHERE org_id = $1 AND stopped_at IS NULL', [u.org_id])).rows[0]!.n);
    if (active >= 5) throw new HttpError(409, 'CONFLICT', 'Cinq balises de démonstration au plus. Arrêtez-en une avant d’en associer une autre.');
    const id = `BAL-${randomBytes(3).toString('hex').toUpperCase().slice(0, 4)}`;
    const token = randomBytes(24).toString('base64url');
    await db.query('INSERT INTO devices(id, org_id, label, animal_id, token_hash, radius_m, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, u.org_id, body.label ?? 'Téléphone de démonstration', animal.id, sha256(token), body.radiusM, u.id]);
    await ctx.audit(db, u, 'DEVICE_PAIRED', 'device', id, { animalId: animal.id, radiusM: body.radiusM });
    return reply.status(201).send({ id, token, animalId: animal.id, radiusM: body.radiusM });
  });

  ctx.app.post('/api/farm/devices/:id/stop', async (req) => {
    const u = await ctx.currentUser(req);
    const id = (req.params as { id: string }).id;
    const r = await db.query('UPDATE devices SET stopped_at = now() WHERE id = $1 AND org_id = $2 AND stopped_at IS NULL RETURNING id', [id, u.org_id]);
    if (!r.rows.length) throw new HttpError(404, 'NOT_FOUND', 'Balise introuvable ou déjà arrêtée');
    await ctx.audit(db, u, 'DEVICE_STOPPED', 'device', id);
    return { ok: true };
  });

  /** Authentification du dispositif par son jeton (en-tête), sans session utilisateur. */
  async function deviceFromToken(req: FastifyRequest): Promise<DeviceRow> {
    const id = (req.params as { id: string }).id;
    const token = req.headers['x-device-token'];
    const d = typeof token === 'string' && token ? (await db.query<DeviceRow & { token_hash: string }>('SELECT * FROM devices WHERE id = $1', [id])).rows[0] : undefined;
    if (!d || d.token_hash !== sha256(token as string)) throw new HttpError(401, 'UNAUTHENTICATED', 'Balise inconnue ou jeton invalide');
    return d;
  }

  /** Ce que le serveur sait de la balise : affiché sur le téléphone pour qu'il montre l'état enregistré, pas une supposition. */
  ctx.app.get('/api/devices/:id', async (req) => {
    const d = await deviceFromToken(req);
    const now = iso((await db.query<{ now: unknown }>('SELECT now() AS now')).rows[0]!.now);
    return loadBeacon(db, d, now);
  });

  /** Réception d'une mesure. Le serveur calcule le statut (dans la zone, hors zone, incertain, pas de position). */
  ctx.app.post('/api/devices/:id/readings', async (req, reply) => {
    const d = await deviceFromToken(req);
    if (d.stopped_at) throw new HttpError(409, 'CONFLICT', 'Cette balise a été arrêtée.');
    const body = parse(ReadingSchema, req.body);
    const now = Date.now();
    if (Math.abs(Date.parse(body.observedAt) - now) > 10 * 60_000) throw new HttpError(400, 'VALIDATION', 'Données invalides', { fields: { observedAt: 'Instant observé trop éloigné de l’heure du serveur' } });
    const last = (await db.query<{ received_at: unknown }>('SELECT received_at FROM device_readings WHERE device_id = $1 ORDER BY id DESC LIMIT 1', [d.id])).rows[0];
    if (last && now - Date.parse(iso(last.received_at)) < 900) return reply.status(202).send({ accepted: false, reason: 'Une mesure par seconde au plus' });
    const accuracy = body.source === 'SIMULATED' ? 0 : body.accuracyM;
    const zone = zoneOf(body.distanceM, accuracy, d.radius_m);
    await db.query('INSERT INTO device_readings(device_id, org_id, source, observed_at, distance_m, accuracy_m, zone) VALUES ($1,$2,$3,$4,$5,$6,$7)', [d.id, d.org_id, body.source, body.observedAt, body.distanceM, accuracy, zone]);
    await db.query('DELETE FROM device_readings WHERE device_id = $1 AND id <= COALESCE((SELECT id FROM device_readings WHERE device_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1), 0)', [d.id, KEEP_READINGS]);
    return reply.status(201).send({ accepted: true, zone, radiusM: d.radius_m });
  });
}
