import { expect, test } from '@playwright/test';

/**
 * Parcours à la voix, de bout en bout, avec de VRAIS appels (transcription et synthèse vocale du fichier .env) et un FAUX
 * microphone : Chrome joue une fois le fichier e2e/fixtures/dictee-b017.wav (voix de synthèse française, aucune voix réelle).
 * À la demande uniquement, car le test dépend d'un service externe :
 *
 *   VOIX=1 PW_CHANNEL=chrome pnpm --filter @sentinelle/web exec playwright test --project=voix
 *   PowerShell : $env:VOIX="1"; $env:PW_CHANNEL="chrome"; pnpm --filter @sentinelle/web exec playwright test --project=voix
 */
test.skip(process.env.VOIX !== '1', 'Test de voix à la demande : définir VOIX=1 (appels réels à l’assistant IA)');
test.setTimeout(150_000);

test('voix : un appui sur le micro, la phrase s’arrête d’elle-même, la réponse est dite, « je confirme » enregistre', async ({ page }) => {
  expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } })).ok()).toBeTruthy();
  await page.goto('/');
  const talk = page.getByRole('complementary', { name: 'Parler à mon élevage' });
  const count = async () => (await (await page.request.get('/api/farm/changes', { headers: { 'x-demo-user': 'U-ELEVEUR' } })).json()).data.counts.total as number;

  // Un seul appui : le micro s'ouvre, se signale, et se referme quand la phrase est finie (aucun bouton « arrêter » à trouver).
  const speech = page.waitForResponse((r) => r.url().endsWith('/api/assistant/speak'), { timeout: 120_000 });
  // Ici par le mode discussion, qui ouvre le micro lui-même (le bouton « Parler » déclenche exactement la même écoute).
  await expect(talk.getByRole('button', { name: 'Parler' })).toBeEnabled();
  await talk.getByRole('button', { name: 'Discussion : non' }).click();
  await expect(talk.getByText('Discussion en cours')).toBeVisible();
  await expect(talk.getByText('Microphone actif.')).toBeVisible({ timeout: 15_000 });
  await expect(talk.getByText('Je vous écoute')).toBeVisible();

  // La phrase transcrite devient la question, sans relecture ni bouton à presser.
  const first = talk.getByRole('article').first();
  await expect(first).toContainText(/B[\s-]?0?17/i, { timeout: 90_000 });
  await expect(first).toContainText(/mange moins/i);
  await expect(talk.getByText('Microphone actif.')).toHaveCount(0);

  // La réponse est dite : le serveur renvoie un vrai son, annoncé comme une voix de synthèse.
  const sound = await speech;
  expect(sound.status()).toBe(200);
  expect(sound.headers()['content-type']).toContain('audio/wav');
  expect(Number(sound.headers()['content-length'])).toBeGreaterThan(20_000);
  await expect(talk.getByText('Voix de synthèse (Gemini). Elle lit le texte affiché, sans rien ajouter.')).toBeVisible({ timeout: 30_000 });

  // Le brouillon : résumé en clair et gros boutons. Rien n'est enregistré avant la confirmation.
  const draft = talk.getByRole('group', { name: 'Observation à confirmer' });
  await expect(draft).toBeVisible({ timeout: 60_000 });
  await expect(draft).toContainText('B-017');
  await expect(draft).toContainText(/mange moins/i);
  expect(await count()).toBe(5);
  await page.screenshot({ path: 'test-results/voix-brouillon.png', fullPage: false });

  // Discussion : une fois la réponse dite, le micro se rouvre tout seul, sans aucun appui. Le faux micro rejoue sa phrase à
  // chaque ouverture : un second échange arrive donc de lui-même, du tac au tac.
  await expect(talk.getByText('Microphone actif.')).toBeVisible({ timeout: 90_000 });
  await expect(talk.getByRole('article')).toHaveCount(2, { timeout: 90_000 });
  // L'utilisateur arrête la discussion : le micro est fermé, et l'écran le dit. Deux brouillons, toujours rien d'enregistré.
  await talk.getByRole('button', { name: 'Discussion : oui' }).click();
  await expect(talk.getByText('Discussion arrêtée. Le micro est fermé.')).toBeVisible();
  await expect(talk.getByText('Microphone actif.')).toHaveCount(0);
  expect(await count()).toBe(5);

  // « Je confirme » (ici écrit, la même règle s'applique à la phrase dictée) : reçu du serveur, et il est dit lui aussi.
  const receipt = page.waitForResponse((r) => r.url().endsWith('/api/assistant/speak'), { timeout: 90_000 });
  await page.getByLabel('Votre question ou votre observation').fill('je confirme');
  await page.keyboard.press('Enter');
  await expect(talk.getByText('Reçu par le serveur').first()).toBeVisible({ timeout: 30_000 });
  expect((await receipt).status()).toBe(200);
  expect(await count()).toBe(6);
});
