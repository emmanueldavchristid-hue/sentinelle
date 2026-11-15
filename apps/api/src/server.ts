import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate, openDb } from './db.js';
import { resetAndSeed } from './seed.js';

const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
const applied = await migrate(db);
const empty = Number((await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM organizations')).rows[0]!.n) === 0;
if (empty) await resetAndSeed(db);

const app = await buildApp({ db, demoMode: config.demoMode, webDist: config.webDist, logger: false });
await app.listen({ port: config.port, host: config.host });
console.log(`Sentinelle — http://localhost:${config.port}`);
console.log(`  base : ${db.mode}${db.mode === 'pglite-file' ? ` (${config.dataDir})` : ''}${applied.length ? ` · migrations appliquées : ${applied.join(', ')}` : ''}${empty ? ' · jeu de démonstration chargé' : ''}`);
console.log(`  mode démonstration : ${config.demoMode ? 'activé (sélecteur de rôle, pas d’authentification sécurisée)' : 'désactivé'}`);

const stop = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
