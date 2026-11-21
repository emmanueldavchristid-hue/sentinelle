import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { bounds, formatInstant, formatTemporal, type Movement, type Presence, type TemporalValue } from '@sentinelle/domain';
import {
  animalMatchKey,
  extractAnimalIds,
  isRealDate,
  normalizeAnimalQuery,
  TemporalValueSchema,
  type AnimalData,
  type AnimalMatch,
  type ChangeCounts,
  type ChangesData,
  type DraftField,
  type FarmEvent,
  type FarmToolName,
  type FindAnimalData,
  type MissingData,
  type MissingItem,
  type MoveEdge,
  type ObservationDraftData,
  type SituationData,
  type SiteSummary,
  type SourceData,
  type SourceRef,
  type Statement,
  type TemporalValueDto,
  type ToolResult,
} from '@sentinelle/contracts';
import type { Db, Queryable } from './db.js';
import { HttpError, parse, type User } from './http.js';

/**
 * SENTINELLE VIVANT : fonctions de lecture de l'exploitation et préparation des écritures.
 * - Tout est limité à l'organisation de l'utilisateur (isolation).
 * - Aucun SQL libre : chaque fonction a des paramètres validés.
 * - Chaque résultat porte ses sources, ses dates, sa période et ses limites.
 * - Aucune écriture ici : `prepareObservation` renvoie un brouillon, l'enregistrement passe par /api/sync/observations après confirmation.
 */

const DAY_MS = 86_400_000;
const EPOCH = '1970-01-01T00:00:00.000Z';
const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
const fmt = (isoStr: string) => formatInstant(Date.parse(isoStr));
/** Instant à la seconde : deux états des données lus dans la même minute doivent rester distinguables. */
const fmtSec = (isoStr: string) => `${formatInstant(Date.parse(isoStr))}:${isoStr.slice(17, 19)}`;
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const isUuid = (s: string) => z.uuid().safeParse(s).success;

/** Début du jour civil précédent (Africa/Abidjan = UTC, sans heure d'été). */
export function startOfYesterday(nowIso: string): string {
  const d = new Date(nowIso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - DAY_MS).toISOString();
}

type Rec = Presence | Movement;
interface SiteRow {
  id: string;
  code: string;
  name: string;
  kind: 'FARM' | 'MARKET';
  x: number | null;
  y: number | null;
}

async function dbNow(q: Queryable): Promise<string> {
  return iso((await q.query<{ now: unknown }>('SELECT now() AS now')).rows[0]!.now);
}

async function loadSites(q: Queryable, orgId: string): Promise<Map<string, SiteRow>> {
  const rows = (await q.query<SiteRow>('SELECT id, code, name, kind, pos_x AS "x", pos_y AS "y" FROM locations WHERE org_id = $1 ORDER BY code', [orgId])).rows;
  return new Map(rows.map((r) => [r.id, { ...r, x: r.x === null ? null : Number(r.x), y: r.y === null ? null : Number(r.y) }]));
}

/** Dernière révision de chaque enregistrement (optionnellement limitée à certains animaux). */
async function currentRecords(q: Queryable, orgId: string, animalIds?: string[]): Promise<Rec[]> {
  const rows = (
    await q.query<{ record_id: string; rev: number; data: unknown }>(
      `SELECT DISTINCT ON (record_id) record_id, rev, data FROM record_revisions
       WHERE org_id = $1 ${animalIds ? `AND data->>'animalId' = ANY($2)` : ''} ORDER BY record_id, rev DESC`,
      animalIds ? [orgId, animalIds] : [orgId],
    )
  ).rows;
  return rows.map((r) => ({ id: r.record_id, rev: r.rev, ...json<object>(r.data) }) as Rec);
}

const siteName = (sites: Map<string, SiteRow>, id: string | null | undefined) => (id ? (sites.get(id)?.name ?? id) : 'lieu non enregistré');

function describeRecord(r: Rec, sites: Map<string, SiteRow>): string {
  if (r.kind === 'movement') return `départ ${formatTemporal(r.departure)}, arrivée ${formatTemporal(r.arrival)}`;
  const start = r.start.precision === 'UNKNOWN' ? 'début non enregistré' : `depuis ${formatTemporal(r.start)}`;
  if (r.end === null) return `${start}, présence ouverte (fin non enregistrée)`;
  return r.start.precision === 'UNKNOWN' ? `${start}, fin ${formatTemporal(r.end)}` : `du ${formatTemporal(r.start)} au ${formatTemporal(r.end)}`;
}

function movementInconsistent(m: Movement): boolean {
  try {
    return bounds(m.arrival as TemporalValue).max < bounds(m.departure as TemporalValue).min;
  } catch {
    return true;
  }
}

/** Instant de tri d'un événement : sa date d'événement si elle est connue, sinon sa réception. */
function sortKey(e: FarmEvent): number {
  if (e.eventTime && e.eventTime.precision !== 'UNKNOWN') {
    try {
      return bounds(e.eventTime as TemporalValue).min;
    } catch {
      /* date illisible : repli sur la réception */
    }
  }
  return Date.parse(e.recordedAt);
}

// ---------- Événements entre deux instants de réception ----------

interface EventQuery {
  from: string;
  to: string;
  animalId?: string;
  limit: number;
}

