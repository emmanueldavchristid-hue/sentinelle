import { type Db, openDb } from '../src/db.js';

/**
 * Base de test : PGlite en mémoire par défaut ; serveur PostgreSQL réel si TEST_DATABASE_URL est défini
 * (schéma public recréé, fichiers de test exécutés en série).
 */
export async function openTestDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return openDb({ dataDir: 'memory' });
  const db = await openDb({ databaseUrl: url });
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  return db;
}
