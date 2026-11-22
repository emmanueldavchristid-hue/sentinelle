import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Fichier local NON versionné `sentinelle/.env` (voir `.env.example`) : chargé s'il existe.
 * Les variables déjà définies dans l'environnement gardent la priorité. Aucune valeur n'est jamais journalisée.
 */
export const envFile = resolve(root, '.env');
export const envFileLoaded = (() => {
  if (!existsSync(envFile)) return false;
  try {
    process.loadEnvFile(envFile);
    return true;
  } catch {
    console.warn('  Fichier .env illisible : ignoré. Vérifiez sa syntaxe (NOM=valeur, une variable par ligne).');
    return false;
  }
})();

const int = (v: string | undefined, def: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : def;
};

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
  aiApiKey: process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || '',
  aiBaseUrl: process.env.AI_BASE_URL ?? '',
  aiModel: process.env.AI_MODEL ?? '',
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 15000),
  aiMaxCallsPerDay: Number(process.env.AI_MAX_CALLS_PER_DAY ?? 100),
  // Assistant conversationnel (SENTINELLE VIVANT) : Gemini, clé côté serveur uniquement.
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  /** Une seule des deux variables doit exister : les outils Google donnent la priorité à GOOGLE_API_KEY. */
  googleApiKeyAlsoSet: !!process.env.GOOGLE_API_KEY,
  geminiModel: (process.env.GEMINI_MODEL ?? '').trim(),
  /** ASSISTANT_AI=off : coupe l'assistant IA sans retirer la clé (secours de démonstration, lecture directe des données). */
  assistantOff: (process.env.ASSISTANT_AI ?? '').trim().toLowerCase() === 'off',
  /** Modèle de secours si le modèle principal est surchargé (503). Facultatif. */
  geminiFallbackModel: (process.env.GEMINI_FALLBACK_MODEL ?? '').trim(),
  /** Modèle de synthèse vocale pour les réponses parlées. Vide : la voix de synthèse de l'appareil est utilisée à la place. */
  geminiTtsModel: (process.env.GEMINI_TTS_MODEL ?? '').trim(),
  /** Voix préconstruite du modèle de synthèse (par exemple Kore). */
  geminiTtsVoice: (process.env.GEMINI_TTS_VOICE ?? '').trim() || 'Kore',
  /** Modèle de conversation en direct (API Live), par exemple gemini-3.8-live. Vide = conversation en direct indisponible. */
  geminiLiveModel: (process.env.GEMINI_LIVE_MODEL ?? '').trim(),
  /** Durée maximale d'une conversation en direct, silence qui la ferme, et silence qui marque la fin d'une prise de parole. */
  liveMaxSessionSeconds: int(process.env.LIVE_MAX_SESSION_SECONDS, 300, 30, 540),
  liveIdleSeconds: int(process.env.LIVE_IDLE_SECONDS, 30, 10, 120),
  liveSilenceMs: int(process.env.LIVE_SILENCE_MS, 700, 300, 2000),
  /** Durée cumulée des conversations en direct depuis le démarrage du serveur : borne la dépense, même si le lien public circule. */
  liveMaxTotalSeconds: int(process.env.LIVE_MAX_TOTAL_SECONDS, 3600, 60, 86_400),
  /**
   * E-mail d'alerte d'éloignement : désactivé par défaut. Il faut ALERT_EMAIL=on, la clé du fournisseur, le destinataire de test
   * (une seule adresse, fixée ici et nulle part ailleurs) et l'adresse publique de l'application pour le lien du message.
   */
  /**
   * Voix en baoulé : désactivée par défaut. BAOULE_VOICE=on suppose que le service local de parole est lancé
   * (tools/baoule/serveur.py, modèles ouverts téléchargés dans data/baoule : voir docs/BAOULE.md).
   */
  baoule: {
    enabled: (process.env.BAOULE_VOICE ?? '').trim().toLowerCase() === 'on',
    url: (process.env.BAOULE_URL ?? '').trim().replace(/\/+$/, '') || 'http://127.0.0.1:8765',
    examplesFile: resolve(root, 'data/baoule/exemples.json'),
  },
  alertEmail: {
    enabled: (process.env.ALERT_EMAIL ?? '').trim().toLowerCase() === 'on',
    provider: (process.env.ALERT_EMAIL_PROVIDER ?? '').trim().toLowerCase() || 'resend',
    apiKey: (process.env.RESEND_API_KEY ?? '').trim(),
    to: (process.env.ALERT_EMAIL_TO ?? '').trim(),
    from: (process.env.ALERT_EMAIL_FROM ?? '').trim() || 'Sentinelle (démonstration) <onboarding@resend.dev>',
    publicUrl: (process.env.PUBLIC_URL ?? '').trim().replace(/\/+$/, ''),
  },
  assistantTimeoutMs: int(process.env.ASSISTANT_TIMEOUT_MS, 20_000, 2_000, 120_000),
  assistantMaxRequestsPerSession: int(process.env.ASSISTANT_MAX_REQUESTS_PER_SESSION, 40, 1, 1000),
  assistantMaxToolRounds: int(process.env.ASSISTANT_MAX_TOOL_ROUNDS, 4, 1, 8),
  /** Durée maximale d'une dictée (un enregistrement court, transcrit puis jeté). */
  voiceMaxSessionSeconds: int(process.env.VOICE_MAX_SESSION_SECONDS, 30, 5, 60),
};

