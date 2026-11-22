import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E sur l'application compilée servie par l'API (un seul serveur, base en mémoire).
 * Navigateur : CHROME_PATH si défini (ex. /usr/bin/google-chrome), sinon Chrome installé (channel "chrome"),
 * sinon `npx playwright install chromium`.
 */
const executablePath = process.env.CHROME_PATH;
const PORT = Number(process.env.E2E_PORT ?? 3100);
/** Les tests historiques vérifient les libellés, sources et dates : ils tournent en affichage détaillé. simple.spec.ts couvre l'affichage simple. */
const DETAILED = { cookies: [], origins: [{ origin: `http://127.0.0.1:${PORT}`, localStorage: [{ name: 'sentinelle.affichage', value: 'detail' }] }] };

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    ...(executablePath ? { launchOptions: { executablePath, args: ['--no-sandbox'] } } : { channel: process.env.PW_CHANNEL || undefined }),
  },
  projects: [
    { name: 'desktop', testIgnore: /auth\.spec|capture\.spec|voix\.spec|direct(-question|-confirme|-incident)?\.spec|saisie-ia\.spec|baoule\.spec/, use: { ...devices['Desktop Chrome'], storageState: DETAILED, viewport: { width: 1440, height: 950 }, ...(executablePath ? { channel: undefined } : {}) } },
    // Dictée avec un faux microphone (fichier WAV de synthèse) et un vrai appel de transcription : seulement si VOIX=1.
    {
      name: 'voix',
      testMatch: /voix\.spec/,
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: {
          ...(executablePath ? { executablePath } : {}),
          args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve(dirname(fileURLToPath(import.meta.url)), 'e2e/fixtures/dictee-b017.wav')}%noloop`, ...(executablePath ? ['--no-sandbox'] : [])],
        },
        ...(executablePath ? { channel: undefined } : {}),
      },
    },
    // Conversation en direct avec un faux microphone et de vrais appels à l'API Live : seulement si DIRECT=1.
    {
      name: 'direct',
      testMatch: /direct\.spec/,
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: {
          ...(executablePath ? { executablePath } : {}),
          args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve(dirname(fileURLToPath(import.meta.url)), 'e2e/fixtures/dictee-b017.wav')}%noloop`, ...(executablePath ? ['--no-sandbox'] : [])],
        },
        ...(executablePath ? { channel: undefined } : {}),
      },
    },
    {
      name: 'direct-question',
      testMatch: /direct-question\.spec/,
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: {
          ...(executablePath ? { executablePath } : {}),
          args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve(dirname(fileURLToPath(import.meta.url)), 'e2e/fixtures/question-changements.wav')}%noloop`, ...(executablePath ? ['--no-sandbox'] : [])],
        },
        ...(executablePath ? { channel: undefined } : {}),
      },
    },
    {
      name: 'direct-confirme',
      testMatch: /direct-confirme\.spec/,
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: {
          ...(executablePath ? { executablePath } : {}),
          args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve(dirname(fileURLToPath(import.meta.url)), 'e2e/fixtures/dictee-puis-confirme.wav')}%noloop`, ...(executablePath ? ['--no-sandbox'] : [])],
        },
        ...(executablePath ? { channel: undefined } : {}),
      },
    },
    {
      name: 'direct-incident',
      testMatch: /direct-incident\.spec/,
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: {
          ...(executablePath ? { executablePath } : {}),
          args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve(dirname(fileURLToPath(import.meta.url)), 'e2e/fixtures/silence.wav')}%noloop`, ...(executablePath ? ['--no-sandbox'] : [])],
        },
        ...(executablePath ? { channel: undefined } : {}),
      },
    },
    // Note vocale en baoulé avec un faux microphone et le VRAI service local de parole (tools/baoule/serveur.py lancé) : seulement si BAOULE=1.
    {
      name: 'baoule',
      testMatch: /baoule\.spec/,
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: {
          ...(executablePath ? { executablePath } : {}),
          args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve(dirname(fileURLToPath(import.meta.url)), 'e2e/fixtures/question-baoule-nouveautes.wav')}%noloop`, ...(executablePath ? ['--no-sandbox'] : [])],
        },
        ...(executablePath ? { channel: undefined } : {}),
      },
    },
    // Aide à la saisie avec le vrai assistant IA (appel réel) : seulement si SAISIE_IA=1.
    { name: 'saisie-ia', testMatch: /saisie-ia\.spec/, use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 }, ...(executablePath ? { channel: undefined } : {}) } },
    // Capture réelle du parcours (vidéo) : ne s'exécute que si CAPTURE=1 (voir capture.spec.ts), sinon elle est ignorée.
    { name: 'capture', testMatch: /capture\.spec/, use: { ...devices['Desktop Chrome'], storageState: DETAILED, ...(executablePath ? { channel: undefined } : {}) } },
    // Mode authentifié (DEMO_MODE=false) : serveur distinct, compte créé par le script CLI. Commande shell POSIX : ignoré sous Windows.
    ...(process.platform === 'win32'
      ? []
      : [{ name: 'auth', testMatch: /auth\.spec/, use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${PORT + 1}`, ...(executablePath ? { channel: undefined } : {}) } }]),
  ],
  webServer: [
    {
      command: 'pnpm --filter @sentinelle/api start',
      url: `http://127.0.0.1:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      // ASSISTANT_AI=off : les tests ne dépendent jamais d'un service d'IA externe (lecture directe des données).
      // La conversation en direct n'est ouverte que pour direct.spec.ts : les autres parcours gardent la dictée.
      env: { PORT: String(PORT), DATA_DIR: 'memory', DEMO_MODE: 'true', ASSISTANT_AI: process.env.CAPTURE_AI === 'on' || process.env.VOIX === '1' || process.env.DIRECT === '1' || process.env.SAISIE_IA === '1' ? 'on' : 'off', ...(process.env.DIRECT === '1' ? {} : { GEMINI_LIVE_MODEL: '' }), BAOULE_VOICE: process.env.BAOULE === '1' ? 'on' : 'off' },
    },
    ...(process.platform === 'win32'
      ? []
      : [
          {
            command: `rm -rf /tmp/sentinelle-e2e-auth && printf 'mot-de-passe-e2e-2026\\n' | pnpm --silent --filter @sentinelle/api user:create --id U-VET --username dr.e2e --name "Vétérinaire E2E" --role VET --org ORG-DEMO && pnpm --filter @sentinelle/api start`,
            url: `http://127.0.0.1:${PORT + 1}/api/health`,
            reuseExistingServer: false,
            timeout: 90_000,
            env: { PORT: String(PORT + 1), DATA_DIR: '/tmp/sentinelle-e2e-auth', DEMO_MODE: 'false', ASSISTANT_AI: 'off' },
          },
        ]),
  ],
});
