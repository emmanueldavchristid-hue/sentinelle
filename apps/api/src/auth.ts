import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db, Queryable } from './db.js';
import { HttpError, parse, sha256, type User } from './http.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };
export const SESSION_COOKIE = 'sentinelle_session';

export interface AuthConfig {
  sessionHours: number;
  secureCookie: boolean;
  maxFailures: number;
  lockMinutes: number;
}
const DEFAULTS: AuthConfig = { sessionHours: 8, secureCookie: false, maxFailures: 5, lockMinutes: 15 };

/** Format : scrypt$N$r$p$sel$hachage (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // Calcul effectué même sans hachage stocké, pour ne pas révéler l'existence du compte par le temps de réponse.
  const parts = (stored ?? `scrypt$${SCRYPT.N}$8$1$${'A'.repeat(22)}$${'A'.repeat(43)}`).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return stored !== null && actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export async function sessionUser(db: Queryable, req: FastifyRequest): Promise<User | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const u = (
    await db.query<User>(
      `SELECT u.id, u.org_id, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`,
      [sha256(token)],
    )
  ).rows[0];
  return u ?? null;
}

interface Ctx {
  app: FastifyInstance;
  db: Db;
  demoMode: boolean;
  audit: (q: Queryable, u: User | null, action: string, entity: string, id: string, detail?: unknown) => Promise<void>;
}

const LoginSchema = z.object({
  username: z.string().trim().min(1, 'Identifiant requis').max(60),
  password: z.string().min(1, 'Mot de passe requis').max(200),
});

export function registerAuth(ctx: Ctx, cfg: Partial<AuthConfig> = {}) {
  const conf = { ...DEFAULTS, ...cfg };
  const failures = new Map<string, { count: number; until: number }>();
  const cookieAttrs = (maxAge: number) => `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${conf.secureCookie ? '; Secure' : ''}`;

  ctx.app.post('/api/auth/login', async (req, reply) => {
    const body = parse(LoginSchema, req.body);
    const key = `${body.username.toLowerCase()}|${req.ip}`;
    const f = failures.get(key);
    if (f && f.count >= conf.maxFailures && f.until > Date.now()) {
      throw new HttpError(429, 'TOO_MANY_ATTEMPTS', `Trop de tentatives. Réessayez dans ${conf.lockMinutes} minutes.`);
    }
    const row = (
      await ctx.db.query<User & { password_hash: string | null; disabled: boolean }>(
        'SELECT id, org_id, name, role, password_hash, disabled FROM users WHERE lower(username) = lower($1)',
        [body.username],
      )
    ).rows[0];
    const ok = await verifyPassword(body.password, row?.password_hash ?? null);
    if (!row || !ok || row.disabled) {
      const prev = f && f.until > Date.now() ? f.count : 0;
      failures.set(key, { count: prev + 1, until: Date.now() + conf.lockMinutes * 60_000 });
      await ctx.audit(ctx.db, null, 'LOGIN_FAILED', 'user', body.username.slice(0, 60));
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Identifiant ou mot de passe incorrect');
    }
    failures.delete(key);
    const token = randomBytes(32).toString('base64url');
    await ctx.db.query(`INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3 || ' hours')::interval)`, [
      sha256(token),
      row.id,
      String(conf.sessionHours),
    ]);
    await ctx.db.query('DELETE FROM sessions WHERE expires_at < now()');
    await ctx.audit(ctx.db, row, 'LOGIN', 'user', row.id);
    reply.header('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieAttrs(conf.sessionHours * 3600)}`);
    const org = (await ctx.db.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [row.org_id])).rows[0];
    return { id: row.id, name: row.name, role: row.role, org_id: row.org_id, orgName: org?.name };
  });

  ctx.app.post('/api/auth/logout', async (req, reply) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await ctx.db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
    reply.header('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttrs(0)}`);
    return { ok: true };
  });
}

/** Création ou mise à jour d'un compte (utilisée par le script CLI). */
export async function upsertUser(db: Db, u: { id: string; username: string; name: string; role: 'AGENT' | 'VET'; orgId: string; password: string }) {
  if (u.password.length < 12) throw new Error('Mot de passe trop court (12 caractères minimum)');
  const org = (await db.query('SELECT 1 FROM organizations WHERE id = $1', [u.orgId])).rows[0];
  if (!org) throw new Error(`Organisation inconnue : ${u.orgId}`);
  const hash = await hashPassword(u.password);
  await db.query(
    `INSERT INTO users(id, org_id, name, role, username, password_hash) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, username = EXCLUDED.username, password_hash = EXCLUDED.password_hash, disabled = false`,
    [u.id, u.orgId, u.name, u.role, u.username, hash],
  );
  await db.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
}
