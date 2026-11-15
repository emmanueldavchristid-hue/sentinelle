import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { bounds, presenceBounds, type TemporalValue } from '@sentinelle/domain';
import { RecordDataSchema } from '@sentinelle/contracts';
import type { Db, Queryable } from './db.js';
import { HttpError, parse, sha256, type User } from './http.js';

/**
 * Import CSV de présences et de mouvements, avec prévisualisation.
 * Colonnes : type;id;animal;lieu;lieu_arrivee;debut;fin;source
 * Cellules temporelles (heure d'Abidjan = UTC) :
 *   2026-03-01T08:00  → date et heure
 *   2026-03-01        → jour seulement (aucune heure supposée)
 *   2026-03-01T08:00/2026-03-01T10:00 → intervalle
 *   vide ou « inconnu » → inconnue ; « en cours » → fin de présence ouverte
 */
export const CSV_COLUMNS = ['type', 'id', 'animal', 'lieu', 'lieu_arrivee', 'debut', 'fin', 'source'] as const;
export const MAX_IMPORT_BYTES = 256 * 1024;
export const MAX_IMPORT_ROWS = 2000;

export const CSV_TEMPLATE = [
  CSV_COLUMNS.join(';'),
  'presence;P100;B-017;A;;2026-02-26T07:00;2026-02-26T15:00;registre élevage (exemple)',
  'presence;P101;B-031;M;;2026-02-27;2026-02-27;registre marché (exemple, heures inconnues)',
  'mouvement;MV100;B-031;M;D;2026-02-27T15:00;2026-02-27T17:30;registre marché (exemple)',
].join('\r\n');

/** Analyse CSV (RFC 4180 simplifiée) : guillemets, séparateur « ; » ou « , » détecté sur l'en-tête. */
export function parseCsv(text: string): { header: string[]; rows: { line: number; cells: string[] }[]; separator: string } {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const separator = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (quoted) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === '\n') line++;
        cell += c;
      }
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === separator) {
      cells.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      cells.push(cell);
      records.push({ line: startLine, cells });
      cells = [];
      cell = '';
      line++;
      startLine = line;
    } else cell += c;
  }
  if (cell !== '' || cells.length) {
    cells.push(cell);
    records.push({ line: startLine, cells });
  }
  const nonEmpty = records.filter((r) => r.cells.some((c) => c.trim() !== ''));
  const [head, ...rows] = nonEmpty;
  return { header: (head?.cells ?? []).map((h) => h.trim().toLowerCase()), rows, separator };
}

