import { expect, test, type Page } from '@playwright/test';

const reset = async (page: Page, withObservation: boolean) => expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation } })).ok()).toBeTruthy();
async function role(page: Page, name: RegExp) {
  await page.goto('/#/roles');
  await page.getByRole('button', { name }).click();
}
async function switchRole(page: Page, name: RegExp) {
  await page.getByRole('button', { name: 'Changer de rôle' }).first().click();
  await page.getByRole('button', { name }).click();
}
async function openInvestigation(page: Page) {
  await page.getByRole('button', { name: 'Examiner' }).first().click();
  await page.getByRole('button', { name: /Ouvrir l’enquête/ }).click();
  await expect(page.getByRole('heading', { name: /Enquête · signalement sur B-017/ })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('vrai mode hors ligne (réseau coupé par le navigateur, service worker) : rechargement, saisie, puis transmission', async ({ page, context }) => {
  await reset(page, false);
  await role(page, /Agent de terrain/);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // la page est désormais contrôlée par le service worker
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.getByRole('link', { name: /B-017/ }).click();
  await expect(page.getByRole('heading', { name: /Fiche B-017/ })).toBeVisible();

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: /Fiche B-017/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Hors connexion/ })).toBeVisible();
  await expect(page.getByText(/Données locales, peut-être périmées/)).toBeVisible();
  await page.getByRole('button', { name: 'Nouvelle observation' }).click();
  await page.getByLabel('Lieu').selectOption('C');
  await page.locator('#obs-time-date').fill('2026-03-12');
  await page.getByText('Jour seulement').click();
  await page.getByLabel('Observation', { exact: true }).fill('Toux observée, heure non relevée.');
  await page.getByRole('button', { name: 'Enregistrer sur l’appareil' }).click();
  await expect(page.getByTestId('outbox-item')).toContainText('À transmettre');
  await expect(page.getByTestId('outbox-item')).toContainText('heure inconnue');

  await context.setOffline(false);
  await page.getByRole('button', { name: /Serveur joignable|Hors connexion/ }).click();
  await expect(page.getByRole('button', { name: /Serveur joignable/ })).toBeVisible();
  await page.getByRole('button', { name: /Transmettre \(1\)/ }).click();
  await expect(page.getByTestId('outbox-item')).toContainText('Reçu par le serveur');
  // Le jeu vivant contient d'autres observations : on ne compte que celle saisie ici, sur B-017.
  const obs = (await (await page.request.get('/api/observations', { headers: { 'x-demo-user': 'U-VET' } })).json()).filter((o: { animalId: string }) => o.animalId === 'B-017');
  expect(obs).toHaveLength(1);
  expect(obs[0].eventTime).toEqual({ precision: 'DAY', date: '2026-03-12' });
});

test('import CSV : erreurs explicites, import bloqué, puis import réussi', async ({ page }) => {
  await reset(page, false);
  await role(page, /Vétérinaire enquêteur/);
  await page.getByRole('link', { name: 'Import' }).click();
  const bad = ['type;id;animal;lieu;lieu_arrivee;debut;fin;source', 'presence;P900;B-017;A;;2026-02-26T07:00;2026-02-26T15:00;ok', 'presence;P901;B-031;Q;;01/03/2026;;erreurs'].join('\n');
  await page.getByLabel(/Ou coller le contenu/).fill(bad);
  await page.getByRole('button', { name: 'Prévisualiser' }).click();
  await expect(page.getByText('× 1 en erreur')).toBeVisible();
  await expect(page.getByText(/Lieu « Q » inconnu/)).toBeVisible();
  await expect(page.getByText(/utilisez le format AAAA-MM-JJ/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Importer/ })).toHaveCount(0);
  await page.getByLabel(/Ou coller le contenu/).fill(bad.replace('presence;P901;B-031;Q;;01/03/2026;;erreurs', 'mouvement;MV901;N-777;M;E;2026-02-27T09:00;2026-02-27T10:30;registre'));
  await page.getByRole('button', { name: 'Prévisualiser' }).click();
  await expect(page.getByText(/Animal N-777 inconnu : il sera créé/)).toBeVisible();
  await page.getByRole('button', { name: 'Importer 2 enregistrement(s)' }).click();
  await expect(page.getByText(/2 enregistrement\(s\) importé\(s\) en révision 1 ; animaux créés : N-777/)).toBeVisible();
});