async function eventsBetween(q: Queryable, orgId: string, sites: Map<string, SiteRow>, p: EventQuery): Promise<{ events: FarmEvent[]; counts: ChangeCounts; truncated: boolean }> {
  const animalObs = p.animalId ? 'AND o.animal_id = $4' : '';
  const animalRec = p.animalId ? `AND r.data->>'animalId' = $4` : '';
  const base = p.animalId ? [orgId, p.from, p.to, p.animalId] : [orgId, p.from, p.to];
  const lim = p.limit + 1;

  const obs = (
    await q.query<Record<string, unknown>>(
      `SELECT o.id, o.animal_id, o.location_id, o.event_time, o.note, o.recorded_at_client, o.received_at, u.name AS author
       FROM observations o LEFT JOIN users u ON u.id = o.author_id
       WHERE o.org_id = $1 AND o.received_at > $2 AND o.received_at <= $3 ${animalObs} ORDER BY o.received_at DESC LIMIT ${lim}`,
      base,
    )
  ).rows;
  const revs = (
    await q.query<Record<string, unknown>>(
      `SELECT r.record_id, r.rev, r.kind, r.data, r.reason, r.recorded_at, u.name AS author
       FROM record_revisions r LEFT JOIN users u ON u.id = r.author_id
       WHERE r.org_id = $1 AND r.recorded_at > $2 AND r.recorded_at <= $3 ${animalRec} ORDER BY r.recorded_at DESC, r.record_id LIMIT ${lim}`,
      base,
    )
  ).rows;
  const counted = (
    await q.query<{ obs: number; added: number; corrected: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM observations o WHERE o.org_id = $1 AND o.received_at > $2 AND o.received_at <= $3 ${animalObs}) AS obs,
         (SELECT COUNT(*)::int FROM record_revisions r WHERE r.org_id = $1 AND r.recorded_at > $2 AND r.recorded_at <= $3 AND r.rev = 1 ${animalRec}) AS added,
         (SELECT COUNT(*)::int FROM record_revisions r WHERE r.org_id = $1 AND r.recorded_at > $2 AND r.recorded_at <= $3 AND r.rev > 1 ${animalRec}) AS corrected`,
      base,
    )
  ).rows[0]!;

  const events: FarmEvent[] = [];
  for (const o of obs) {
    events.push({
      ref: `OBS:${o.id}`,
      type: 'OBSERVATION',
      change: 'ADDED',
      animalId: String(o.animal_id),
      siteIds: [String(o.location_id)],
      eventTime: json<TemporalValueDto>(o.event_time),
      deviceRecordedAt: isoOrNull(o.recorded_at_client),
      recordedAt: iso(o.received_at),
      title: `Observation sur ${o.animal_id}`,
      detail: String(o.note),
      author: (o.author as string | null) ?? null,
    });
  }
  for (const r of revs) {
    const data = json<Omit<Rec, 'id' | 'rev'>>(r.data);
    const rec = { id: String(r.record_id), rev: Number(r.rev), ...data } as Rec;
    const where = rec.kind === 'presence' ? siteName(sites, rec.locationId) : `${siteName(sites, rec.fromLocationId)} vers ${siteName(sites, rec.toLocationId)}`;
    const corrected = rec.rev > 1;
    events.push({
      ref: `REC:${rec.id}@${rec.rev}`,
      type: corrected ? 'CORRECTION' : rec.kind === 'presence' ? 'PRESENCE' : 'MOVEMENT',
      change: corrected ? 'CORRECTED' : 'ADDED',
      animalId: rec.animalId,
      siteIds: rec.kind === 'presence' ? [rec.locationId] : [rec.fromLocationId, rec.toLocationId],
      eventTime: (rec.kind === 'presence' ? rec.start : rec.departure) as TemporalValueDto,
      deviceRecordedAt: null,
      recordedAt: iso(r.recorded_at),
      title: corrected
        ? `Correction de ${rec.id} (révision ${rec.rev}) : ${rec.kind === 'presence' ? 'présence' : 'déplacement'} de ${rec.animalId}, ${where}`
        : rec.kind === 'presence'
          ? `Présence de ${rec.animalId} à ${where}`
          : `Déplacement de ${rec.animalId} : ${where}`,
      detail: `${describeRecord(rec, sites)}${corrected && r.reason ? ` ; motif : ${r.reason}` : ''}`,
      author: (r.author as string | null) ?? null,
    });
  }

  // Tâches de vérification : trois instants possibles (proposée, demandée, complétée).
  const tasks = (
    await q.query<Record<string, unknown>>(
      `SELECT t.id, t.record_id, t.label, t.created_at, t.requested_at, t.done_at, t.done_rev,
              (SELECT r.data->>'animalId' FROM record_revisions r WHERE r.record_id = t.record_id AND r.org_id = t.org_id ORDER BY r.rev DESC LIMIT 1) AS animal_id
       FROM verification_tasks t
       WHERE t.org_id = $1 AND ((t.created_at > $2 AND t.created_at <= $3) OR (t.requested_at > $2 AND t.requested_at <= $3) OR (t.done_at > $2 AND t.done_at <= $3))`,
      [orgId, p.from, p.to],
    )
  ).rows.filter((t) => !p.animalId || t.animal_id === p.animalId);
  const inRange = (v: unknown) => v !== null && v !== undefined && Date.parse(iso(v)) > Date.parse(p.from) && Date.parse(iso(v)) <= Date.parse(p.to);
  let taskEvents = 0;
  for (const t of tasks) {
    const common = { change: 'TASK' as const, animalId: (t.animal_id as string | null) ?? null, siteIds: [], eventTime: null, deviceRecordedAt: null, author: null };
    if (inRange(t.created_at)) events.push({ ...common, ref: `TASK:${t.id}#proposee`, type: 'TASK_CREATED', recordedAt: iso(t.created_at), title: `Tâche proposée : ${t.label}`, detail: `Concerne ${t.record_id}` }), taskEvents++;
    if (inRange(t.requested_at)) events.push({ ...common, ref: `TASK:${t.id}#demandee`, type: 'TASK_REQUESTED', recordedAt: iso(t.requested_at), title: `Tâche demandée à un agent : ${t.label}`, detail: `Concerne ${t.record_id}` }), taskEvents++;
    if (inRange(t.done_at)) events.push({ ...common, ref: `TASK:${t.id}#completee`, type: 'TASK_DONE', recordedAt: iso(t.done_at), title: `Tâche complétée : ${t.label}`, detail: `Révision ${t.done_rev} de ${t.record_id}` }), taskEvents++;
  }

  events.sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || a.ref.localeCompare(b.ref));
  const counts: ChangeCounts = { added: counted.obs + counted.added, corrected: counted.corrected, tasks: taskEvents, total: counted.obs + counted.added + counted.corrected + taskEvents };
  return { events: events.slice(0, p.limit), counts, truncated: counts.total > p.limit };
}

const countsText = (c: ChangeCounts) => `${plural(c.added, 'ajout', 'ajouts')}, ${plural(c.corrected, 'correction', 'corrections')}, ${plural(c.tasks, 'tâche', 'tâches')}`;
const eventSentence = (e: FarmEvent) =>
  `${e.title}${e.detail ? ` : ${e.detail}` : ''} (${e.eventTime ? `événement : ${formatTemporal(e.eventTime as TemporalValue)} ; ` : ''}reçu par le serveur le ${fmt(e.recordedAt)}).`;
