import { parseArgs } from 'node:util';
import { config } from './config.js';
import { migrate, openDb } from './db.js';

// Gestion des comptes (mode authentifié) :
//   pnpm user:list
//   pnpm user:disable --username IDENTIFIANT   (révoque aussi les sessions)
//   pnpm user:enable --username IDENTIFIANT
const [cmd, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { username: { type: 'string' } } });
const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
await migrate(db);
try {
  if (cmd === 'list') {
    const rows = (
      await db.query<{ id: string; username: string | null; name: string; role: string; org_id: string; disabled: boolean; has_password: boolean }>(
        'SELECT id, username, name, role, org_id, disabled, password_hash IS NOT NULL AS has_password FROM users ORDER BY org_id, role, id',
      )
    ).rows;
    console.table(rows.map((r) => ({ id: r.id, identifiant: r.username ?? '—', nom: r.name, rôle: r.role, organisation: r.org_id, actif: !r.disabled, 'mot de passe': r.has_password ? 'oui' : 'non (démo)' })));
  } else if ((cmd === 'disable' || cmd === 'enable') && values.username) {
    const r = await db.query<{ id: string }>('UPDATE users SET disabled = $1 WHERE lower(username) = lower($2) RETURNING id', [cmd === 'disable', values.username]);
    if (!r.rows[0]) throw new Error(`Compte introuvable : ${values.username}`);
    if (cmd === 'disable') await db.query('DELETE FROM sessions WHERE user_id = $1', [r.rows[0].id]);
    console.log(`Compte ${values.username} ${cmd === 'disable' ? 'désactivé (sessions révoquées)' : 'réactivé'}.`);
  } else {
    console.error('Usage : pnpm user:list | pnpm user:disable --username X | pnpm user:enable --username X');
    process.exitCode = 1;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