test('anomalie B-060 : correction du mouvement par l’agent, nouvelle analyse, historique, paramètres modifiés', async ({ page }) => {
  await reset(page, true);
  await role(page, /Vétérinaire enquêteur/);
  await openInvestigation(page);
  await page.getByRole('listitem').filter({ hasText: 'Vérifier l’enregistrement MV6' }).getByRole('button', { name: 'Demander à un agent' }).click();
  const invUrl = page.url();
  await switchRole(page, /Agent de terrain/);
  await page.getByRole('link', { name: 'Vérifications' }).click();
  await page.getByRole('button', { name: 'Compléter' }).click();
  await expect(page.getByRole('group', { name: 'Départ' })).toBeVisible();
  await page.locator('#fix-start-time').fill('05:00');
  await page.getByLabel('Source de l’information').fill('registre de l’élevage D');
  await page.getByRole('button', { name: 'Enregistrer la correction' }).click();
  await expect(page.getByText(/Révision 2 enregistrée/)).toBeVisible();
  await switchRole(page, /Vétérinaire enquêteur/);
  await page.goto(invUrl);
  await page.getByRole('button', { name: 'Relancer l’analyse' }).click();
  await expect(page.getByRole('region', { name: /Ce qui a changé/ })).toContainText('0 résultat modifié, 0 ajouté, 1 retiré.');
  await page.getByText('Historique du dossier').click();
  await expect(page.getByText('Enregistrement corrigé (nouvelle révision)')).toBeVisible();
  await page.getByText('Modifier les paramètres et relancer').click();
  await page.getByLabel('Profondeur', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Lancer avec ces paramètres' }).click();
  await expect(page.getByRole('region', { name: /Ce qui a changé — analyse n° 2 → n° 3/ })).toContainText('1 retiré');
  await expect(page.getByRole('region', { name: /Ce qui a changé/ })).toContainText('Paramètres d’analyse modifiés');
});

test('grande projection (1920 px), surlignage croisé schéma / liste / preuves, mouvement réduit', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await reset(page, true);
  await role(page, /Vétérinaire enquêteur/);
  await openInvestigation(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  // liste → schéma : le chemin sélectionné est épaissi
  await page.locator('[data-key="B|P2|P4"]').click();
  await expect(page.locator('svg path[stroke-width="5"]')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Pourquoi ce résultat ?' })).toContainText('B-031 à Marché M');
  // légende du schéma → liste
  await page.getByRole('button', { name: /B-044 — chemin exclu/ }).click();
  await expect(page.locator('[data-key="B|P2|P5"]')).toHaveAttribute('aria-pressed', 'true');
  // mouvement réduit : aucune animation de surlignage
  const anim = await page.evaluate(() => {
    const el = document.createElement('div');
    el.className = 'flash';
    document.body.append(el);
    return getComputedStyle(el).animationName;
  });
  expect(anim).toBe('none');
  await page.screenshot({ path: 'test-results/console-1920.png' });
  await ctx.close();
});

test('scanner QR : repli explicite si le navigateur ne le permet pas ; QR présent sur la fiche', async ({ page }) => {
  await role(page, /Agent de terrain/);
  await page.getByRole('link', { name: /B-017/ }).click();
  await expect(page.getByRole('img', { name: 'QR code menant à la fiche B-017' })).toBeVisible();
  await page.goto('/#/scan');
  const supported = await page.evaluate(() => 'BarcodeDetector' in window);
  if (supported) await expect(page.getByRole('button', { name: 'Activer la caméra' })).toBeVisible();
  else await expect(page.getByText(/ne permet pas la lecture de QR code/)).toBeVisible();
});

test('aide à la saisie sans assistant IA : la phrase remplit le formulaire par règles fixes, rien n’est enregistré sans validation', async ({ page }) => {
  await reset(page, false);
  await role(page, /Agent de terrain/);
  await page.getByRole('link', { name: /B-017/ }).click();
  await page.getByRole('button', { name: 'Nouvelle observation' }).click();
  // Le volet est ouvert d'emblée et dit comment la phrase sera lue (ici : sans IA).
  await expect(page.getByText('Sans assistant IA sur ce serveur : la phrase est lue par des règles fixes.')).toBeVisible();
  await page.getByLabel('Votre observation, en une phrase').fill('Tousse légèrement ce matin à Élevage A');
  await page.getByRole('button', { name: 'Remplir le formulaire' }).click();

  // L'assistant répond dans le volet : ce qu'il a rempli, ce qu'il n'a pas supposé.
  const reply = page.getByRole('status', { name: 'Réponse de l’aide à la saisie' });
  await expect(reply).toContainText('J’ai rempli le lieu (Élevage A), le moment');
  await expect(reply).toContainText('Aucune heure n’a été dite : je n’en ai pas supposé.');
  await expect(reply).toContainText('rien n’est enregistré tant que vous n’avez pas validé');

  // Les champs du formulaire sont remplis automatiquement, et signalés comme tels.
  await expect(page.getByLabel('Lieu', { exact: true })).toHaveValue('A');
  await expect(page.getByLabel('Jour seulement')).toBeChecked();
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue(new Date().toISOString().slice(0, 10));
  await expect(page.getByLabel('Observation', { exact: true })).toHaveValue(/Tousse légèrement/);
  await expect(page.getByText('Rempli par l’aide à la saisie. Relisez')).toBeVisible();

  // Reprendre un champ à la main retire son signalement ; l'enregistrement passe par le chemin habituel.
  await page.getByLabel('Observation', { exact: true }).fill('Tousse légèrement, constaté ce matin');
  await expect(page.getByText('Rempli par l’aide à la saisie. Relisez')).toHaveCount(0);
  await page.getByRole('button', { name: 'Enregistrer sur l’appareil' }).click();
  await expect(page).toHaveURL(/#\/envois/);
  await expect(page.getByText('Tousse légèrement, constaté ce matin')).toBeVisible();
});

test('synthèse déterministe dans la console, rapport imprimable complet', async ({ page }) => {
  await reset(page, true);
  await role(page, /Vétérinaire enquêteur/);
  await openInvestigation(page);
  const sum = page.getByRole('region', { name: /Synthèse de l’analyse n° 1/ });
  await expect(sum).toContainText('B-017 compte 2 mouvements enregistrés');
  await expect(sum).toContainText('[MV1, MV2]');
  await expect(sum).toContainText('Reformulation IA indisponible : aucun fournisseur configuré');
  await page.getByRole('link', { name: 'Rapport imprimable' }).click();
  await expect(page.getByRole('heading', { name: /Signalement sur B-017 — analyse n° 1/ })).toBeVisible();
  for (const t of ['Résultats détaillés', 'Limites de la recherche', 'Vérifications', 'Historique du dossier']) await expect(page.getByText(t, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Analyse calculée/).first()).toBeVisible();
  await expect(page.getByText('Enquête ouverte').first()).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeHidden();
  await expect(page.getByRole('button', { name: /Imprimer/ })).toBeHidden();
  await page.pdf({ path: 'test-results/rapport.pdf', format: 'A4' });
  await page.emulateMedia({ media: 'screen' });
});

test('déconnexion avec une déclaration non transmise : confirmation exigée, rien n’est effacé si refus', async ({ page }) => {
  await reset(page, false);
  await role(page, /Agent de terrain/);
  await page.getByRole('link', { name: /B-017/ }).click();
  await page.getByRole('button', { name: 'Nouvelle observation' }).click();
  await page.getByLabel('Lieu').selectOption('C');
  await page.getByText('Inconnue').click();
  await page.getByLabel('Observation', { exact: true }).fill('Observation en attente.');
  await page.getByRole('button', { name: 'Enregistrer sur l’appareil' }).click();
  let message = '';
  page.once('dialog', (d) => ((message = d.message()), d.dismiss()));
  await page.getByRole('button', { name: 'Changer de rôle' }).first().click();
  await expect.poll(() => message).toMatch(/1 déclaration\(s\) non transmise\(s\)/);
  await expect(page.getByTestId('outbox-item')).toContainText('À transmettre');
});
