import { expect, test } from '@playwright/test';

test('mode authentifié : pas de sélecteur de rôle, mauvais mot de passe refusé, connexion puis déconnexion', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();
  await expect(page.getByText('Choisir un rôle')).toHaveCount(0);
  await expect(page.getByLabel(/Couper le réseau/)).toHaveCount(0);
  await page.getByLabel('Identifiant').fill('dr.e2e');
  await page.getByLabel('Mot de passe').fill('mauvais');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('alert')).toContainText('Identifiant ou mot de passe incorrect');
  await page.getByLabel('Mot de passe').fill('mot-de-passe-e2e-2026');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('heading', { name: 'Signalements' })).toBeVisible();
  await expect(page.getByText('session authentifiée')).toBeVisible();
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === 'sentinelle_session')).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
  expect((await page.request.get('/api/investigations', { headers: { 'x-demo-user': 'U-AGENT' } })).status()).toBe(200); // le cookie fait foi, l'en-tête est ignoré
  await page.getByRole('button', { name: 'Se déconnecter' }).first().click();
  await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();
  expect((await page.request.get('/api/me')).status()).toBe(401);
});
