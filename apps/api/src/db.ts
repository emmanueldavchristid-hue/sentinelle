import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Db extends Queryable {
  readonly mode: 'pglite-memory' | 'pglite-file' | 'postgres';
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Base par défaut : PostgreSQL embarqué (PGlite) — aucun service à installer (D-10).
 * Avec DATABASE_URL : serveur PostgreSQL (Docker Compose ou installation native).
 */
export async function openDb(opts: { databaseUrl?: string; dataDir?: string | 'memory' }): Promise<Db> {
  if (opts.databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 5 });
    return {
      mode: 'postgres',
      query: (sql, params) => pool.query(sql, params as unknown[]) as never,
      exec: async (sql) => {
        await pool.query(sql);
      },
      tx: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const r = await fn({ query: (s, p) => client.query(s, p as unknown[]) as never });
          await client.query('COMMIT');
          return r;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const memory = !opts.dataDir || opts.dataDir === 'memory';
  if (!memory) mkdirSync(opts.dataDir as string, { recursive: true });
  const pg = memory ? new PGlite() : new PGlite(opts.dataDir as string);
  await pg.waitReady;
  return {
    mode: memory ? 'pglite-memory' : 'pglite-file',
    query: (sql, params) => pg.query(sql, params) as never,
    exec: async (sql) => {
      await pg.exec(sql);
    },
    tx: (fn) => pg.transaction((t) => fn({ query: (s, p) => t.query(s, p) as never })),
    close: () => pg.close(),
  };
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Migrations SQL versionnées, appliquées une seule fois, dans l'ordre. */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  const applied: string[] = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await db.tx(async (q) => {
      for (const stmt of sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await q.query(stmt);
      await q.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}
