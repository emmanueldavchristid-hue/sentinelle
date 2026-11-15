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
};
