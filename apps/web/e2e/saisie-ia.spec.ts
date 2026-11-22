import { expect, test } from '@playwright/test';

/**
 * Aide à la saisie du formulaire « Nouvelle observation » avec le VRAI assistant IA du fichier .env (appel réel à Gemini).
 * À la demande uniquement, car le test dépend d'un service externe :
 *
 *   SAISIE_IA=1 PW_CHANNEL=chrome pnpm --filter @sentinelle/web exec playwright test --project=saisie-ia
 *
 * Sans IA, le même volet est couvert par finition.spec.ts (lecture par règles fixes).
 */
test.skip(process.env.SAISIE_IA !== '1', 'Aide à la saisie avec IA à la demande : définir SAISIE_IA=1 (appel réel à l’assistant IA)');
test.setTimeout(120_000);

test('aide à la saisie avec l’IA : une phrase libre remplit le formulaire, l’assistant répond dans le volet, rien n’est enregistré sans validation', async ({ page }) => {
  expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } })).ok()).toBeTruthy();
  const count = async () => (await (await page.request.get('/api/farm/changes', { headers: { 'x-demo-user': 'U-ELEVEUR' } })).json()).data.counts.total as number;
  const before = await count();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Mon élevage aujourd’hui' })).toBeVisible();
  await page.goto('/#/declarer/B-017');
  await expect(page.getByText(/Assistant IA connecté : Gemini/)).toBeVisible({ timeout: 15_000 });

  // Une phrase comme on la dirait : pas d'identifiant de lieu, une date relative, aucune heure.
  await page.getByLabel('Votre observation, en une phrase').fill('Elle boite depuis hier, je l’ai vue au marché');
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Remplir le formulaire' }).click();
  const reply = page.getByRole('status', { name: 'Réponse de l’aide à la saisie' });
  await expect(reply).toContainText('J’ai rempli', { timeout: 40_000 });
  console.log(`[mesure] formulaire rempli ${Date.now() - t0} ms après le clic`);
  console.log(`[réponse] ${(await reply.locator('p').first().innerText()).trim()}`);

  // L'assistant répond dans le volet, et dit comment la proposition a été faite.
  await expect(reply).toContainText('le lieu (Marché M, proposé, à vérifier)');
  await expect(reply).toContainText('Aucune heure n’a été dite : je n’en ai pas supposé.');
  await expect(reply).toContainText(/Proposition de Gemini \(.+\), recoupée avec votre phrase/);

  // Les champs sont remplis automatiquement : lieu, jour (hier, sans heure), observation.
  await expect(page.getByLabel('Lieu', { exact: true })).toHaveValue('M');
  await expect(page.getByLabel('Jour seulement')).toBeChecked();
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue(yesterday);
  await expect(page.getByLabel('Observation', { exact: true })).toHaveValue(/boite/i);
  await expect(page.getByText('Rempli par l’aide à la saisie : lieu proposé, à vérifier.')).toBeVisible();
  await page.screenshot({ path: 'test-results/saisie-ia.png', fullPage: true });

  // Rien n'a été enregistré : c'est la validation du formulaire qui enregistre.
  expect(await count()).toBe(before);
  await page.getByRole('button', { name: 'Enregistrer sur l’appareil' }).click();
  await expect(page).toHaveURL(/#\/envois/);
});
