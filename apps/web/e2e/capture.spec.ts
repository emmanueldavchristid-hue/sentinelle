import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * Livrable A, preuve produit : CAPTURE RÉELLE du parcours fonctionnel, en une prise continue, sans montage.
 * Ce n'est pas un test de régression (voir vivant.spec.ts) : il pilote la vraie application à vitesse humaine
 * pendant que le navigateur enregistre l'écran.
 *
 *   CAPTURE=1 PW_CHANNEL=chrome pnpm --filter @sentinelle/web exec playwright test --project=capture
 *   CAPTURE=1 CAPTURE_AI=on PW_CHANNEL=chrome pnpm --filter @sentinelle/web exec playwright test --project=capture   (avec l'assistant IA du fichier .env)
 * PowerShell : $env:CAPTURE="1"; $env:PW_CHANNEL="chrome"; pnpm --filter @sentinelle/web exec playwright test --project=capture
 *
 * Sortie : docs/captures/parcours-vivant[-ia].webm, 1366 x 768. Le serveur de test tourne sur une base en mémoire :
 * la base de démonstration locale n'est pas touchée.
 */
const AI = process.env.CAPTURE_AI === 'on';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/captures', `parcours-vivant${AI ? '-ia' : ''}.webm`);
const SIZE = { width: 1366, height: 768 };

test.use({ viewport: SIZE, video: { mode: 'on', size: SIZE } });
test.setTimeout(240_000);
test.skip(process.env.CAPTURE !== '1', 'Capture vidéo à la demande : définir CAPTURE=1');

test('capture du parcours réel : question, sources, fiche, brouillon, confirmation, reçu, réponse mise à jour, explication', async ({ page }) => {
  expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } })).ok()).toBeTruthy();
  const pause = (ms: number) => page.waitForTimeout(ms);
  const talk = page.getByRole('complementary', { name: 'Parler à mon élevage' });
  const latest = talk.getByRole('article').first();
  const input = page.getByLabel('Votre question ou votre observation');
  const say = async (text: string) => {
    await input.scrollIntoViewIfNeeded();
    await input.click();
    await input.pressSequentially(text, { delay: 38 });
    await pause(500);
    await page.keyboard.press('Enter');
  };
  const answered = () => expect(latest.locator('.v-statement').first()).toBeVisible({ timeout: 60_000 });

  // 1. Ouverture
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Mon élevage aujourd’hui' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Situation enregistrée' })).toBeVisible();
  await pause(3500);

  // 2 à 5. La question, la réponse sourcée, la mise en évidence
  await say('Qu’est-ce qui a changé depuis hier ?');
  await answered();
  await pause(3000);
  await page.mouse.wheel(0, 420);
  await pause(3500);

  // Une source : l'enregistrement exact et ses trois dates
  await latest.getByRole('button', { name: /Observation …/ }).first().click();
  await expect(page.getByRole('dialog')).toContainText('Réception par le serveur');
  await pause(3500);
  await page.getByRole('dialog').getByRole('button', { name: 'Fermer' }).click();
  await pause(800);

  // 6 et 7. La fiche animale, identifiant tapé vite
  await page.mouse.wheel(0, -2000);
  await say('Montre-moi B 017');
  await expect(page).toHaveURL(/#\/elevage\/animal\/B-017$/, { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Parcours enregistré de B-017' })).toBeVisible();
  await pause(4500);

  // 8 et 9. Une observation : un brouillon, pas un enregistrement
  await say('Ajoute une observation sur B-017 : mange moins depuis ce matin');
  const draft = talk.getByRole('form', { name: 'Vérifiez, puis confirmez' });
  await expect(draft).toBeVisible({ timeout: 60_000 });
  await draft.scrollIntoViewIfNeeded();
  await pause(4500);

  // 10 à 12. Confirmation, reçu du serveur, événement visible
  const confirm = draft.getByRole('button', { name: 'Confirmer et enregistrer' });
  await confirm.scrollIntoViewIfNeeded();
  await pause(1200);
  await confirm.click();
  const receipt = talk.locator('.v-receipt').first();
  await expect(receipt).toContainText('Reçu par le serveur');
  await receipt.scrollIntoViewIfNeeded();
  await pause(3500);
  await page.mouse.wheel(0, -2000);
  await pause(3500);

  // 13 et 14. La même question : réponse mise à jour
  const again = page.getByRole('button', { name: /Reposer : qu’est-ce qui a changé depuis hier/ });
  await again.scrollIntoViewIfNeeded();
  await pause(800);
  await again.click();
  await expect(latest.locator('.v-update')).toContainText('Réponse mise à jour', { timeout: 60_000 });
  await latest.locator('.v-update').scrollIntoViewIfNeeded();
  await pause(4000);

  // 15 et 16. Pourquoi la réponse a changé : comparaison des deux états
  await latest.locator('.v-update').getByRole('button', { name: 'Pourquoi ta réponse a changé ?' }).click();
  await expect(latest).toContainText('Comparaison de deux états enregistrés', { timeout: 60_000 });
  await latest.scrollIntoViewIfNeeded();
  await pause(6000);

  // La vidéo n'est complète qu'une fois la page fermée.
  const video = page.video();
  await page.close();
  mkdirSync(dirname(OUT), { recursive: true });
  await video!.saveAs(OUT);
});
