import { expect, test } from '@playwright/test';

/**
 * Balise de démonstration de bout en bout, sans IA : un second navigateur joue le téléphone, avec une position GPS
 * ÉMULÉE par le navigateur de test (ce n'est pas un vrai téléphone : le parcours réel reste à essayer à la main).
 */
test('balise : association, repère, éloignement, alerte, question, preuve, mode simulé, arrêt', async ({ page, browser }) => {
  expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } })).ok()).toBeTruthy();
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Balises' });
  const talk = page.getByRole('complementary', { name: 'Parler à mon élevage' });
  await expect(panel).toContainText('Aucune balise associée. Rien n’est mesuré automatiquement.');

  // Association à un animal : lien à ouvrir sur le téléphone, avec l'avertissement « localhost » quand il s'applique.
  await panel.getByRole('button', { name: 'Associer une balise' }).click();
  await panel.getByRole('button', { name: 'Créer le lien de la balise' }).click();
  await expect(panel.getByRole('alert')).toContainText('Indiquez l’animal');
  await panel.getByLabel('Animal associé').fill('b-071');
  await panel.getByRole('button', { name: 'Créer le lien de la balise' }).click();
  await expect(panel).toContainText(/Balise BAL-[0-9A-F]{4} créée/);
  await expect(panel.getByRole('img', { name: /QR code du lien de la balise/ })).toBeVisible();
  await expect(panel).toContainText('n’est pas joignable depuis un téléphone');
  const link = (await panel.getByText(/\/#\/balise\/BAL-/).innerText()).trim();
  const id = /BAL-[0-9A-F]{4}/.exec(link)![0];
  await expect(panel).toContainText('Aucune mesure reçue');

  // Le « téléphone » : position émulée à Abidjan, précision 5 m.
  const home = { latitude: 5.36, longitude: -4.0083, accuracy: 5 };
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, permissions: ['geolocation'], geolocation: home });
  const phone = await phoneCtx.newPage();
  await phone.goto(link);
  await expect(phone.getByRole('note')).toContainText('ce téléphone joue le rôle d’une balise');
  await expect(phone.getByRole('heading', { level: 1 })).toContainText(id);
  await expect(phone.getByText('Associée à')).toContainText('B-071');
  await phone.getByRole('button', { name: 'Autoriser la position' }).click();
  await expect(phone.getByText(/Position reçue, précision ± 5 m/)).toBeVisible();
  await phone.getByRole('button', { name: 'Fixer le repère ici' }).click();
  await expect(phone.getByRole('region', { name: 'État enregistré par le serveur' })).toContainText('Dans la zone', { timeout: 15_000 });
  expect(await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

  // L'écran de l'éleveur suit la balise, sans alerte tant qu'elle est dans la zone.
  await expect(panel).toContainText('Dans la zone', { timeout: 15_000 });
  await expect(panel).toContainText('GPS du téléphone');
  await expect(page.getByRole('alert').filter({ hasText: 'hors de sa zone' })).toHaveCount(0);

  // Le téléphone s'éloigne d'environ 100 m : alerte dans l'application.
  await phoneCtx.setGeolocation({ latitude: home.latitude + 0.0009, longitude: home.longitude, accuracy: 5 });
  await expect(phone.getByRole('region', { name: 'État enregistré par le serveur' })).toContainText('Hors de la zone', { timeout: 20_000 });
  const alert = page.getByRole('alert').filter({ hasText: 'hors de sa zone' });
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(alert).toContainText(id);
  await expect(alert).toContainText('associée à B-071');
  await expect(alert).toContainText('pour un seuil de 30 m');
  await expect(alert).toContainText('La balise mesure sa propre distance, pas la position de l’animal');
  await page.screenshot({ path: 'test-results/balise-alerte.png' });
  await phone.screenshot({ path: 'test-results/balise-telephone.png', fullPage: true });

  // « Quel animal s'est éloigné ? » : la réponse parle de la balise, avec sa source.
  await alert.getByRole('button', { name: 'Demander : quel animal s’est éloigné ?' }).click();
  const answer = talk.getByRole('article').first();
  await expect(answer).toContainText(`Une balise est hors de sa zone : ${id} (associée à B-071).`);
  await expect(answer).toContainText('HORS de la zone');
  await expect(answer).toContainText('source : GPS du téléphone');
  await expect(answer).not.toContainText('évad');

  // La preuve : le dispositif et ses mesures.
  await answer.getByRole('button', { name: `Balise ${id}` }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('téléphone, pas un capteur posé sur un animal');
  await expect(dialog).toContainText('Dernière mesure');
  await dialog.getByRole('button', { name: 'Fermer' }).click();

  // Mode simulé sur le téléphone : marqué comme tel partout, et l'alerte disparaît quand la distance simulée revient à 5 m.
  await phone.getByRole('button', { name: 'Distance simulée' }).click();
  await expect(phone.getByText('DONNÉES SIMULÉES : la distance est réglée à la main')).toBeVisible();
  await phone.getByRole('button', { name: '5 m', exact: true }).click();
  await expect(panel).toContainText('DONNÉES SIMULÉES', { timeout: 20_000 });
  await expect(panel).toContainText('distance SIMULÉE');
  await expect(page.getByRole('alert').filter({ hasText: 'hors de sa zone' })).toHaveCount(0, { timeout: 20_000 });

  // Arrêt depuis l'écran de l'éleveur : la balise n'envoie plus rien et le téléphone le dit.
  await panel.getByRole('button', { name: 'Arrêter' }).click();
  await expect(panel).toContainText('Arrêtée', { timeout: 15_000 });
  await expect(phone.getByText('Cette balise a été arrêtée')).toBeVisible({ timeout: 15_000 });
  await phoneCtx.close();

  // Un lien de balise invalide le dit, sans rien exposer.
  await page.goto('/#/balise/BAL-0000/jeton-invalide');
  await expect(page.getByRole('alert')).toContainText('Cette balise est inconnue ou son lien n’est plus valable');
});
