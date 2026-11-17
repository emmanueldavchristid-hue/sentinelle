import { stableStringify } from '@sentinelle/domain';
import type { Queryable } from './db.js';
import { HttpError, sha256, type User } from './http.js';

/**
 * Rejeu d'une opération déjà effectuée (réponse perdue, double envoi).
 * La clé n'est rejouée que pour le même utilisateur, la même organisation, la même opération, la même cible
 * et le même contenu ; sinon conflit 409 (jamais de faux succès).
 */
export function requestHash(body: Record<string, unknown>): string {
  const { idempotencyKey: _ignored, ...rest } = body;
  return sha256(stableStringify(rest));
}

export async function findReplay(q: Queryable, key: string, u: User, op: string, target: string, hash: string): Promise<object | null> {
  const row = (
    await q.query<{ response: unknown; op: string; org_id: string | null; user_id: string | null; target: string | null; request_hash: string | null }>(
      'SELECT response, op, org_id, user_id, target, request_hash FROM idempotent_ops WHERE key = $1',
      [key],
    )
  ).rows[0];
  if (!row) return null;
  if (row.op !== op || row.org_id !== u.org_id || row.user_id !== u.id || row.target !== target || row.request_hash !== hash) {
    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Cette clé d’opération a déjà servi pour une autre requête : rien n’a été modifié. Rechargez la page puis recommencez.');
  }
  return (typeof row.response === 'string' ? JSON.parse(row.response) : row.response) as object;
}

export async function saveReplay(q: Queryable, key: string, u: User, op: string, target: string, hash: string, response: object) {
  await q.query('INSERT INTO idempotent_ops(key, op, response, org_id, user_id, target, request_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    key,
    op,
    JSON.stringify(response),
    u.org_id,
    u.id,
    target,
    hash,
  ]);
}

/** Verrou transactionnel (PostgreSQL) : sérialise les écritures concurrentes sur une même ressource. */
export async function lock(q: Queryable, resource: string) {
  await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [resource]);
}
