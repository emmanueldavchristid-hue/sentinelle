import { expect, test, type Page } from '@playwright/test';

async function chooseRole(page: Page, name: RegExp) {
  await page.goto('/');
  await page.getByRole('button', { name }).click();
}
async function resetDemo(page: Page) {
  const r = await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } });
  expect(r.ok()).toBeTruthy();
}
async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe.configure({ mode: 'serial' });

test('parcours principal : fiche → observation hors connexion → réouverture → synchronisation → enquête → correction → nouvelle analyse', async ({ page, context }) => {
  await resetDemo(page);

  // 1. Agent : fiche animale (recherche manuelle)
  await chooseRole(page, /Agent de terrain/);
  await page.getByLabel('Rechercher un animal').fill('B-017');
  await page.getByRole('link', { name: /B-017/ }).click();
  await expect(page.getByRole('heading', { name: /Fiche B-017/ })).toBeVisible();
  await expect(page.getByText('Élevage C').first()).toBeVisible();

  // 2. Coupure réseau (simulation nommée) puis saisie
  await page.getByLabel(/Couper le réseau/).check();
  await expect(page.getByRole('button', { name: /Hors connexion/ })).toBeVisible();
  await page.getByRole('button', { name: 'Nouvelle observation' }).click();
  await page.getByLabel('Lieu').selectOption('C');
  await page.locator('#obs-time-date').fill('2026-03-12');
  await page.locator('#obs-time-time').fill('07:30');
  await page.getByLabel('Observation', { exact: true }).fill('Baisse d’appétit constatée ce matin.');

  // 3. Fermeture / réouverture sans perte : le brouillon est restauré
  await page.reload();
  await expect(page.getByText('Brouillon local restauré')).toBeVisible();
  await expect(page.getByLabel('Observation', { exact: true })).toHaveValue('Baisse d’appétit constatée ce matin.');
  await page.getByRole('button', { name: 'Enregistrer sur l’appareil' }).click();
  await expect(page.getByTestId('outbox-item')).toContainText('À transmettre');

  // Transmission impossible hors connexion → échec visible
  await page.getByRole('button', { name: /Transmettre \(1\)/ }).click();
  await expect(page.getByTestId('outbox-item')).toContainText('Échec');
  await expect(page.getByTestId('outbox-item')).toContainText('simulation');

  // Fermeture complète de l'onglet et réouverture : la déclaration est toujours là
  const page2 = await context.newPage();
  await page.close();
  await page2.goto('/#/envois');
  await expect(page2.getByTestId('outbox-item')).toContainText('Échec');

  // 4. Retour du réseau + transmission explicite → « Reçu » après réponse serveur
  await page2.getByLabel(/Couper le réseau/).uncheck();
  await expect(page2.getByRole('button', { name: /Serveur joignable/ })).toBeVisible();
  await page2.getByRole('button', { name: 'Réessayer' }).click();
  await expect(page2.getByTestId('outbox-item')).toContainText('Reçu par le serveur');
  await expect(page2.getByText('1 déclaration(s) reçue(s) par le serveur.')).toBeVisible();

  // Double clic sur un envoi déjà reçu : aucun doublon côté serveur
  const obs = await page2.request.get('/api/observations', { headers: { 'x-demo-user': 'U-VET' } });
  expect((await obs.json()).length).toBe(1);

  // 5. Vétérinaire : examen humain du signalement
  await page2.getByRole('button', { name: 'Changer de rôle' }).first().click();
  await page2.getByRole('button', { name: /Vétérinaire enquêteur/ }).click();
  await page2.getByRole('button', { name: 'Examiner' }).click();
  await expect(page2.getByLabel('Début de la fenêtre')).toHaveValue('2026-02-25');
  await expect(page2.getByLabel('Fin de la fenêtre (exclue)')).toHaveValue('2026-03-13');

  // 6–7. Ouverture de l'enquête : parcours et résultats expliqués
  await page2.getByRole('button', { name: /Ouvrir l’enquête/ }).click();
  await expect(page2.getByRole('heading', { name: /Enquête · signalement sur B-017/ })).toBeVisible();
  const results = page2.getByRole('region', { name: 'Résultats' });
  for (const t of ['Élevage A → Marché M', 'Marché M → Élevage C', 'B-031 à Marché M', 'B-052 à Marché M', 'B-044 à Marché M']) await expect(page2.getByRole('button', { name: new RegExp(t) }).first()).toBeVisible();
  await expect(results.getByText(/Élevage E.*proximité géographique n’est pas évaluée/)).toBeVisible();

  // 8. Information manquante : B-052, sélectionnée par défaut
  const why = page2.getByRole('region', { name: 'Pourquoi ce résultat ?' });
  await expect(why).toContainText('Information insuffisante');
  await expect(why).toContainText('Aucune heure n’a été supposée');
  await page2.getByRole('button', { name: /B-044 à Marché M/ }).click();
  await expect(why).toContainText('ne signifie pas « sans risque sanitaire »');
  void results;

  // Demande de vérification à un agent
  await page2.getByRole('listitem').filter({ hasText: 'Préciser les heures de présence de B-052' }).getByRole('button', { name: 'Demander à un agent' }).click();
  await expect(page2.getByText('Demandée à un agent', { exact: true })).toBeVisible();
  const invUrl = page2.url();

  // 9. Agent : correction → nouvelle révision
  await page2.getByRole('button', { name: 'Changer de rôle' }).first().click();
  await page2.getByRole('button', { name: /Agent de terrain/ }).click();
  await page2.getByRole('link', { name: 'Vérifications' }).click();
  await page2.getByRole('button', { name: 'Compléter' }).click();
  await expect(page2.getByText('révision 1')).toBeVisible();
  await page2.locator('#fix-start-time').fill('11:00');
  await page2.locator('#fix-end-time').fill('15:00');
  await page2.getByLabel('Source de l’information').fill('registre du marché consulté sur place');
  await page2.getByRole('button', { name: 'Enregistrer la correction' }).click();
  await expect(page2.getByText(/Révision 2 enregistrée/)).toBeVisible();

  // 10. Vétérinaire : relance et explication du changement
  await page2.getByRole('button', { name: 'Changer de rôle' }).first().click();
  await page2.getByRole('button', { name: /Vétérinaire enquêteur/ }).click();
  await page2.goto(invUrl);
  await page2.getByRole('button', { name: 'Relancer l’analyse' }).click();
  const cmp = page2.getByRole('region', { name: /Ce qui a changé/ });
  await expect(cmp).toContainText('1 résultat modifié, 1 ajouté, 0 retiré.');
  await expect(cmp).toContainText('Révision 2 de P6');
  await expect(why).toContainText('Lien potentiel selon les paramètres');

  // L'analyse n° 1 reste consultable telle quelle
  await page2.getByRole('button', { name: /Analyse n° 1/ }).click();
  await page2.locator('[data-key="B|P2|P6"]').click();
  await expect(why).toContainText('Information insuffisante');
  await expect(why).toContainText('révision 1');
  await page2.screenshot({ path: 'test-results/console-analyse-1.png', fullPage: true });
  await page2.getByRole('button', { name: /Analyse n° 2/ }).click();
  await page2.screenshot({ path: 'test-results/console-analyse-2.png', fullPage: true });
});

