import { buildApp } from './app.js';
import { checkAssistantConfig, config, envFile, envFileLoaded } from './config.js';
import { geminiModel } from './gemini.js';
import { migrate, openDb } from './db.js';
import { resetAndSeed } from './seed.js';
import { llmFromConfig } from './llm.js';

const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
const applied = await migrate(db);
const empty = Number((await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM organizations')).rows[0]!.n) === 0;
if (empty) await resetAndSeed(db, { living: true });

const llm = llmFromConfig({ provider: config.aiProvider, apiKey: config.aiApiKey, baseUrl: config.aiBaseUrl, model: config.aiModel });
if (config.aiProvider && !llm) console.warn(`  AI_PROVIDER=${config.aiProvider} incomplet (clé, AI_BASE_URL ou AI_MODEL manquant) : IA désactivée.`);
const assistantCheck = checkAssistantConfig();
const app = await buildApp({
  assistant: {
    model: assistantCheck.ready ? geminiModel({ apiKey: config.geminiApiKey, model: config.geminiModel, fallbackModel: config.geminiFallbackModel || undefined, ttsModel: config.geminiTtsModel || undefined, ttsVoice: config.geminiTtsVoice }) : null,
    disabledReason: assistantCheck.ready ? null : (assistantCheck.messages[0] ?? null),
    timeoutMs: config.assistantTimeoutMs,
    maxRequestsPerSession: config.assistantMaxRequestsPerSession,
    maxToolRounds: config.assistantMaxToolRounds,
    voiceMaxSeconds: config.voiceMaxSessionSeconds,
  },
  db,
  demoMode: config.demoMode,
  webDist: config.webDist,
  logger: false,
  auth: { secureCookie: config.secureCookie },
  llm,
  aiLimits: { timeoutMs: config.aiTimeoutMs, maxCallsPerDay: config.aiMaxCallsPerDay },
});
await app.listen({ port: config.port, host: config.host });
console.log(`Sentinelle — http://localhost:${config.port}`);
console.log(`  base : ${db.mode}${db.mode === 'pglite-file' ? ` (${config.dataDir})` : ''}${applied.length ? ` · migrations appliquées : ${applied.join(', ')}` : ''}${empty ? ' · jeu de démonstration chargé' : ''}`);
console.log(`  IA : ${llm ? `activée — ${llm.name}` : 'désactivée (aucun fournisseur configuré)'}`);
console.log(`  configuration : ${envFileLoaded ? `fichier ${envFile} chargé` : `aucun fichier .env (${envFile}), valeurs par défaut`}`);
for (const m of assistantCheck.messages) console.log(`  assistant : ${m}`);
console.log(`  mode démonstration : ${config.demoMode ? 'activé (sélecteur de rôle, pas d’authentification sécurisée)' : 'désactivé — connexion par identifiant et mot de passe'}`);

const stop = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
