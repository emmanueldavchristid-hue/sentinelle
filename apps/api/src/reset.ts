import { config } from './config.js';
import { migrate, openDb } from './db.js';
import { resetAndSeed } from './seed.js';

// Réinitialisation DESTRUCTIVE des données de démonstration. Refusée hors mode démonstration.
if (!config.demoMode) {
  console.error('Refusé : DEMO_MODE n’est pas activé.');
  process.exit(1);
}
const withObservation = process.argv.includes('--avec-signalement');
const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
await migrate(db);
await resetAndSeed(db, { withObservation });
await db.close();
console.log(`Données de démonstration réinitialisées${withObservation ? ' (avec le signalement B-017 déjà synchronisé)' : ''}.`);
