import { expect, test } from '@playwright/test';

/**
 * Dictée de bout en bout, avec un VRAI appel de transcription (assistant IA du fichier .env) et un FAUX microphone :
 * Chrome lit le fichier e2e/fixtures/dictee-b017.wav (voix de synthèse française, aucune voix réelle) à la place du micro.
 * À la demande uniquement, car le test dépend d'un service externe :
 *
 *   VOIX=1 PW_CHANNEL=chrome pnpm --filter @sentinelle/web exec playwright test --project=voix
 *   PowerShell : $env:VOIX="1"; $env:PW_CHANNEL="chrome"; pnpm --filter @sentinelle/web exec playwright test --project=voix
 */
test.skip(process.env.VOIX !== '1', 'Test de dictée à la demande : définir VOIX=1 (appel réel à l’assistant IA)');
test.setTimeout(120_000);

test('dictée : micro signalé, transcription relue, puis brouillon d’observation comme en texte', async ({ page }) => {
  expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } })).ok()).toBeTruthy();
  await page.goto('/');
  const talk = page.getByRole('complementary', { name: 'Parler à mon élevage' });
  await expect(talk).toContainText('Assistant IA connecté');
  const input = page.getByLabel('Votre question ou votre observation');

  // Annulation : le micro s'ouvre, se signale, puis rien n'est envoyé.
  await talk.getByRole('button', { name: 'Dicter' }).click();
  await expect(talk.getByText('Microphone actif.')).toBeVisible();
  await talk.getByRole('button', { name: 'Annuler' }).click();
  await expect(talk.getByText('Enregistrement annulé. Rien n’a été envoyé.')).toBeVisible();
  await expect(input).toHaveValue('');

  // Dictée complète : la phrase du fichier dure environ 6 secondes.
  await talk.getByRole('button', { name: 'Dicter' }).click();
  await expect(talk.getByText('Microphone actif.')).toBeVisible();
  await page.waitForTimeout(7000);
  await talk.getByRole('button', { name: 'Arrêter et transcrire' }).click();
  await expect(input).toHaveValue(/B[\s-]?0?17/i, { timeout: 60_000 });
  await expect(input).toHaveValue(/mange moins/i);
  await expect(talk.getByText('Texte dicté, transcrit automatiquement.')).toBeVisible();
  await expect(talk.getByText('Microphone actif.')).toHaveCount(0);

  // Le texte dicté suit exactement le parcours du texte tapé : brouillon, jamais d'enregistrement direct.
  // La réponse est aussi dite : le serveur renvoie un vrai son (synthèse vocale), annoncé comme une voix de synthèse.
  const speech = page.waitForResponse((r) => r.url().endsWith('/api/assistant/speak'), { timeout: 90_000 });
  await page.getByRole('button', { name: 'Demander' }).click();
  const sound = await speech;
  expect(sound.status()).toBe(200);
  expect(sound.headers()['content-type']).toContain('audio/wav');
  expect(Number(sound.headers()['content-length'])).toBeGreaterThan(20_000);
  await expect(talk.getByText('Voix de synthèse (Gemini). Elle lit le texte affiché, sans rien ajouter.')).toBeVisible({ timeout: 30_000 });
  const draft = talk.getByRole('form', { name: 'Vérifiez, puis confirmez' });
  await expect(draft).toBeVisible({ timeout: 60_000 });
  await expect(draft.getByLabel('Animal')).toHaveValue('B-017');
  await expect(draft.getByLabel('Ce qui est constaté')).toHaveValue(/mange moins/i);
  const count = (await (await page.request.get('/api/farm/changes', { headers: { 'x-demo-user': 'U-ELEVEUR' } })).json()).data.counts.total;
  expect(count).toBe(5);
  await page.screenshot({ path: 'test-results/voix-brouillon.png', fullPage: false });
});
