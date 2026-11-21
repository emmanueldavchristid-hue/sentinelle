import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { config } from './config.js';
import { migrate, openDb } from './db.js';
import { upsertUser } from './auth.js';
import { resetAndSeed } from './seed.js';

// Crée ou met à jour un compte pour le mode authentifié (DEMO_MODE=false).
// Exemple : pnpm user:create --id U-VET-1 --username dr.kone --name "Dr Koné" --role VET --org ORG-DEMO
// Le mot de passe est lu sur l'entrée standard (jamais en argument, pour ne pas apparaître dans l'historique).
const { values } = parseArgs({
  options: { id: { type: 'string' }, username: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, org: { type: 'string' } },
});
if (!values.id || !values.username || !values.name || !values.org || (values.role !== 'AGENT' && values.role !== 'VET' && values.role !== 'FARMER')) {
  console.error('Usage : pnpm user:create --id ID --username IDENTIFIANT --name "Nom" --role AGENT|VET|FARMER --org ORG-ID');
  process.exit(1);
}
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const password = (await rl.question(process.stdin.isTTY ? 'Mot de passe (12 caractères minimum, visible à la saisie) : ' : '')).trim();
rl.close();
const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
await migrate(db);
// Base neuve : même initialisation que le serveur (organisations et jeu synthétique).
if (Number((await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM organizations')).rows[0]!.n) === 0) await resetAndSeed(db);
try {
  await upsertUser(db, { id: values.id, username: values.username, name: values.name, role: values.role, orgId: values.org, password });
  console.log(`Compte ${values.username} (${values.role}, ${values.org}) enregistré.`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
