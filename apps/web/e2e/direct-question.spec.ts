import { expect, test } from '@playwright/test';

/**
 * Conversation en direct, de bout en bout, avec de VRAIS appels à l'API Live (modèle de `GEMINI_LIVE_MODEL` dans .env) et un
 * FAUX microphone : Chrome joue une fois e2e/fixtures/question-changements.wav (« Qu'est-ce qui a changé depuis hier ? »,
 * voix de synthèse, aucune voix réelle). Ce test ne vaut donc pas essai avec une voix humaine.
 * À la demande uniquement, car il dépend d'un service externe :
 *
 *   DIRECT=1 PW_CHANNEL=chrome pnpm --filter @sentinelle/web exec playwright test --project=direct-question
 *   PowerShell : $env:DIRECT="1"; $env:PW_CHANNEL="chrome"; pnpm --filter @sentinelle/web exec playwright test --project=direct-question
 */
test.skip(process.env.DIRECT !== '1' || process.env.GEMINI_LIVE_MODEL === 'modele-inexistant', 'Conversation en direct à la demande : définir DIRECT=1 (appels réels à l’API Live)');
test.setTimeout(150_000);

/** Fin de la parole dans le fichier joué par le faux micro, en secondes depuis son début. */
const SPEECH_ENDS_AT = 2.72;
const WORDS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze'];

test('direct : une question parlée, une réponse à la voix fondée sur une lecture réelle des données', async ({ page }) => {
  expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } })).ok()).toBeTruthy();
  const got: { type: string; [k: string]: unknown }[] = [];
  let audioIn = 0;
  let micOut = 0;
  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/api/assistant/live')) return;
    ws.on('framereceived', (f) => (typeof f.payload === 'string' ? got.push(JSON.parse(f.payload)) : (audioIn += f.payload.length)));
    ws.on('framesent', (f) => typeof f.payload !== 'string' && (micOut += f.payload.length));
  });
  await page.goto('/');
  const talk = page.getByRole('complementary', { name: 'Parler à mon élevage' });

  // 3 à 5. Un appui : la session s'ouvre, le micro est capté et signalé, le son part vers le serveur.
  await talk.getByRole('button', { name: 'Parler' }).click();
  await expect(talk.getByText('Microphone actif.')).toBeVisible({ timeout: 20_000 });
  await expect(talk.getByText('Je vous écoute')).toBeVisible();
  await expect.poll(() => micOut, { timeout: 10_000 }).toBeGreaterThan(16_000);

  // 7. Le modèle a compris la question et appelé une vraie fonction de lecture.
  const first = talk.getByRole('article').first();
  await expect(first).toContainText(/chang/i, { timeout: 40_000 });
  await expect.poll(() => got.some((m) => m.type === 'result'), { timeout: 40_000 }).toBe(true);
  const result = got.find((m) => m.type === 'result')!.result as { tool: string; data: { counts: { total: number } }; sources: unknown[] };
  expect(result.tool).toBe('changes');
  expect(result.sources.length).toBeGreaterThan(0);

  // 6. La voix du modèle est reçue et jouée.
  await expect.poll(() => audioIn, { timeout: 40_000 }).toBeGreaterThan(40_000);
  await expect.poll(() => got.some((m) => m.type === 'turn_complete' && got.some((x) => x.type === 'said')), { timeout: 60_000 }).toBe(true);

  // 8. La réponse dite reprend le chiffre de la lecture (en chiffres ou en lettres).
  const said = got
    .filter((m) => m.type === 'said')
    .map((m) => m.text)
    .join('');
  const total = result.data.counts.total;
  expect(said, `réponse dite : « ${said} »`).toMatch(new RegExp(`\\b(${total}|${WORDS[total] ?? total})\\b`, 'i'));
  expect(said).not.toMatch(/\[(?:OBS|REC|TASK|ANIMAL|SITE):/);

  // L'écran montre la transcription de ce qui a été dit, la présente comme telle, et donne accès aux preuves.
  await expect(first).toContainText('Dit en direct par l’IA (transcription automatique)');
  await first.locator('summary').first().click();
  await expect(first).toContainText('il n’a pas été contrôlé avant d’être entendu');
  await expect(first.locator('.v-src').first()).toBeVisible();

  // Mesure dans le navigateur : du dernier mot du fichier joué par le faux micro au début de la lecture du premier son.
  const marks = await page.evaluate(() => performance.getEntriesByType('mark').filter((m) => m.name.startsWith('sentinelle-live')).map((m) => ({ name: m.name, at: Math.round(m.startTime) })));
  const mic = marks.find((m) => m.name === 'sentinelle-live-micro')!.at;
  const listening = marks.find((m) => m.name === 'sentinelle-live-ecoute')!.at;
  const sound = marks.find((m) => m.name === 'sentinelle-live-son')!.at;
  console.log(`[dit] « ${said.trim()} »`);
  console.log(`[mesure] ouverture de la conversation : ${listening - mic} ms après le micro ; premier son : ${Math.round(sound - (mic + SPEECH_ENDS_AT * 1000))} ms après la fin de la phrase (faux micro, valeur approchée)`);

  // Après la réponse, l'écoute reprend d'elle-même ; un appui ferme la conversation et l'écran le dit.
  await expect(talk.getByText('Je vous écoute')).toBeVisible({ timeout: 40_000 });
  await talk.getByRole('button', { name: 'Arrêter la conversation' }).click();
  await expect(talk.getByText('Conversation arrêtée. Le micro est fermé.')).toBeVisible();
  await expect(talk.getByText('Microphone actif.')).toHaveCount(0);
});
