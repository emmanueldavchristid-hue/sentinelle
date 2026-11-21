import { expect, test } from '@playwright/test';

/**
 * Affichage simple (celui par défaut) : peu de texte, gros boutons, détails et preuves à un clic.
 * Vérifie aussi la confirmation par la phrase « je confirme » (dite ou écrite) et les balises nommées (« Poulet A »).
 * Sans IA : le serveur de test tourne avec ASSISTANT_AI=off.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test('affichage simple : réponse en phrases courtes, preuves à un clic, « je confirme », balise nommée', async ({ page, browser }) => {
  expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } })).ok()).toBeTruthy();
  await page.goto('/');
  const talk = page.getByRole('complementary', { name: 'Parler à mon élevage' });
  const ask = async (text: string) => {
    await page.getByLabel('Votre question ou votre observation').fill(text);
    await page.keyboard.press('Enter');
  };

  // Ce qui a disparu de l'affichage par défaut : détails techniques, simulation réseau, paragraphes d'explication.
  await expect(page.getByRole('heading', { level: 1, name: 'Mon élevage aujourd’hui' })).toBeVisible();
  await expect(page.getByRole('note').filter({ hasText: 'données entièrement synthétiques' })).toBeVisible(); // la mention reste toujours
  await expect(page.getByRole('button', { name: 'Affichage détaillé : non' })).toBeVisible();
  await expect(page.getByLabel(/Couper le réseau/)).toHaveCount(0);
  await expect(page.getByText('Synchronisation')).toHaveCount(0);
  await expect(talk.getByText(/règles fixes/)).toHaveCount(0);
  const ledger = page.getByRole('group', { name: 'Situation enregistrée' });
  await expect(ledger).toContainText('Animaux');
  await expect(ledger).toContainText('Nouveautés depuis hier');
  await expect(ledger.getByRole('button')).toHaveCount(3);

  // Une réponse : des phrases, sans libellé de nature ni identifiant ; les preuves restent à un clic.
  await ask('Qu’est-ce qui a changé depuis hier ?');
  const first = talk.getByRole('article').first();
  await expect(first).toContainText('Depuis hier, 5 enregistrements ont été reçus par le serveur : 4 ajouts, 1 correction, 0 tâche.');
  await expect(first).toContainText('Observation sur B-071 : Boite légèrement à la marche.');
  await expect(first.getByText('Fait enregistré').first()).toBeHidden();
  await expect(first.getByText(/reçu par le serveur le/).first()).toBeHidden();
  await first.getByText(/Détails et preuves \(5 sources\)/).click();
  await expect(first.getByText('Fait enregistré').first()).toBeVisible();
  await expect(first.getByText('Lecture directe des données, sans IA')).toBeVisible();
  await first.getByRole('button', { name: 'P8 rév. 2' }).click();
  await expect(page.getByRole('dialog')).toContainText('Révisions conservées (2)');
  await page.getByRole('dialog').getByRole('button', { name: 'Fermer' }).click();

  // La chronologie est allégée ; le détail d'un événement s'ouvre toujours.
  const chrono = page.getByRole('region', { name: 'Reçu depuis hier' });
  await expect(chrono.getByText(/Saisie sur l’appareil/).first()).toBeHidden();
  await chrono.getByRole('button', { name: 'Voir le détail' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('Réception par le serveur');
  await page.getByRole('dialog').getByRole('button', { name: 'Fermer' }).click();

  // Une observation : résumé en clair et deux gros boutons. « non » abandonne, « je confirme » enregistre.
  await ask('Ajoute une observation sur B-017 : mange moins depuis ce matin');
  let draft = talk.getByRole('group', { name: 'Observation à confirmer' });
  await expect(draft).toContainText('« Mange moins depuis ce matin »');
  await expect(draft).toContainText('B-017 · Élevage C');
  await expect(draft.getByRole('button', { name: 'Confirmer' })).toBeVisible();
  await expect(draft.getByRole('button', { name: 'Annuler' })).toBeVisible();
  await ask('non');
  await expect(talk.getByText('Brouillon abandonné. Rien n’a été enregistré.')).toBeVisible();
  const count = async () => (await (await page.request.get('/api/farm/changes', { headers: { 'x-demo-user': 'U-ELEVEUR' } })).json()).data.counts.total as number;
  expect(await count()).toBe(5);

  await ask('Ajoute une observation sur B-017 : mange moins depuis ce matin');
  draft = talk.getByRole('group', { name: 'Observation à confirmer' });
  await expect(draft).toBeVisible();
  await ask('Je confirme.');
  await expect(talk.locator('.v-receipt')).toContainText('Reçu par le serveur');
  expect(await count()).toBe(6);
  // Une phrase longue commençant par « oui » n'est pas une confirmation : c'est une question comme une autre.
  await ask('Ajoute une observation sur B-071 : boit normalement aujourd’hui');
  await expect(talk.getByRole('group', { name: 'Observation à confirmer' })).toBeVisible();
  await ask('Oui mais dis-moi d’abord quelles informations manquent sur cet animal');
  expect(await count()).toBe(6);

  // Balise nommée : « Poulet A » est proposé, sans animal à saisir ; le nom remplace l'identifiant technique.
  const panel = page.getByRole('region', { name: 'Balises' });
  await panel.getByRole('button', { name: 'Ajouter une balise' }).click();
  await expect(panel.getByLabel('Nom de la balise')).toHaveAttribute('placeholder', 'Poulet A');
  await expect(panel.getByLabel(/Animal associé/)).toHaveCount(0);
  await panel.getByRole('button', { name: 'Créer le lien de la balise' }).click();
  const link = (await panel.getByText(/\/#\/balise\/BAL-/).innerText()).trim();
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
  const phone = await phoneCtx.newPage();
  await phone.goto(link);
  await phone.getByRole('button', { name: 'Distance simulée' }).click();
  await phone.getByRole('button', { name: '120 m', exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'hors de sa zone' });
  await expect(alert).toContainText('Poulet A', { timeout: 20_000 });
  await expect(alert).toContainText('données simulées');
  const zone = page.getByRole('region', { name: 'Zone autour du repère' });
  await expect(zone).toContainText('Poulet A');
  await expect(zone).toContainText('DONNÉES SIMULÉES');
  await alert.getByRole('button', { name: 'Qui s’est éloigné ?' }).click();
  await expect(talk.getByRole('article').first()).toContainText('Une balise est hors de sa zone : « Poulet A ».');
  await phoneCtx.close();

  // Le mode détaillé se rétablit d'un clic et reste mémorisé.
  await page.getByRole('button', { name: 'Affichage détaillé : non' }).click();
  await expect(page.getByRole('button', { name: 'Affichage détaillé : oui' })).toBeVisible();
  await expect(page.getByLabel(/Couper le réseau/)).toBeVisible();
  await expect(ledger.getByText('Synchronisation')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
