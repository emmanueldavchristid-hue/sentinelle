import { expect, test, type Page } from '@playwright/test';
import type { AssistantStatus, BaouleReply, ChangesData, SituationData, ToolResult } from '@sentinelle/contracts';

/**
 * Voix en baoulé dans le navigateur, contre un FAUX service de parole (e2e/faux-parole.mjs : aucun modèle, il « entend » le
 * texte qu'on lui règle et « dit » une note de test) et un FAUX microphone (Chrome joue e2e/fixtures/dictee-b017.wav).
 *
 *   BAOULE=faux CHROME_PATH=/usr/bin/google-chrome pnpm --filter @sentinelle/web exec playwright test --project=baoule-faux --trace off
 *
 * Ce que ce test vérifie : l'écran (ce qui a été entendu, la question retenue, le texte dit et son sens), la réponse en
 * deux temps (les faits avant la voix), le son réellement joué par le navigateur, les questions au toucher, les réponses
 * dites en baoulé pour une question posée en français, et les cas d'échec (non reconnu, silence, voix en panne).
 * Ce qu'il ne vérifie pas : la justesse du baoulé, la qualité et la vitesse des vrais modèles, un vrai téléphone.
 */
test.skip(process.env.BAOULE !== 'faux', 'Test de la voix en baoulé contre un faux service de parole : définir BAOULE=faux');
test.setTimeout(120_000);
test.use({ storageState: { cookies: [], origins: [] } });

const SPEECH = `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 3100) + 7}`;
const FARMER = { 'x-demo-user': 'U-ELEVEUR' };
const NUMBERS = ['', 'kun', 'nnyɔn', 'nsan', 'nnan', 'nnun', 'nsiɛn', 'nso', 'mɔcuɛ', 'ngwlan'];

async function open(page: Page, control: Record<string, unknown> = {}) {
  expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } })).ok()).toBeTruthy();
  await page.request.post(`${SPEECH}/controle`, { data: { hears: 'ngue like uflɛ yɛ ɔ juli', silence: false, sttDelayMs: 0, ttsDelayMs: 0, ttsFails: false, reset: true, ...control } });
  // Le serveur relit l'état du service de parole toutes les 15 secondes : on attend qu'il l'ait vu.
  await expect.poll(async () => ((await (await page.request.get('/api/assistant/status', { headers: FARMER })).json()) as AssistantStatus).voice?.baoule?.available, { timeout: 40_000 }).toBe(true);
  await page.goto('/');
  const zone = page.getByRole('complementary', { name: 'Parler à mon élevage' }).getByRole('region', { name: /Parler en baoulé/ });
  await expect(zone).toBeVisible();
  return zone;
}
const said = async (page: Page) => ((await (await page.request.get(`${SPEECH}/dit`)).json()) as { said: string[]; warmed: string[] });

