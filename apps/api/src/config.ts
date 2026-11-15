import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Configuration par variables d'environnement, sans secret par défaut. */
export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl: process.env.DATABASE_URL || undefined,
  dataDir: process.env.DATA_DIR ?? resolve(root, 'data/pglite'),
  demoMode: (process.env.DEMO_MODE ?? 'true') === 'true',
  webDist: process.env.WEB_DIST ?? resolve(root, 'apps/web/dist'),
  secureCookie: process.env.COOKIE_SECURE === 'true',
  aiProvider: process.env.AI_PROVIDER ?? '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  aiModel: process.env.AI_MODEL ?? 'claude-haiku-5-5',
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 10000),
  aiMaxCallsPerDay: Number(process.env.AI_MAX_CALLS_PER_DAY ?? 100),
};