export interface AssistantConfigReport {
  /** L'assistant IA peut-il être appelé ? */
  ready: boolean;
  /** Messages lisibles, sans aucune valeur secrète. */
  messages: string[];
}

/** Validation de la configuration de l'assistant au démarrage. Ne renvoie ni n'affiche jamais la valeur d'une clé. */
export function checkAssistantConfig(c: Pick<typeof config, 'geminiApiKey' | 'googleApiKeyAlsoSet' | 'geminiModel'> & { assistantOff?: boolean } = config): AssistantConfigReport {
  const messages: string[] = [];
  if (c.assistantOff) return { ready: false, messages: ['Assistant IA coupé par ASSISTANT_AI=off : lecture directe des données et saisie manuelle uniquement.'] };
  if (!c.geminiApiKey) {
    messages.push(`GEMINI_API_KEY absente : l’assistant IA est désactivé. L’application reste entièrement utilisable (lecture directe des données et saisie manuelle).`);
    messages.push(`Pour l’activer : créez la clé dans Google AI Studio, puis écrivez GEMINI_API_KEY=… dans ${envFile} (fichier local, exclu de Git). Ne la collez nulle part ailleurs.`);
    return { ready: false, messages };
  }
  if (/\s/.test(c.geminiApiKey) || c.geminiApiKey.length < 20) {
    messages.push('GEMINI_API_KEY a une forme inattendue (trop courte ou contenant des espaces) : l’assistant IA est désactivé. Vérifiez la ligne dans le fichier .env.');
    return { ready: false, messages };
  }
  if (c.googleApiKeyAlsoSet) messages.push('GOOGLE_API_KEY est aussi définie sur cette machine : les outils Google lui donnent la priorité. Ce serveur n’utilise que GEMINI_API_KEY ; supprimez l’autre pour éviter toute confusion.');
  if (!c.geminiModel) {
    messages.push('GEMINI_MODEL absent : lancez « pnpm assistant:check » pour lister les modèles réellement disponibles avec cette clé, puis renseignez GEMINI_MODEL dans le fichier .env. Assistant IA désactivé en attendant.');
    return { ready: false, messages };
  }
  messages.push(`Assistant IA : clé présente, modèle ${c.geminiModel}. Connexion non vérifiée au démarrage (lancez « pnpm assistant:check »).`);
  return { ready: true, messages };
}