test('baoulé : question touchée, réponse lue dans les données puis dite ; la voix du moment a été préparée d’avance', async ({ page }) => {
  const zone = await open(page);
  // L'interface reste en français, et les limites de cette voix sont toujours écrites.
  await expect(page.getByRole('heading', { level: 1, name: 'Mon élevage aujourd’hui' })).toBeVisible();
  await expect(zone.getByRole('note', { name: 'Limites de la voix en baoulé' })).toContainText('premier jet, pas encore validé par un locuteur');
  await expect(zone.getByRole('note', { name: 'Limites de la voix en baoulé' })).toContainText('la réponse écrite, en français, fait foi');

  const truth = ((await (await page.request.get('/api/farm/situation', { headers: FARMER })).json()) as ToolResult<SituationData>).data;
  expect(truth.animals.total).toBeGreaterThan(0);
  expect(truth.animals.total).toBeLessThan(10);
  const animals = `Be klɛli nnɛn ${NUMBERS[truth.animals.total]}.`;
  // À l'ouverture de l'écran, la phrase de la réponse du moment a déjà été donnée à la voix pour préparation.
  await expect.poll(async () => (await said(page)).warmed.some((t) => t.includes(animals))).toBe(true);
  expect((await said(page)).said).toEqual([]);

  const answered = page.waitForResponse((r) => r.url().endsWith('/api/assistant/baoule/question'));
  await zone.getByRole('button', { name: /Mon élevage/ }).click();
  const r = (await (await answered).json()) as BaouleReply;
  // Deux temps : la réponse écrite ne porte pas le son, seulement de quoi le récupérer.
  expect(r).toMatchObject({ intent: 'situation', via: 'choice', audio: null });
  expect(r.voiceId).toBeTruthy();
  expect(r.spoken).toContain(animals);
  expect(r.spoken).not.toMatch(/\d/);

  const last = zone.getByRole('status', { name: 'Dernière réponse en baoulé' });
  await expect(last).toContainText('Question choisie : Quelle est la situation de mon élevage ?');
  await expect(last).toContainText(`« ${r.spoken} »`);
  await expect(last).toContainText(`${truth.animals.total} animaux sont enregistrés.`);
  // Le son est réellement joué par le navigateur, puis se termine.
  await expect(last.locator('[data-voice="playing"]')).toBeVisible();
  await expect(last.getByRole('button', { name: '■ Arrêter' })).toBeVisible();
  await expect(last.locator('[data-voice]')).toHaveCount(0, { timeout: 10_000 });
  await expect(last.getByRole('button', { name: /Réécouter la réponse en baoulé/ })).toBeVisible();
  expect((await said(page)).said).toEqual([r.spoken]);

  // Les faits ont rejoint la conversation, en français, avec leurs preuves.
  const exchange = page.getByRole('complementary', { name: 'Parler à mon élevage' }).getByRole('article').first();
  await expect(exchange).toContainText('Question choisie, réponse dite en baoulé');
  await expect(exchange).toContainText(`${truth.animals.total} animaux`);

  // Réécouter ne redemande rien au service de parole.
  await last.getByRole('button', { name: /Réécouter la réponse en baoulé/ }).click();
  await expect(last.locator('[data-voice="playing"]')).toBeVisible();
  expect((await said(page)).said).toEqual([r.spoken]);
  await page.screenshot({ path: 'test-results/baoule-question-touchee.png', fullPage: false });
});

test('baoulé : note vocale, ce qui a été entendu s’affiche avant la voix, puis la réponse est dite', async ({ page }) => {
  // La voix met volontairement deux secondes : l'écran ne doit pas l'attendre pour montrer l'écoute et les faits.
  const zone = await open(page, { ttsDelayMs: 2000 });
  const total = ((await (await page.request.get('/api/farm/changes', { headers: FARMER })).json()) as ToolResult<ChangesData>).data.counts.total;
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/assistant/baoule'), { timeout: 60_000 });
  await zone.getByRole('button', { name: 'Parler en baoulé' }).click();
  await expect(zone.getByText('Microphone actif.')).toBeVisible({ timeout: 15_000 });
  const r = (await (await answered).json()) as BaouleReply;
  expect(r).toMatchObject({ heard: 'ngue like uflɛ yɛ ɔ juli', intent: 'changes', via: 'voice', audio: null, question: 'Qu’est-ce qui a changé depuis hier ?' });

  const last = zone.getByRole('status', { name: 'Dernière réponse en baoulé' });
  await expect(last).toContainText('Entendu (transcription automatique) : « ngue like uflɛ yɛ ɔ juli »');
  await expect(last).toContainText('Question retenue : Qu’est-ce qui a changé depuis hier ?');
  await expect(last).toContainText(total > 0 ? `${total} nouvelles choses` : 'rien de nouveau');
  // Pendant que la voix se prépare, l'écran le dit ; il ne prétend pas qu'elle parle déjà.
  await expect(last.locator('[data-voice="loading"]')).toHaveText('La voix se prépare…');
  await expect(last.locator('[data-voice="playing"]')).toBeVisible({ timeout: 10_000 });
  expect((await said(page)).said).toEqual([r.spoken]);
  await expect(page.getByRole('complementary', { name: 'Parler à mon élevage' }).getByRole('article').first()).toContainText('Note vocale en baoulé (transcription automatique)');
});