export function parseTemporalCell(raw: string, allowOpen: boolean): { value: TemporalValue | null; error?: string } {
  const v = raw.trim();
  if (v === '' || v.toLowerCase() === 'inconnu' || v.toLowerCase() === 'inconnue') return { value: { precision: 'UNKNOWN' } };
  if (v.toLowerCase() === 'en cours') return allowOpen ? { value: null } : { value: { precision: 'UNKNOWN' }, error: '« en cours » n’est possible que pour la fin d’une présence' };
  const inst = (s: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}:00Z`)) ? `${s}:00.000Z` : null);
  if (/^\d{2}\/\d{2}\/\d{4}/.test(v)) return { value: { precision: 'UNKNOWN' }, error: `Date invalide « ${v} » : utilisez le format AAAA-MM-JJ (ex. 2026-03-01)` };
  if (v.includes('/')) {
    const [a, b] = v.split('/').map((x) => x.trim());
    const fa = inst(a ?? '');
    const fb = inst(b ?? '');
    if (!fa || !fb) return { value: { precision: 'UNKNOWN' }, error: `Intervalle invalide « ${v} » (attendu AAAA-MM-JJTHH:MM/AAAA-MM-JJTHH:MM)` };
    if (Date.parse(fb) < Date.parse(fa)) return { value: { precision: 'UNKNOWN' }, error: `Intervalle inversé « ${v} »` };
    return { value: { precision: 'INTERVAL', from: fa, to: fb } };
  }
  const i = inst(v);
  if (i) return { value: { precision: 'INSTANT', at: i } };
  if (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))) return { value: { precision: 'DAY', date: v } };
  return { value: { precision: 'UNKNOWN' }, error: `Date invalide « ${v} » (attendu AAAA-MM-JJ ou AAAA-MM-JJTHH:MM)` };
}

export interface PreviewRow {
  line: number;
  status: 'ok' | 'warning' | 'error';
  messages: string[];
  recordId: string;
  kind: 'presence' | 'movement' | null;
  data: unknown | null;
  newAnimal: string | null;
}

export async function previewCsv(q: Queryable, orgId: string, text: string) {
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw new HttpError(413, 'TOO_LARGE', `Fichier trop volumineux (maximum ${MAX_IMPORT_BYTES / 1024} Ko)`);
  const { header, rows } = parseCsv(text);
  const missing = CSV_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) throw new HttpError(400, 'VALIDATION', `Colonnes manquantes : ${missing.join(', ')}`, { fields: { file: `En-tête attendu : ${CSV_COLUMNS.join(';')}` } });
  if (rows.length === 0) throw new HttpError(400, 'VALIDATION', 'Aucune ligne de données', { fields: { file: 'Le fichier ne contient que l’en-tête' } });
  if (rows.length > MAX_IMPORT_ROWS) throw new HttpError(413, 'TOO_LARGE', `Trop de lignes (maximum ${MAX_IMPORT_ROWS})`);

  const idx = Object.fromEntries(CSV_COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<(typeof CSV_COLUMNS)[number], number>;
  const animals = new Set((await q.query<{ id: string }>('SELECT id FROM animals WHERE org_id = $1', [orgId])).rows.map((r) => r.id));
  const locations = new Set((await q.query<{ id: string }>('SELECT id FROM locations WHERE org_id = $1', [orgId])).rows.map((r) => r.id));
  const existing = new Set((await q.query<{ record_id: string }>('SELECT DISTINCT record_id FROM record_revisions WHERE org_id = $1', [orgId])).rows.map((r) => r.record_id));
  // Identifiants réservés par d'autres organisations : refusés aussi (clé primaire globale).
  const taken = new Set((await q.query<{ record_id: string }>('SELECT DISTINCT record_id FROM record_revisions WHERE org_id <> $1', [orgId])).rows.map((r) => r.record_id));
  const otherOrgAnimals = new Set((await q.query<{ id: string }>('SELECT id FROM animals WHERE org_id <> $1', [orgId])).rows.map((r) => r.id));
  const seenIds = new Map<string, number>();
  const seenContent = new Map<string, number>();

  const out: PreviewRow[] = rows.map(({ line, cells }) => {
    const get = (c: (typeof CSV_COLUMNS)[number]) => (cells[idx[c]] ?? '').trim();
    const messages: string[] = [];
    const st: { level: PreviewRow['status'] } = { level: 'ok' };
    const err = (m: string) => (messages.push(m), (st.level = 'error'));
    const warn = (m: string) => (messages.push(m), st.level !== 'error' && (st.level = 'warning'));
    const typeRaw = get('type').toLowerCase();
    const kind = typeRaw === 'presence' || typeRaw === 'présence' ? 'presence' : typeRaw === 'mouvement' || typeRaw === 'movement' ? 'movement' : null;
    const id = get('id');
    const animal = get('animal');
    const lieu = get('lieu');
    const lieu2 = get('lieu_arrivee');
    const source = get('source') || 'import CSV';
    if (!kind) err(`Type « ${get('type')} » inconnu (presence ou mouvement)`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(id)) err('Identifiant manquant ou invalide (lettres, chiffres, - _ ., 40 caractères max.)');
    else if (existing.has(id)) err(`L’identifiant ${id} existe déjà : utilisez une correction (nouvelle révision), pas un import`);
    else if (taken.has(id)) err(`L’identifiant ${id} est déjà utilisé`);
    else if (seenIds.has(id)) err(`Identifiant ${id} en double dans le fichier (ligne ${seenIds.get(id)})`);
    if (id) seenIds.set(id, seenIds.get(id) ?? line);
    let newAnimal: string | null = null;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(animal)) err('Animal manquant ou invalide');
    else if (otherOrgAnimals.has(animal)) err(`Animal ${animal} hors de votre périmètre`);
    else if (!animals.has(animal)) {
      newAnimal = animal;
      warn(`Animal ${animal} inconnu : il sera créé (bovin)`);
    }
    if (!locations.has(lieu)) err(`Lieu « ${lieu} » inconnu dans votre périmètre`);
    if (kind === 'movement' && !locations.has(lieu2)) err(`Lieu d’arrivée « ${lieu2} » inconnu dans votre périmètre`);
    if (kind === 'presence' && lieu2) warn('lieu_arrivee ignoré pour une présence');
    if (source.length > 200) err('Source trop longue (200 caractères max.)');

    const start = parseTemporalCell(get('debut'), false);
    const end = parseTemporalCell(get('fin'), kind === 'presence');
    if (start.error) err(`debut : ${start.error}`);
    if (end.error) err(`fin : ${end.error}`);
    let data: unknown = null;
    if (kind && st.level !== 'error') {
      if (start.value?.precision === 'UNKNOWN') warn('debut inconnu');
      if (kind === 'presence') {
        const b = presenceBounds(start.value as TemporalValue, end.value);
        if (b.endMax < b.startMin) err('La fin de présence précède le début');
        data = { kind, animalId: animal, locationId: lieu, start: start.value, end: end.value, verification: 'DECLARED', source };
      } else {
        if (end.value === null) err('Arrivée obligatoire pour un mouvement');
        else if (bounds(end.value).max < bounds(start.value as TemporalValue).min) warn('Arrivée antérieure au départ : sera signalé comme anomalie de données');
        if (lieu === lieu2) warn('Lieu de départ et d’arrivée identiques');
        data = { kind, animalId: animal, fromLocationId: lieu, toLocationId: lieu2, departure: start.value, arrival: end.value ?? { precision: 'UNKNOWN' }, verification: 'DECLARED', source };
      }
      if ((st.level as PreviewRow['status']) !== 'error') {
        const check = RecordDataSchema.safeParse(data);
        if (!check.success) err(`Donnée refusée : ${check.error.issues[0]?.message ?? 'format invalide'}`);
        const sig = JSON.stringify(data);
        if (seenContent.has(sig)) warn(`Contenu identique à la ligne ${seenContent.get(sig)} (doublon probable)`);
        else seenContent.set(sig, line);
      }
    }
    return { line, status: st.level, messages, recordId: id, kind, data: st.level === 'error' ? null : data, newAnimal };
  });
  const counts = { total: out.length, ok: out.filter((r) => r.status === 'ok').length, warning: out.filter((r) => r.status === 'warning').length, error: out.filter((r) => r.status === 'error').length };
  return { fileHash: sha256(text), rows: out, counts, canCommit: counts.error === 0 };
}

interface Ctx {
  app: FastifyInstance;
  db: Db;
  currentUser: (req: FastifyRequest) => Promise<User>;
  requireRole: (u: User, ...roles: User['role'][]) => void;
  audit: (q: Queryable, u: User | null, action: string, entity: string, id: string, detail?: unknown) => Promise<void>;
}

const PreviewSchema = z.object({ csv: z.string().min(1, 'Fichier vide') });
const CommitSchema = z.object({ csv: z.string().min(1, 'Fichier vide'), idempotencyKey: z.uuid(), fileHash: z.string().regex(/^[0-9a-f]{64}$/) });

export function registerImport(ctx: Ctx) {
  ctx.app.get('/api/import/template.csv', async (req, reply) => {
    await ctx.currentUser(req);
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="sentinelle-modele-import.csv"');
    return `﻿${CSV_TEMPLATE}\r\n`;
  });

  ctx.app.post('/api/import/preview', { bodyLimit: MAX_IMPORT_BYTES * 2 }, async (req) => {
    const u = await ctx.currentUser(req);
    ctx.requireRole(u, 'VET');
    const body = parse(PreviewSchema, req.body);
    return previewCsv(ctx.db, u.org_id, body.csv);
  });

  /** Import tout-ou-rien : revalidé côté serveur, idempotent, refusé s'il reste une erreur ou si le fichier a changé depuis la prévisualisation. */
  ctx.app.post('/api/import/commit', { bodyLimit: MAX_IMPORT_BYTES * 2 }, async (req, reply) => {
    const u = await ctx.currentUser(req);
    ctx.requireRole(u, 'VET');
    const body = parse(CommitSchema, req.body);
    const replay = (await ctx.db.query<{ response: unknown }>('SELECT response FROM idempotent_ops WHERE key = $1', [body.idempotencyKey])).rows[0];
    if (replay) return reply.status(200).send({ ...(typeof replay.response === 'string' ? JSON.parse(replay.response) : (replay.response as object)), duplicate: true });
    const res = await ctx.db.tx(async (q) => {
      const preview = await previewCsv(q, u.org_id, body.csv);
      if (preview.fileHash !== body.fileHash) throw new HttpError(409, 'CONFLICT', 'Le fichier a changé depuis la prévisualisation : prévisualisez à nouveau');
      if (!preview.canCommit) throw new HttpError(400, 'VALIDATION', `${preview.counts.error} ligne(s) en erreur : rien n’a été importé`);
      const batchId = randomUUID();
      await q.query('INSERT INTO import_batches(id, org_id, author_id, file_hash, row_count) VALUES ($1,$2,$3,$4,$5)', [batchId, u.org_id, u.id, preview.fileHash, preview.rows.length]);
      const created = new Set<string>();
      for (const r of preview.rows) {
        if (r.newAnimal && !created.has(r.newAnimal)) {
          await q.query('INSERT INTO animals(id, org_id, tag) VALUES ($1,$2,$1) ON CONFLICT DO NOTHING', [r.newAnimal, u.org_id]);
          created.add(r.newAnimal);
        }
        await q.query('INSERT INTO record_revisions(record_id, rev, org_id, kind, data, author_id, reason) VALUES ($1,1,$2,$3,$4,$5,$6)', [
          r.recordId,
          u.org_id,
          r.kind,
          JSON.stringify(r.data),
          u.id,
          `import CSV ${batchId.slice(0, 8)}`,
        ]);
      }
      const response = { batchId, imported: preview.rows.length, animalsCreated: [...created], warnings: preview.counts.warning };
      await q.query('INSERT INTO idempotent_ops(key, op, response) VALUES ($1,$2,$3)', [body.idempotencyKey, 'import_commit', JSON.stringify(response)]);
      await ctx.audit(q, u, 'IMPORT_COMMITTED', 'import', batchId, { rows: preview.rows.length, fileHash: preview.fileHash });
      return response;
    });
    return reply.status(201).send({ ...res, duplicate: false });
  });
}