const refLabel = (e: FarmEvent): SourceRef => ({ ref: e.ref.replace(/#.*$/, ''), label: e.title });
const uniqueSources = (list: SourceRef[]): SourceRef[] => [...new Map(list.map((s) => [s.ref, s])).values()];

// ---------- Informations manquantes ----------

async function computeMissing(q: Queryable, orgId: string, sites: Map<string, SiteRow>, animalId?: string): Promise<{ items: MissingItem[]; counts: MissingData['counts'] }> {
  const recs = await currentRecords(q, orgId, animalId ? [animalId] : undefined);
  const animals = (await q.query<{ id: string }>(`SELECT id FROM animals WHERE org_id = $1 ${animalId ? 'AND id = $2' : ''} ORDER BY id`, animalId ? [orgId, animalId] : [orgId])).rows;
  const openBy = new Map<string, Presence[]>();
  for (const r of recs) if (r.kind === 'presence' && r.end === null) openBy.set(r.animalId, [...(openBy.get(r.animalId) ?? []), r]);
  const items: MissingItem[] = [];

  const tasks = (
    await q.query<{ id: string; label: string; record_id: string; status: string; animal_id: string | null }>(
      `SELECT t.id, t.label, t.record_id, t.status,
              (SELECT r.data->>'animalId' FROM record_revisions r WHERE r.record_id = t.record_id AND r.org_id = t.org_id ORDER BY r.rev DESC LIMIT 1) AS animal_id
       FROM verification_tasks t WHERE t.org_id = $1 AND t.status <> 'DONE' ORDER BY t.created_at`,
      [orgId],
    )
  ).rows.filter((t) => !animalId || t.animal_id === animalId);
  for (const t of tasks) items.push({ ref: `TASK:${t.id}`, animalId: t.animal_id, kind: 'OPEN_TASK', text: `Tâche à traiter : ${t.label} (${t.status === 'REQUESTED' ? 'demandée à un agent' : 'à demander'}).` });

  for (const r of recs) {
    if (r.kind === 'movement' && movementInconsistent(r)) items.push({ ref: `REC:${r.id}@${r.rev}`, animalId: r.animalId, kind: 'INCONSISTENT', text: `${r.id} : l’arrivée de ${r.animalId} est enregistrée avant son départ. À vérifier.` });
  }
  for (const [id, open] of openBy) {
    if (open.length > 1) items.push({ ref: `ANIMAL:${id}`, animalId: id, kind: 'INCONSISTENT', text: `${id} : ${open.length} présences ouvertes en même temps (${open.map((p) => siteName(sites, p.locationId)).join(', ')}). À vérifier.` });
  }
  for (const a of animals) if (!openBy.has(a.id)) items.push({ ref: `ANIMAL:${a.id}`, animalId: a.id, kind: 'NO_CURRENT_SITE', text: `${a.id} : aucun lieu actuel enregistré.` });
  for (const r of recs) {
    const parts = r.kind === 'presence' ? ([['début', r.start], ['fin', r.end]] as const) : ([['départ', r.departure], ['arrivée', r.arrival]] as const);
    const what = r.kind === 'presence' ? `présence de ${r.animalId} à ${siteName(sites, r.locationId)}` : `déplacement de ${r.animalId} (${siteName(sites, r.fromLocationId)} vers ${siteName(sites, r.toLocationId)})`;
    const unknown = parts.filter(([, v]) => v !== null && v.precision === 'UNKNOWN').map(([n]) => n);
    const dayOnly = parts.filter(([, v]) => v !== null && v.precision === 'DAY').map(([n]) => n);
    if (unknown.length) items.push({ ref: `REC:${r.id}@${r.rev}`, animalId: r.animalId, kind: 'UNKNOWN_TIME', text: `${r.id} : ${unknown.join(' et ')} non enregistré pour la ${what}.` });
    else if (dayOnly.length) items.push({ ref: `REC:${r.id}@${r.rev}`, animalId: r.animalId, kind: 'DAY_ONLY', text: `${r.id} : ${dayOnly.join(' et ')} connu au jour près, sans heure, pour la ${what}.` });
  }
  const order: MissingItem['kind'][] = ['OPEN_TASK', 'INCONSISTENT', 'NO_CURRENT_SITE', 'UNKNOWN_TIME', 'DAY_ONLY'];
  items.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const counts = { OPEN_TASK: 0, INCONSISTENT: 0, NO_CURRENT_SITE: 0, UNKNOWN_TIME: 0, DAY_ONLY: 0 } as MissingData['counts'];
  for (const i of items) counts[i.kind]++;
  return { items, counts };
}

// ---------- Recherche d'animal ----------

async function matchAnimals(q: Queryable, orgId: string, raw: string): Promise<{ normalized: string; rows: { id: string; tag: string; species: string }[]; exact: boolean }> {
  const normalized = normalizeAnimalQuery(raw);
  const select = 'SELECT id, tag, species FROM animals WHERE org_id = $1';
  const exact = (await q.query<{ id: string; tag: string; species: string }>(`${select} AND (UPPER(tag) = $2 OR UPPER(id) = $2) ORDER BY tag LIMIT 10`, [orgId, normalized])).rows;
  if (exact.length) return { normalized, rows: exact, exact: true };
  // Rapprochement tolérant : casse, espaces, tirets et zéros de tête (« b 17 » retrouve « B-017 »).
  const key = animalMatchKey(raw);
  const letters = /^[A-Z]+/.exec(key)?.[0] ?? '';
  if (letters && key.length > letters.length) {
    const near = (await q.query<{ id: string; tag: string; species: string }>(`${select} AND UPPER(tag) LIKE $2 ORDER BY tag LIMIT 500`, [orgId, `${letters}%`])).rows.filter((a) => animalMatchKey(a.tag) === key);
    if (near.length) return { normalized, rows: near.slice(0, 10), exact: true };
  }
  if (normalized.length < 2) return { normalized, rows: [], exact: false };
  const partial = (await q.query<{ id: string; tag: string; species: string }>(`${select} AND UPPER(tag) LIKE $2 ORDER BY tag LIMIT 10`, [orgId, `%${normalized.replace(/[%_]/g, '')}%`])).rows;
  return { normalized, rows: partial, exact: false };
}

async function withCurrentSite(q: Queryable, orgId: string, rows: { id: string; tag: string; species: string }[]): Promise<AnimalMatch[]> {
  if (!rows.length) return [];
  const recs = await currentRecords(q, orgId, rows.map((r) => r.id));
  return rows.map((a) => ({ ...a, currentSiteId: recs.find((r): r is Presence => r.kind === 'presence' && r.animalId === a.id && r.end === null)?.locationId ?? null }));
}

// ---------- Schémas de paramètres ----------

const instant = z.iso.datetime({ offset: true });
export const ChangesParamsSchema = z
  .object({ from: instant.optional(), to: instant.optional() })
  .refine((p) => !p.from || !p.to || Date.parse(p.from) < Date.parse(p.to), { message: 'La fin de la période doit suivre son début', path: ['to'] })
  .refine((p) => !p.from || Date.parse(p.to ?? new Date().toISOString()) - Date.parse(p.from) <= 366 * DAY_MS, { message: 'Période limitée à un an', path: ['from'] });
export const FindAnimalParamsSchema = z.object({ query: z.string().trim().min(1, 'Indiquez un identifiant').max(60) });
export const AnimalParamsSchema = z.object({ animalId: z.string().trim().min(1).max(40) });
export const SourceParamsSchema = z.object({ ref: z.string().trim().min(3).max(120) });
export const PrepareObservationSchema = z.object({
  text: z.string().trim().max(1000).optional(),
  animalId: z.string().trim().max(40).optional(),
  siteId: z.string().trim().max(40).optional(),
  eventTime: TemporalValueSchema.optional(),
  note: z.string().trim().max(1000).optional(),
  /** Animal affiché à l'écran au moment de la demande (jamais retenu sans le signaler). */
  contextAnimalId: z.string().trim().max(40).optional(),
});

// ---------- Lecture de la date dans une phrase (déterministe, sans IA) ----------

function parseEventTime(text: string, nowIso: string): DraftField<TemporalValueDto> {
  const t = text.toLowerCase();
  const now = new Date(nowIso);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let day: number | null = null;
  let vague: string | null = null;
  const explicit = /\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{4}))?\b/.exec(t);
  if (explicit) {
    const d = `${explicit[3] ?? now.getUTCFullYear()}-${explicit[2]!.padStart(2, '0')}-${explicit[1]!.padStart(2, '0')}`;
    if (!isRealDate(d)) return { value: null, status: 'MISSING', message: `La date « ${explicit[0]} » n’existe pas dans le calendrier.` };
    day = Date.parse(`${d}T00:00:00Z`);
  } else if (/avant[- ]hier/.test(t)) day = today - 2 * DAY_MS;
  else if (/\bhier\b/.test(t)) day = today - DAY_MS;
  else {
    const m = /aujourd['’]hui|ce matin|ce midi|cet après-midi|cet apres-midi|ce soir|cette nuit|tout à l['’]heure|à l['’]instant/.exec(t);
    if (m) {
      day = today;
      vague = m[0];
    }
  }
  const hm = /\b(\d{1,2})\s?(?:h|:)\s?(\d{2})?\b/.exec(t.replace(explicit?.[0] ?? '', ' '));
  const hour = hm && Number(hm[1]) < 24 && Number(hm[2] ?? 0) < 60 ? Number(hm[1]) * 60 + Number(hm[2] ?? 0) : null;
  if (day === null && hour === null) return { value: null, status: 'MISSING', message: 'Date de l’événement non indiquée. Choisissez une date, ou « Inconnue ».' };
  if (hour !== null) {
    const at = (day ?? today) + hour * 60_000;
    if (at > Date.parse(nowIso) + 5 * 60_000) return { value: null, status: 'MISSING', message: 'L’heure indiquée est dans le futur. Vérifiez la date.' };
    return {
      value: { precision: 'INSTANT', at: new Date(at).toISOString() },
      status: day === null ? 'TO_CONFIRM' : 'OK',
      message: day === null ? 'Heure lue dans le texte ; jour supposé : aujourd’hui. À confirmer.' : null,
    };
  }
  if (day! > today) return { value: null, status: 'MISSING', message: 'La date indiquée est dans le futur. Vérifiez la date.' };
  return {
    value: { precision: 'DAY', date: new Date(day!).toISOString().slice(0, 10) },
    status: 'TO_CONFIRM',
    message: vague ? `« ${vague} » : le jour est retenu, sans heure (aucune heure n’est supposée). Précisez l’heure si vous la connaissez.` : 'Jour retenu sans heure (aucune heure n’est supposée).',
  };
}

function extractNote(text: string, animalIds: string[]): string {
  let s = text.trim();
  const colon = s.indexOf(':');
  // « Ajoute une observation sur B-017 : mange moins » : le texte utile suit les deux-points (sauf s'il s'agit d'une heure, 07:30).
  if (colon > 0 && !/\d$/.test(s.slice(0, colon)) && s.slice(colon + 1).trim().length >= 3) s = s.slice(colon + 1);
  else s = s.replace(/^\s*(ajoute[rz]?|note[rz]?|enregistre[rz]?|d[ée]clare[rz]?|signale[rz]?)\s+(?:(?:une?|cet(?:te)?|l['’])\s*)?(?:nouvelle?\s+)?(?:observation|[ée]v[ée]nement)?\s*(?:sur|pour|concernant)?\s*/i, '');
  for (const id of animalIds) s = s.replace(new RegExp(`^\\s*${id.replace('-', '[\\s-]?')}\\s*[,:;.-]?\\s*`, 'i'), '');
  s = s.trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// ---------- Fonctions (appelées par les routes ET par l'assistant) ----------

export function farmTools(db: Db) {
  const envelope = <T>(tool: FarmToolName, params: Record<string, unknown>, asOf: string, period: ToolResult['period'], statements: Statement[], data: T, sources: SourceRef[], limits: string[]): ToolResult<T> => ({
    tool,
    params,
    asOf,
    period,
    statements,
    data,
    sources: uniqueSources(sources),
    limits,
  });
  const NO_SENSOR = 'Aucun capteur n’est connecté : seuls les enregistrements saisis ou importés sont pris en compte.';

  async function resetDate(orgId: string): Promise<string | null> {
    return isoOrNull((await db.query<{ at: unknown }>(`SELECT at FROM audit_events WHERE action = 'DEMO_RESET' AND org_id = $1 ORDER BY id DESC LIMIT 1`, [orgId])).rows[0]?.at);
  }

  async function situation(u: User): Promise<ToolResult<SituationData>> {
    const asOf = await dbNow(db);
    const sites = await loadSites(db, u.org_id);
    const org = (await db.query<{ id: string; name: string }>('SELECT id, name FROM organizations WHERE id = $1', [u.org_id])).rows[0]!;
    const total = Number((await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM animals WHERE org_id = $1', [u.org_id])).rows[0]!.n);
    const recs = await currentRecords(db, u.org_id);
    const present = new Map<string, Set<string>>();
    const located = new Set<string>();
    const edges = new Map<string, MoveEdge>();
    for (const r of recs) {
      if (r.kind === 'presence' && r.end === null) {
        present.set(r.locationId, (present.get(r.locationId) ?? new Set()).add(r.animalId));
        located.add(r.animalId);
      } else if (r.kind === 'movement') {
        const k = `${r.fromLocationId}>${r.toLocationId}`;
        const e = edges.get(k) ?? { from: r.fromLocationId, to: r.toLocationId, count: 0, refs: [] };
        e.count++;
        if (e.refs.length < 5) e.refs.push(`REC:${r.id}@${r.rev}`);
        edges.set(k, e);
      }
    }
    const siteList: SiteSummary[] = [...sites.values()].map((s) => ({ ...s, animalsPresent: present.get(s.id)?.size ?? 0 }));
    const from = startOfYesterday(asOf);
    const recent = await eventsBetween(db, u.org_id, sites, { from, to: asOf, limit: 8 });
    const missing = await computeMissing(db, u.org_id, sites);
    const last = (
      await db.query<{ last: unknown }>(
        `SELECT GREATEST((SELECT MAX(received_at) FROM observations WHERE org_id = $1), (SELECT MAX(recorded_at) FROM record_revisions WHERE org_id = $1)) AS last`,
        [u.org_id],
      )
    ).rows[0]?.last;
    const datasetResetAt = await resetDate(u.org_id);
    const unlocated = total - located.size;
    const statements: Statement[] = [
      { nature: 'FACT', text: `${plural(total, 'animal identifié est enregistré', 'animaux identifiés sont enregistrés')}, sur ${plural(siteList.length, 'site', 'sites')}. Aucun lot n’est enregistré.`, sources: siteList.map((s) => `SITE:${s.id}`) },
      { nature: 'COMPUTED', text: `${located.size} ${located.size > 1 ? 'ont' : 'a'} un lieu actuel enregistré (présence ouverte) ; ${unlocated} n’en ${unlocated > 1 ? 'ont' : 'a'} pas.`, sources: [] },
      recent.counts.total
        ? { nature: 'COMPUTED', text: `Depuis hier (${fmt(from)}), ${plural(recent.counts.total, 'enregistrement a été reçu', 'enregistrements ont été reçus')} : ${countsText(recent.counts)}.`, sources: recent.events.map((e) => e.ref.replace(/#.*$/, '')) }
        : { nature: 'MISSING', text: `Aucun enregistrement reçu depuis hier (${fmt(from)}). Sans saisie, rien n’est observé : cela ne dit rien de l’état des animaux.`, sources: [] },
      missing.items.length
        ? { nature: 'MISSING', text: `${plural(missing.items.length, 'information reste', 'informations restent')} à compléter ou à vérifier.`, sources: missing.items.slice(0, 6).map((i) => i.ref) }
        : { nature: 'COMPUTED', text: 'Aucune information à compléter n’a été détectée par les contrôles actuels (lieu actuel, dates, cohérence des déplacements, tâches).', sources: [] },
      last ? { nature: 'FACT', text: `Dernière réception par le serveur : ${fmt(iso(last))}.`, sources: [] } : { nature: 'MISSING', text: 'Aucun enregistrement n’a encore été reçu par le serveur.', sources: [] },
    ];
    const data: SituationData = {
      org,
      sites: siteList,
      moves: [...edges.values()],
      animals: { total, located: located.size, unlocated },
      lots: [],
      recent: { from, counts: recent.counts, events: recent.events },
      toComplete: { total: missing.items.length, openTasks: missing.counts.OPEN_TASK, items: missing.items.slice(0, 6) },
      sync: { lastServerReceipt: isoOrNull(last), datasetResetAt },
    };
    const limits = [NO_SENSOR, 'Le lieu actuel d’un animal est sa présence ouverte enregistrée, pas une position constatée.'];
    if (datasetResetAt) limits.push(`Jeu de démonstration synthétique, réinitialisé le ${fmt(datasetResetAt)} : ses événements récents sont datés relativement à ce jour.`);
    return envelope('situation', {}, asOf, { from, to: asOf }, statements, data, [...siteList.map((s) => ({ ref: `SITE:${s.id}`, label: s.name })), ...recent.events.map(refLabel), ...missing.items.slice(0, 6).map((i) => ({ ref: i.ref, label: i.text }))], limits);
  }

  async function changes(u: User, raw: unknown): Promise<ToolResult<ChangesData>> {
    const p = parse(ChangesParamsSchema, raw ?? {});
    const asOf = await dbNow(db);
    const to = p.to && Date.parse(p.to) < Date.parse(asOf) ? p.to : asOf;
    const from = p.from ?? startOfYesterday(asOf);
    if (Date.parse(from) >= Date.parse(to)) throw new HttpError(400, 'VALIDATION', 'Données invalides', { fields: { from: 'Le début de la période doit précéder l’état actuel des données' } });
    const sites = await loadSites(db, u.org_id);
    const LIMIT = 200;
    const r = await eventsBetween(db, u.org_id, sites, { from, to, limit: LIMIT });
    const sinceYesterday = !p.from;
    const head = sinceYesterday ? `Depuis hier (${fmt(from)})` : `Entre le ${fmtSec(from)} et le ${fmtSec(to)}`;
    const statements: Statement[] = r.counts.total
      ? [
          { nature: 'COMPUTED', text: `${head}, ${plural(r.counts.total, 'enregistrement a été reçu', 'enregistrements ont été reçus')} par le serveur : ${countsText(r.counts)}.`, sources: [] },
          ...r.events.slice(0, 12).map((e): Statement => ({ nature: 'FACT', text: eventSentence(e), sources: [e.ref.replace(/#.*$/, '')] })),
        ]
      : [{ nature: 'MISSING', text: `${head}, aucun enregistrement n’a été reçu par le serveur. Sans saisie, rien n’est observé : cela ne dit rien de l’état des animaux.`, sources: [] }];
    const limits = ['La période porte sur la date de réception par le serveur. Un événement ancien saisi récemment y figure : sa date d’événement est indiquée séparément.', NO_SENSOR];
    if (r.truncated) limits.push(`Liste tronquée aux ${LIMIT} enregistrements les plus récents sur ${r.counts.total}. Les totaux portent sur toute la période.`);
    else if (r.events.length > 12) limits.push(`Les ${r.events.length - 12} autres enregistrements figurent dans la chronologie.`);
    return envelope('changes', { from, to, sinceYesterday }, asOf, { from, to }, statements, { counts: r.counts, events: r.events }, r.events.map(refLabel), limits);
  }

  async function findAnimal(u: User, raw: unknown): Promise<ToolResult<FindAnimalData>> {
    const p = parse(FindAnimalParamsSchema, raw);
    const asOf = await dbNow(db);
    const sites = await loadSites(db, u.org_id);
    // Dans une phrase (« montre-moi b 017 »), on cherche d'abord les identifiants plausibles ; sinon tout le texte.
    const candidates = [...new Set([...extractAnimalIds(p.query), p.query])];
    let found: Awaited<ReturnType<typeof matchAnimals>> = { normalized: normalizeAnimalQuery(p.query), rows: [], exact: false };
    for (const c of candidates) {
      const m = await matchAnimals(db, u.org_id, c);
      if (m.rows.length) {
        found = m;
        break;
      }
    }
    const matches = await withCurrentSite(db, u.org_id, found.rows);
    const statements: Statement[] =
      matches.length === 0
        ? [{ nature: 'MISSING', text: `Aucun animal enregistré ne correspond à « ${p.query} » dans votre périmètre.`, sources: [] }]
        : matches.length === 1
          ? [
              {
                nature: 'FACT',
                text: `${matches[0]!.tag} (${matches[0]!.species}) : ${matches[0]!.currentSiteId ? `lieu actuel enregistré, ${siteName(sites, matches[0]!.currentSiteId)}` : 'aucun lieu actuel enregistré'}.`,
                sources: [`ANIMAL:${matches[0]!.id}`],
              },
            ]
          : [{ nature: 'COMPUTED', text: `${matches.length} animaux correspondent à « ${p.query} » : ${matches.map((m) => m.tag).join(', ')}. Précisez lequel.`, sources: matches.map((m) => `ANIMAL:${m.id}`) }];
    const limits = ['Recherche tolérante à la casse, aux espaces, aux tirets et aux zéros de tête. Limitée à 10 résultats.'];
    return envelope('find_animal', { query: p.query }, asOf, null, statements, { query: p.query, normalized: found.normalized, matches }, matches.map((m) => ({ ref: `ANIMAL:${m.id}`, label: m.tag })), limits);
  }

  async function animal(u: User, raw: unknown): Promise<ToolResult<AnimalData>> {
    const p = parse(AnimalParamsSchema, raw);
    const asOf = await dbNow(db);
    const a = (await db.query<{ id: string; tag: string; species: string }>('SELECT id, tag, species FROM animals WHERE id = $1 AND org_id = $2', [p.animalId, u.org_id])).rows[0];
    if (!a) throw new HttpError(404, 'NOT_FOUND', 'Animal introuvable dans votre périmètre');
    const sites = await loadSites(db, u.org_id);
    const recs = await currentRecords(db, u.org_id, [a.id]);
    const open = recs.filter((r): r is Presence => r.kind === 'presence' && r.end === null);
    const LIMIT = 300;
    const all = await eventsBetween(db, u.org_id, sites, { from: EPOCH, to: asOf, animalId: a.id, limit: LIMIT });
    const timeline = [...all.events].sort((x, y) => sortKey(y) - sortKey(x) || Date.parse(y.recordedAt) - Date.parse(x.recordedAt));
    const observations = timeline.filter((e) => e.type === 'OBSERVATION').sort((x, y) => Date.parse(y.recordedAt) - Date.parse(x.recordedAt));
    const moves = recs.filter((r) => r.kind === 'movement').length;
    const corrections = timeline.filter((e) => e.type === 'CORRECTION').length;
    const missing = await computeMissing(db, u.org_id, sites, a.id);
    const cur = open[0];
    const statements: Statement[] = [
      cur
        ? { nature: 'FACT', text: `${a.tag} (${a.species}) : lieu actuel enregistré, ${siteName(sites, cur.locationId)}, depuis ${formatTemporal(cur.start)} (${cur.id}, révision ${cur.rev}).`, sources: [`REC:${cur.id}@${cur.rev}`, `ANIMAL:${a.id}`] }
        : { nature: 'MISSING', text: `${a.tag} (${a.species}) : aucun lieu actuel enregistré.`, sources: [`ANIMAL:${a.id}`] },
      { nature: 'COMPUTED', text: `${plural(moves, 'déplacement enregistré', 'déplacements enregistrés')}, ${plural(observations.length, 'observation', 'observations')}, ${plural(corrections, 'correction', 'corrections')}.`, sources: [] },
      observations[0]
        ? { nature: 'FACT', text: `Dernière observation reçue : « ${observations[0].detail} » (événement : ${formatTemporal(observations[0].eventTime as TemporalValue)} ; reçue le ${fmt(observations[0].recordedAt)}).`, sources: [observations[0].ref] }
        : { nature: 'MISSING', text: 'Aucune observation enregistrée pour cet animal. Cela ne renseigne pas sur son état.', sources: [] },
      ...(missing.items.length ? [{ nature: 'MISSING' as const, text: `À compléter : ${missing.items.slice(0, 3).map((i) => i.text).join(' ')}`, sources: missing.items.slice(0, 3).map((i) => i.ref) }] : []),
    ];
    const siteIds = [...new Set([...(cur ? [cur.locationId] : []), ...timeline.flatMap((e) => e.siteIds)])];
    const limits = ['Chronologie triée par date d’événement ; un événement sans date connue est placé à sa date de réception.', NO_SENSOR];
    if (all.truncated) limits.push(`Chronologie tronquée aux ${LIMIT} enregistrements les plus récents.`);
    return envelope('animal', { animalId: a.id }, asOf, null, statements, { animal: a, currentSiteId: cur?.locationId ?? null, siteIds, timeline, missing: missing.items }, [{ ref: `ANIMAL:${a.id}`, label: a.tag }, ...timeline.map(refLabel)], limits);
  }

  async function missing(u: User): Promise<ToolResult<MissingData>> {
    const asOf = await dbNow(db);
    const sites = await loadSites(db, u.org_id);
    const m = await computeMissing(db, u.org_id, sites);
    const LIMIT = 60;
    const c = m.counts;
    const statements: Statement[] = m.items.length
      ? [
          {
            nature: 'COMPUTED',
            text: `${plural(m.items.length, 'information à compléter ou à vérifier', 'informations à compléter ou à vérifier')} : ${plural(c.OPEN_TASK, 'tâche ouverte', 'tâches ouvertes')}, ${plural(c.INCONSISTENT, 'incohérence', 'incohérences')}, ${plural(c.NO_CURRENT_SITE, 'animal sans lieu actuel', 'animaux sans lieu actuel')}, ${plural(c.UNKNOWN_TIME, 'date inconnue', 'dates inconnues')}, ${plural(c.DAY_ONLY, 'date sans heure', 'dates sans heure')}.`,
            sources: [],
          },
          ...m.items.slice(0, 12).map((i): Statement => ({ nature: 'MISSING', text: i.text, sources: [i.ref] })),
        ]
      : [{ nature: 'COMPUTED', text: 'Aucune information à compléter n’a été détectée par les contrôles actuels.', sources: [] }];
    const limits = ['Contrôles effectués : lieu actuel (présence ouverte), dates inconnues ou sans heure, arrivée avant départ, présences ouvertes multiples, tâches non terminées. Une information non contrôlée peut manquer sans apparaître ici.'];
    if (m.items.length > LIMIT) limits.push(`Liste tronquée à ${LIMIT} éléments sur ${m.items.length}.`);
    return envelope('missing', {}, asOf, null, statements, { counts: c, items: m.items.slice(0, LIMIT) }, m.items.slice(0, LIMIT).map((i) => ({ ref: i.ref, label: i.text })), limits);
  }

  async function source(u: User, raw: unknown): Promise<ToolResult<SourceData>> {
    const p = parse(SourceParamsSchema, raw);
    const asOf = await dbNow(db);
    const sites = await loadSites(db, u.org_id);
    const m = /^(OBS|REC|TASK|ANIMAL|SITE):([^@#]+)(?:@(\d{1,6}))?(?:#.*)?$/.exec(p.ref);
    const notFound = () => new HttpError(404, 'NOT_FOUND', 'Source introuvable dans votre périmètre');
    if (!m) throw notFound();
    const [, kind, id, revStr] = m as unknown as [string, string, string, string | undefined];
    let data: SourceData;
    if (kind === 'OBS') {
      if (!isUuid(id)) throw notFound();
      const o = (
        await db.query<Record<string, unknown>>(
          `SELECT o.*, u.name AS author, i.id AS investigation_id FROM observations o LEFT JOIN users u ON u.id = o.author_id LEFT JOIN investigations i ON i.observation_id = o.id WHERE o.id = $1 AND o.org_id = $2`,
          [id, u.org_id],
        )
      ).rows[0];
      if (!o) throw notFound();
      const ev = (await eventsBetween(db, u.org_id, sites, { from: EPOCH, to: asOf, animalId: String(o.animal_id), limit: 300 })).events.find((e) => e.ref === `OBS:${id}`) ?? null;
      data = {
        ref: `OBS:${id}`,
        kind: 'observation',
        title: `Observation sur ${o.animal_id}`,
        fields: [
          { label: 'Animal', value: String(o.animal_id) },
          { label: 'Lieu déclaré', value: siteName(sites, String(o.location_id)) },
          { label: 'Texte saisi', value: String(o.note) },
          { label: 'Date de l’événement', value: formatTemporal(json<TemporalValue>(o.event_time)) },
          { label: 'Saisie sur l’appareil', value: fmt(iso(o.recorded_at_client)) },
          { label: 'Réception par le serveur', value: fmt(iso(o.received_at)) },
          { label: 'Auteur', value: String(o.author ?? 'non enregistré') },
          { label: 'Suivi', value: o.status === 'NEW' ? 'Reçue, pas encore examinée par un vétérinaire' : o.status === 'UNDER_INVESTIGATION' ? 'Enquête ouverte par un vétérinaire' : 'Classée par un vétérinaire' },
        ],
        event: ev,
        revisions: [],
      };
    } else if (kind === 'REC') {
      const rows = (
        await db.query<Record<string, unknown>>(
          `SELECT r.rev, r.kind, r.data, r.reason, r.recorded_at, u.name AS author FROM record_revisions r LEFT JOIN users u ON u.id = r.author_id WHERE r.record_id = $1 AND r.org_id = $2 ORDER BY r.rev`,
          [id, u.org_id],
        )
      ).rows;
      const row = revStr ? rows.find((r) => Number(r.rev) === Number(revStr)) : rows.at(-1);
      if (!row) throw notFound();
      const rec = { id, rev: Number(row.rev), ...json<object>(row.data) } as Rec;
      const latest = Number(rows.at(-1)!.rev);
      data = {
        ref: `REC:${id}@${rec.rev}`,
        kind: 'record',
        title: `${rec.kind === 'presence' ? 'Présence' : 'Déplacement'} ${id}, révision ${rec.rev}${rec.rev < latest ? ` (remplacée par la révision ${latest}, conservée)` : ''}`,
        fields: [
          { label: 'Animal', value: rec.animalId },
          ...(rec.kind === 'presence'
            ? [
                { label: 'Lieu', value: siteName(sites, rec.locationId) },
                { label: 'Début', value: formatTemporal(rec.start) },
                { label: 'Fin', value: rec.end === null ? 'présence ouverte (fin non enregistrée)' : formatTemporal(rec.end) },
              ]
            : [
                { label: 'Trajet', value: `${siteName(sites, rec.fromLocationId)} vers ${siteName(sites, rec.toLocationId)}` },
                { label: 'Départ', value: formatTemporal(rec.departure) },
                { label: 'Arrivée', value: formatTemporal(rec.arrival) },
              ]),
          { label: 'Statut', value: rec.verification === 'VERIFIED' ? 'Vérifié' : rec.verification === 'TO_VERIFY' ? 'À vérifier' : 'Déclaré, non vérifié' },
          { label: 'Origine', value: rec.source },
          { label: 'Réception par le serveur', value: fmt(iso(row.recorded_at)) },
        ],
        event: null,
        revisions: rows.map((r) => {
          const d = { id, rev: Number(r.rev), ...json<object>(r.data) } as Rec;
          return { rev: Number(r.rev), recordedAt: iso(r.recorded_at), author: (r.author as string | null) ?? null, reason: (r.reason as string | null) ?? null, summary: describeRecord(d, sites) };
        }),
      };
    } else if (kind === 'TASK') {
      if (!isUuid(id)) throw notFound();
      const t = (await db.query<Record<string, unknown>>('SELECT * FROM verification_tasks WHERE id = $1 AND org_id = $2', [id, u.org_id])).rows[0];
      if (!t) throw notFound();
      data = {
        ref: `TASK:${id}`,
        kind: 'task',
        title: String(t.label),
        fields: [
          { label: 'Enregistrement concerné', value: String(t.record_id) },
          { label: 'État', value: t.status === 'DONE' ? `Complétée (révision ${t.done_rev})` : t.status === 'REQUESTED' ? 'Demandée à un agent' : 'À demander' },
          { label: 'Proposée le', value: fmt(iso(t.created_at)) },
          ...(t.requested_at ? [{ label: 'Demandée le', value: fmt(iso(t.requested_at)) }] : []),
          ...(t.done_at ? [{ label: 'Complétée le', value: fmt(iso(t.done_at)) }] : []),
        ],
        event: null,
        revisions: [],
      };
    } else if (kind === 'ANIMAL') {
      const a = (await db.query<{ id: string; tag: string; species: string }>('SELECT id, tag, species FROM animals WHERE id = $1 AND org_id = $2', [id, u.org_id])).rows[0];
      if (!a) throw notFound();
      const [match] = await withCurrentSite(db, u.org_id, [a]);
      data = {
        ref: `ANIMAL:${a.id}`,
        kind: 'animal',
        title: `Animal ${a.tag}`,
        fields: [
          { label: 'Identifiant', value: a.tag },
          { label: 'Espèce', value: a.species },
          { label: 'Lieu actuel enregistré', value: match?.currentSiteId ? siteName(sites, match.currentSiteId) : 'aucun (pas de présence ouverte)' },
        ],
        event: null,
        revisions: [],
      };
    } else {
      const s = sites.get(id);
      if (!s) throw notFound();
      const n = (await currentRecords(db, u.org_id)).filter((r) => r.kind === 'presence' && r.end === null && r.locationId === s.id).length;
      data = {
        ref: `SITE:${s.id}`,
        kind: 'site',
        title: s.name,
        fields: [
          { label: 'Type', value: s.kind === 'FARM' ? 'Élevage' : 'Marché' },
          { label: 'Code', value: s.code },
          { label: 'Animaux avec une présence ouverte', value: String(n) },
        ],
        event: null,
        revisions: [],
      };
    }
    const statements: Statement[] = [{ nature: 'FACT', text: `${data.title}.`, sources: [data.ref] }];
    return envelope('source', { ref: data.ref }, asOf, null, statements, data, [{ ref: data.ref, label: data.title }], ['Enregistrement affiché tel qu’il est stocké. Les révisions précédentes sont conservées, rien n’est écrasé.']);
  }

  async function prepareObservation(u: User, raw: unknown): Promise<ToolResult<ObservationDraftData>> {
    const p = parse(PrepareObservationSchema, raw);
    // Sans aucun paramètre : brouillon vide pour la saisie manuelle (tous les champs sont « à compléter »).
    const asOf = await dbNow(db);
    const sites = await loadSites(db, u.org_id);
    const text = p.text ?? '';

    // Animal : explicite, sinon lu dans le texte, sinon celui affiché à l'écran (signalé comme déduit).
    let animalField: DraftField<string>;
    const mentioned = extractAnimalIds(text);
    const resolved: AnimalMatch[] = [];
    const tries = p.animalId ? [p.animalId] : mentioned;
    for (const t of tries) {
      const m = await matchAnimals(db, u.org_id, t);
      if (m.exact) for (const r of await withCurrentSite(db, u.org_id, m.rows)) if (!resolved.some((x) => x.id === r.id)) resolved.push(r);
    }
    let chosen: AnimalMatch | null = null;
    if (resolved.length === 1) {
      chosen = resolved[0]!;
      animalField = { value: chosen.id, status: 'OK', message: null };
    } else if (resolved.length > 1) {
      animalField = { value: null, status: 'AMBIGUOUS', message: 'Plusieurs animaux correspondent. Choisissez lequel avant d’enregistrer.', candidates: resolved.map((r) => ({ id: r.id, label: r.tag })) };
    } else if (!p.animalId && p.contextAnimalId) {
      const [ctx] = await withCurrentSite(db, u.org_id, (await matchAnimals(db, u.org_id, p.contextAnimalId)).rows.slice(0, 1));
      if (ctx) {
        chosen = ctx;
        animalField = { value: ctx.id, status: 'DEDUCED', message: `Aucun animal n’est nommé dans le texte : ${ctx.tag}, affiché à l’écran, est proposé. À vérifier.` };
      } else animalField = { value: null, status: 'MISSING', message: 'Indiquez l’animal concerné.' };
    } else {
      animalField = { value: null, status: 'MISSING', message: tries.length ? `Aucun animal enregistré ne correspond à « ${tries.join(', ')} ».` : 'Indiquez l’animal concerné.' };
    }

    // Lieu : explicite, sinon nommé dans le texte, sinon lieu actuel enregistré de l'animal (signalé comme déduit).
    let siteField: DraftField<string>;
    const named = [...sites.values()].filter((s) => text.toLowerCase().includes(s.name.toLowerCase()));
    if (p.siteId) siteField = sites.has(p.siteId) ? { value: p.siteId, status: 'OK', message: null } : { value: null, status: 'MISSING', message: 'Lieu inconnu dans votre périmètre.' };
    else if (named.length === 1) siteField = { value: named[0]!.id, status: 'OK', message: null };
    else if (named.length > 1) siteField = { value: null, status: 'AMBIGUOUS', message: 'Plusieurs lieux sont nommés. Choisissez le lieu de l’observation.', candidates: named.map((s) => ({ id: s.id, label: s.name })) };
    else if (chosen?.currentSiteId) siteField = { value: chosen.currentSiteId, status: 'DEDUCED', message: `Lieu non précisé : ${siteName(sites, chosen.currentSiteId)}, lieu actuel enregistré de l’animal, est proposé. À vérifier.` };
    else siteField = { value: null, status: 'MISSING', message: chosen ? `Aucun lieu actuel n’est enregistré pour ${chosen.tag} : choisissez le lieu de l’observation.` : 'Choisissez le lieu de l’observation.' };

    let timeField: DraftField<TemporalValueDto>;
    if (p.eventTime) {
      const future = p.eventTime.precision !== 'UNKNOWN' && bounds(p.eventTime as TemporalValue).min > Date.parse(asOf) + 5 * 60_000;
      timeField = future ? { value: null, status: 'MISSING', message: 'La date indiquée est dans le futur. Vérifiez la date.' } : { value: p.eventTime, status: 'OK', message: p.eventTime.precision === 'UNKNOWN' ? 'Date de l’événement déclarée inconnue.' : null };
    } else timeField = parseEventTime(text, asOf);

    const noteText = (p.note ?? extractNote(text, [...new Set([...mentioned, ...(chosen ? [chosen.id, chosen.tag] : [])])])).trim();
    const noteField: DraftField<string> = noteText.length >= 3 ? { value: noteText, status: 'OK', message: null } : { value: noteText || null, status: 'MISSING', message: 'Décrivez ce qui est constaté (3 caractères minimum), sans conclusion diagnostique.' };

    let possibleDuplicate: SourceRef | null = null;
    if (chosen && noteField.status === 'OK') {
      const dup = (
        await db.query<{ id: string; received_at: unknown }>(
          `SELECT id, received_at FROM observations WHERE org_id = $1 AND animal_id = $2 AND lower(btrim(note)) = lower($3) AND received_at > $4 ORDER BY received_at DESC LIMIT 1`,
          [u.org_id, chosen.id, noteText, new Date(Date.parse(asOf) - DAY_MS).toISOString()],
        )
      ).rows[0];
      if (dup) possibleDuplicate = { ref: `OBS:${dup.id}`, label: `Observation identique reçue le ${fmt(iso(dup.received_at))}` };
    }

    const fields = [animalField, siteField, timeField, noteField];
    const ready = fields.every((f) => f.status !== 'MISSING' && f.status !== 'AMBIGUOUS');
    const blocking = fields.filter((f) => f.status === 'MISSING' || f.status === 'AMBIGUOUS');
    const toCheck = fields.filter((f) => f.status === 'DEDUCED' || f.status === 'TO_CONFIRM');
    const statements: Statement[] = [
      { nature: 'SUGGESTION', text: 'Brouillon préparé. Rien n’est enregistré tant que vous n’avez pas confirmé.', sources: [] },
      ...blocking.map((f): Statement => ({ nature: 'MISSING', text: f.message ?? 'Champ à compléter.', sources: [] })),
      ...toCheck.map((f): Statement => ({ nature: 'SUGGESTION', text: f.message ?? 'Valeur proposée, à vérifier.', sources: [] })),
      ...(possibleDuplicate ? [{ nature: 'FACT' as const, text: `${possibleDuplicate.label} pour cet animal : vérifiez qu’il ne s’agit pas d’un doublon.`, sources: [possibleDuplicate.ref] }] : []),
    ];
    const data: ObservationDraftData = { sourceText: p.text ?? null, animal: animalField, site: siteField, eventTime: timeField, note: noteField, ready, possibleDuplicate };
    const limits = ['Lecture du texte par règles fixes (identifiant, lieu nommé, « hier », « ce matin », heure). Ce qui n’est pas reconnu reste à compléter : rien n’est deviné.'];
    return envelope('prepare_observation', { text: p.text ?? null, contextAnimalId: p.contextAnimalId ?? null }, asOf, null, statements, data, [...(chosen ? [{ ref: `ANIMAL:${chosen.id}`, label: chosen.tag }] : []), ...(possibleDuplicate ? [possibleDuplicate] : [])], limits);
  }

  return { situation, changes, findAnimal, animal, missing, source, prepareObservation };
}

export type FarmTools = ReturnType<typeof farmTools>;

interface Ctx {
  app: FastifyInstance;
  db: Db;
  currentUser: (req: FastifyRequest) => Promise<User>;
}

/** Routes de l'exploitation : les écrans appellent directement les mêmes fonctions que l'assistant. */
export function registerFarm(ctx: Ctx): FarmTools {
  const tools = farmTools(ctx.db);
  ctx.app.get('/api/farm/situation', async (req) => tools.situation(await ctx.currentUser(req)));
  ctx.app.get('/api/farm/changes', async (req) => tools.changes(await ctx.currentUser(req), req.query ?? {}));
  ctx.app.get('/api/farm/animals', async (req) => tools.findAnimal(await ctx.currentUser(req), { query: (req.query as { q?: string } | undefined)?.q ?? '' }));
  ctx.app.get('/api/farm/animals/:id', async (req) => tools.animal(await ctx.currentUser(req), { animalId: (req.params as { id: string }).id }));
  ctx.app.get('/api/farm/missing', async (req) => tools.missing(await ctx.currentUser(req)));
  ctx.app.get('/api/farm/sources', async (req) => tools.source(await ctx.currentUser(req), req.query ?? {}));
  ctx.app.post('/api/farm/observations/draft', async (req) => tools.prepareObservation(await ctx.currentUser(req), req.body));
  return tools;
}