test('accès refusé : un agent ne peut pas ouvrir la console', async ({ page }) => {
  await chooseRole(page, /Agent de terrain/);
  const r = await page.request.get('/api/investigations', { headers: { 'x-demo-user': 'U-AGENT' } });
  expect(r.status()).toBe(403);
});

test('téléphone étroit (360 px) : pas de défilement horizontal sur les écrans agent', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, hasTouch: true });
  const page = await ctx.newPage();
  await chooseRole(page, /Agent de terrain/);
  await noHorizontalOverflow(page);
  await page.getByRole('link', { name: /B-017/ }).click();
  await expect(page.getByRole('heading', { name: /Fiche B-017/ })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Nouvelle observation' }).click();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: 'test-results/mobile-declaration.png', fullPage: true });
  await page.getByRole('button', { name: 'Déclarations' }).click();
  await noHorizontalOverflow(page);
  await ctx.close();
});

test('clavier : le parcours de choix de rôle et de recherche est atteignable sans souris', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Agent de terrain/ })).toBeVisible();
  await page.keyboard.press('Tab');
  let found = false;
  for (let i = 0; i < 12 && !found; i++) {
    const t = await page.evaluate(() => (document.activeElement?.tagName === 'BUTTON' ? document.activeElement.textContent : '') ?? '');
    if (/Agent de terrain/.test(t)) found = true;
    else await page.keyboard.press('Tab');
  }
  expect(found).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Rechercher un animal')).toBeVisible();
  const outline = await page.evaluate(() => {
    const el = document.querySelector('#search') as HTMLElement;
    el.focus();
    return getComputedStyle(el).outlineStyle;
  });
  expect(outline).not.toBe('none');
});