test('baoulé : question non reconnue, rien n’est deviné, les questions à toucher sont proposées ; voix en panne, c’est dit', async ({ page }) => {
  const zone = await open(page, { hears: 'like nga nzowa seli kɛ ɔ yo min i' });
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/assistant/baoule'), { timeout: 60_000 });
  await zone.getByRole('button', { name: 'Parler en baoulé' }).click();
  const r = (await (await answered).json()) as BaouleReply;
  expect(r.intent).toBe('unknown');
  expect(r.reply.results).toEqual([]);
  const last = zone.getByRole('status', { name: 'Dernière réponse en baoulé' });
  await expect(last).toContainText('Question non reconnue : aucune donnée lue, rien n’est deviné.');
  await expect(last).toContainText('Je n’ai pas compris. Répétez, s’il vous plaît.');
  await expect(zone.getByText('Question non reconnue. Touchez-en une : la réponse est dite en baoulé.')).toBeVisible();
  await expect(last.locator('[data-voice="playing"]')).toBeVisible();

  // La voix tombe en panne : la réponse écrite reste entière, et l'écran dit que rien n'a été dit.
  await page.request.post(`${SPEECH}/controle`, { data: { ttsFails: true } });
  await zone.getByRole('button', { name: /Ce qui manque/ }).click();
  await expect(last).toContainText('Question choisie : Quelles informations manquent ?');
  await expect(last.locator('[data-voice="failed"]')).toContainText('La voix a échoué : rien n’a été dit.');
  await expect(last).toContainText('Texte prévu, non dit :');
  await expect(page.getByRole('complementary', { name: 'Parler à mon élevage' }).getByRole('article').first()).toContainText('Question choisie, réponse dite en baoulé');
});

test('baoulé : « Réponses à voix haute en baoulé » fait dire en baoulé la réponse à une question posée en français', async ({ page }) => {
  const zone = await open(page);
  const total = ((await (await page.request.get('/api/farm/changes', { headers: FARMER })).json()) as ToolResult<ChangesData>).data.counts.total;
  const ask = async (text: string) => {
    await page.getByLabel('Votre question ou votre observation').fill(text);
    await page.keyboard.press('Enter');
  };
  // Désactivé par défaut : la question en français ne demande rien à la voix baoulé.
  await ask('Qu’est-ce qui a changé depuis hier ?');
  const talk = page.getByRole('complementary', { name: 'Parler à mon élevage' });
  await expect(talk.getByRole('article').first()).toContainText('Depuis hier');
  await page.waitForTimeout(800);
  expect((await said(page)).said).toEqual([]);

  await zone.getByRole('button', { name: 'Réponses à voix haute en baoulé : non' }).click();
  await expect(zone.getByRole('button', { name: 'Réponses à voix haute en baoulé : oui' })).toBeVisible();
  await ask('Qu’est-ce qui a changé depuis hier ?');
  await expect.poll(async () => (await said(page)).said.length, { timeout: 15_000 }).toBe(1);
  const spoken = (await said(page)).said[0]!;
  expect(spoken).toContain(total > 0 ? 'Kɛ ɔ fin anuman, be klɛli like uflɛ' : 'be klɛman like uflɛ fi');
  expect(spoken).not.toMatch(/\d/);

  // Le choix est gardé sur l'appareil.
  await page.reload();
  await expect(page.getByRole('complementary', { name: 'Parler à mon élevage' }).getByRole('button', { name: 'Réponses à voix haute en baoulé : oui' })).toBeVisible({ timeout: 20_000 });
});
