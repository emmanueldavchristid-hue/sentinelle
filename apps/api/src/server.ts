import { execSync } from 'node:child_process';
import { buildApp } from './app.js';
import { checkAssistantConfig, config, envFile, envFileLoaded } from './config.js';
import { geminiModel } from './gemini.js';
import { migrate, openDb } from './db.js';
import { resetAndSeed } from './seed.js';
import { llmFromConfig } from './llm.js';
import { checkAlertEmail, resendMailer } from './notify.js';

const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
const applied = await migrate(db);
const empty = Number((await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM organizations')).rows[0]!.n) === 0;
if (empty) await resetAndSeed(db, { living: true });

const llm = llmFromConfig({ provider: config.aiProvider, apiKey: config.aiApiKey, baseUrl: config.aiBaseUrl, model: config.aiModel });
if (config.aiProvider && !llm) console.warn(`  AI_PROVIDER=${config.aiProvider} incomplet (clé, AI_BASE_URL ou AI_MODEL manquant) : IA désactivée.`);
const assistantCheck = checkAssistantConfig();
/** Commit servi, suivi de « +modifs » si le dossier contient des changements non commités. Sans Git : « inconnue ». */
const version = (() => {
  try {
    const run = (cmd: string) => execSync(cmd, { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return `${run('git rev-parse --short HEAD')}${run('git status --porcelain --untracked-files=no') ? '+modifs' : ''}`;
  } catch {
    return 'inconnue';
  }
})();
const alertCheck = checkAlertEmail(config.alertEmail);
const app = await buildApp({
  baoule: config.baoule.enabled ? { url: config.baoule.url, examplesFile: config.baoule.examplesFile } : null,
  beaconReadCacheMs: config.beaconReadCacheMs,
  alertEmail: {
    notifier: alertCheck.ready ? { mailer: resendMailer({ apiKey: config.alertEmail.apiKey, from: config.alertEmail.from }), to: config.alertEmail.to, publicUrl: config.alertEmail.publicUrl } : null,
    reason: alertCheck.reason,
  },
  assistant: {
    model: assistantCheck.ready ? geminiModel({ apiKey: config.geminiApiKey, model: config.geminiModel, fallbackModel: config.geminiFallbackModel || undefined, ttsModel: config.geminiTtsModel || undefined, ttsVoice: config.geminiTtsVoice }) : null,
    disabledReason: assistantCheck.ready ? null : (assistantCheck.messages[0] ?? null),
    timeoutMs: config.assistantTimeoutMs,
    maxRequestsPerSession: config.assistantMaxRequestsPerSession,
    maxToolRounds: config.assistantMaxToolRounds,
    voiceMaxSeconds: config.voiceMaxSessionSeconds,
    live:
      assistantCheck.ready && config.geminiLiveModel
        ? { apiKey: config.geminiApiKey, model: config.geminiLiveModel, voice: config.geminiTtsVoice, maxSeconds: config.liveMaxSessionSeconds, idleSeconds: config.liveIdleSeconds, silenceMs: config.liveSilenceMs, maxTotalSeconds: config.liveMaxTotalSeconds }
        : null,
  },
  db,
  version,
  demoMode: config.demoMode,
  webDist: config.webDist,
  logger: false,
  auth: { secureCookie: config.secureCookie },
  llm,
  aiLimits: { timeoutMs: config.aiTimeoutMs, maxCallsPerDay: config.aiMaxCallsPerDay },
});
await app.listen({ port: config.port, host: config.host });
console.log(`Sentinelle — http://localhost:${config.port} (version ${version})`);
console.log(`  base : ${db.mode}${db.mode === 'pglite-file' ? ` (${config.dataDir})` : ''}${applied.length ? ` · migrations appliquées : ${applied.join(', ')}` : ''}${empty ? ' · jeu de démonstration chargé' : ''}`);
console.log(`  IA : ${llm ? `activée — ${llm.name}` : 'désactivée (aucun fournisseur configuré)'}`);
console.log(`  configuration : ${envFileLoaded ? `fichier ${envFile} chargé` : `aucun fichier .env (${envFile}), valeurs par défaut`}`);
for (const m of assistantCheck.messages) console.log(`  assistant : ${m}`);
console.log(`  conversation en direct : ${assistantCheck.ready && config.geminiLiveModel ? `modèle ${config.geminiLiveModel}, ${config.liveMaxSessionSeconds} s au plus` : 'indisponible (GEMINI_LIVE_MODEL non renseigné, ou assistant non configuré)'}`);
console.log(`  voix en baoulé : ${config.baoule.enabled ? `activée, service local de parole attendu sur ${config.baoule.url} (tools/baoule/serveur.py)` : 'désactivée (BAOULE_VOICE=on pour l’activer)'}`);
console.log(`  e-mail d’alerte : ${alertCheck.ready ? `activé (Resend), un message par épisode d’éloignement, lien vers ${config.alertEmail.publicUrl}` : `désactivé. ${alertCheck.reason}`}`);
console.log(`  mode démonstration : ${config.demoMode ? 'activé (sélecteur de rôle, pas d’authentification sécurisée)' : 'désactivé — connexion par identifiant et mot de passe'}`);

const stop = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
