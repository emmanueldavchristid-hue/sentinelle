import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';

/**
 * Sauvegarde / restauration de la base embarquée (PGlite).
 *   pnpm db:backup [chemin.tar.gz]
 *   pnpm db:restore chemin.tar.gz
 * ARRÊTER LE SERVEUR AVANT : la base embarquée ne doit être ouverte que par un seul processus.
 * Avec un serveur PostgreSQL (DATABASE_URL), utiliser pg_dump / pg_restore (voir docs/GUIDE.md).
 */
const [cmd, arg] = process.argv.slice(2);
if (config.databaseUrl) {
  console.error('DATABASE_URL est défini : utilisez pg_dump / pg_restore (voir docs/GUIDE.md, « Sauvegarde »).');
  process.exit(1);
}
const { PGlite } = await import('@electric-sql/pglite');
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);

if (cmd === 'backup') {
  if (!existsSync(config.dataDir) || readdirSync(config.dataDir).length === 0) {
    console.error(`Aucune base trouvée dans ${config.dataDir}.`);
    process.exit(1);
  }
  const out = resolve(arg ?? `backups/sentinelle-${stamp}.tar.gz`);
  const pg = new PGlite(config.dataDir);
  await pg.waitReady;
  const n = (await pg.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM record_revisions')).rows[0]?.n ?? 0;
  const dump = await pg.dumpDataDir('gzip');
  await pg.close();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(await dump.arrayBuffer()));
  console.log(`Sauvegarde écrite : ${out} (${n} révisions d’enregistrements).`);
} else if (cmd === 'restore') {
  if (!arg || !existsSync(arg)) {
    console.error('Usage : pnpm db:restore chemin/vers/sauvegarde.tar.gz');
    process.exit(1);
  }
  // Non destructif : la base actuelle est déplacée à côté, jamais supprimée.
  if (existsSync(config.dataDir) && readdirSync(config.dataDir).length > 0) {
    const aside = `${config.dataDir}.avant-restauration-${stamp}`;
    renameSync(config.dataDir, aside);
    console.log(`Base actuelle conservée dans : ${aside}`);
  }
  mkdirSync(config.dataDir, { recursive: true });
  const blob = new Blob([readFileSync(arg)]);
  const pg = new PGlite(config.dataDir, { loadDataDir: blob });
  await pg.waitReady;
  const n = (await pg.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM record_revisions')).rows[0]?.n ?? 0;
  await pg.close();
  console.log(`Base restaurée dans ${config.dataDir} (${n} révisions d’enregistrements).`);
} else {
  console.error('Commandes : backup [fichier] | restore fichier');
  process.exit(1);
}
