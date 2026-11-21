import { expect, test } from '@playwright/test';

/**
 * Parcours d'acceptation SENTINELLE VIVANT, en texte seul, sur le jeu de démonstration, sans IA
 * (serveur de test lancé avec ASSISTANT_AI=off : lecture directe des données par règles fixes).
 * Les 16 étapes du brief sont numérotées en commentaire.
 */
test('boucle de preuve vivante : question, sources, fiche, brouillon, confirmation, reçu, réponse mise à jour, explication', async ({ page }) => {
  const reset = await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } });
  expect(reset.ok()).toBeTruthy();
  const demo = page.getByRole('note').filter({ hasText: 'données entièrement synthétiques' });
  const talk = page.getByRole('complementary', { name: 'Parler à mon élevage' });
  const chrono = page.getByRole('region', { name: /Reçu depuis hier|tout ce qui est enregistré/ });
  const ask = async (text: string) => {
    await page.getByLabel('Votre question ou votre observation').fill(text);
    await page.getByRole('button', { name: 'Demander' }).click();
  };
  const countSinceYesterday = async () => (await (await page.request.get('/api/farm/changes', { headers: { 'x-demo-user': 'U-ELEVEUR' } })).json()).data.counts.total as number;

  // 1. L'utilisateur ouvre son exploitation : l'écran d'ouverture est « Mon élevage aujourd'hui », pas le choix de rôle.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Mon élevage aujourd’hui' })).toBeVisible();
  await expect(demo).toBeVisible();
  await expect(page).toHaveTitle(/Mon élevage aujourd’hui · Sentinelle Vivant \(démonstrateur\)/);
  await expect(page.getByRole('group', { name: 'Situation enregistrée' })).toContainText('8');
  await expect(talk).toContainText('Assistant IA non configuré');
  // Sans assistant IA, la dictée est annoncée indisponible (pas de bouton factice) et le texte reste l'accès complet.
  await expect(talk.getByRole('button', { name: 'Parler' })).toBeDisabled();
  await expect(talk).toContainText('Dictée indisponible : la transcription passe par l’assistant IA');
  // Réponses à voix haute : activées par défaut (voix de synthèse de l'appareil quand le serveur n'en fournit pas), et coupables.
  const voiceToggle = talk.getByRole('button', { name: /Réponses à voix haute/ });
  await expect(voiceToggle).toHaveText('Réponses à voix haute : oui');
  await expect(talk).toContainText('Chaque réponse est aussi dite par la voix de synthèse de cet appareil.');
  await voiceToggle.click();
  await expect(voiceToggle).toHaveText('Réponses à voix haute : non');
  await page.reload();
  await expect(talk.getByRole('button', { name: /Réponses à voix haute/ })).toHaveText('Réponses à voix haute : non'); // préférence conservée
  await talk.getByRole('button', { name: /Réponses à voix haute/ }).click();
  expect(await countSinceYesterday()).toBe(5);

  // 2 à 4. « Qu'est-ce qui a changé depuis hier ? » : lecture des événements réels, réponse avec sources.
  await ask('Qu’est-ce qui a changé depuis hier ?');
  const first = talk.getByRole('article').first();
  await expect(first).toContainText('Lecture directe des données, sans IA');
  await expect(first).toContainText('5 enregistrements ont été reçus par le serveur : 4 ajouts, 1 correction, 0 tâche');
  await expect(first.getByText('Fait enregistré').first()).toBeVisible();
  await expect(first.getByText('Résultat calculé').first()).toBeVisible();
  await expect(first.getByRole('button', { name: 'P8 rév. 2' })).toBeVisible();

  // 5. La constellation et la chronologie mettent ces événements en évidence.
  await expect(chrono.locator('li[data-highlight="true"]')).toHaveCount(5);
  await expect(page.getByRole('region', { name: 'Constellation de l’exploitation' })).toBeVisible();

  // « Pourquoi me montres-tu cette observation ? » : une source s'ouvre sur l'enregistrement exact, avec ses trois dates.
  await first.getByRole('button', { name: /Observation …/ }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Date de l’événement');
  await expect(dialog).toContainText('Saisie sur l’appareil');
  await expect(dialog).toContainText('Réception par le serveur');
  await dialog.getByRole('button', { name: 'Fermer' }).click();

  // 6 et 7. Il demande une fiche animale (identifiant tapé vite) : l'écran l'ouvre.
  await ask('montre moi b 017');
  await expect(page).toHaveURL(/#\/elevage\/animal\/B-017$/);
  await expect(page.getByRole('heading', { name: 'Parcours enregistré de B-017' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'B-017, tout ce qui est enregistré' })).toBeVisible();
  await expect(chrono).toContainText('Déplacement de B-017 : Marché M vers Élevage C');
  await expect(talk.getByRole('article').first()).toContainText('Aucune observation enregistrée pour cet animal. Cela ne renseigne pas sur son état.');
  await expect(demo).toBeVisible();

  // 8 et 9. Il saisit une observation : un brouillon apparaît, rien n'est écrit.
  await ask('Ajoute une observation sur B-017 : mange moins depuis ce matin');
  const draft = talk.getByRole('form', { name: 'Vérifiez, puis confirmez' });
  await expect(draft).toBeVisible();
  await expect(draft.getByLabel('Animal')).toHaveValue('B-017');
  await expect(draft.getByLabel('Lieu de l’observation')).toHaveValue('C');
  await expect(draft.getByLabel('Ce qui est constaté')).toHaveValue('Mange moins depuis ce matin');
  await expect(draft).toContainText('Proposé, à vérifier');
  await expect(draft).toContainText('À confirmer');
  expect(await countSinceYesterday()).toBe(5);

  // 10 et 11. Il confirme : le reçu vient du serveur.
  await draft.getByRole('button', { name: 'Confirmer et enregistrer' }).click();
  const receipt = talk.getByText('Reçu par le serveur', { exact: false }).first();
  await expect(receipt).toBeVisible();
  await expect(talk.getByRole('article').first()).toContainText('Observation enregistrée, reçue le');
  expect(await countSinceYesterday()).toBe(6);

  // 12. L'événement apparaît (chronologie de l'animal, marqué « nouveau »).
  await expect(chrono.locator('li').first()).toContainText('Mange moins depuis ce matin');
  await expect(chrono.locator('li').first()).toContainText('nouveau, confirmé pendant cette session');

  // 13 et 14. Il repose la question : la réponse tient compte de la nouvelle donnée.
  await page.getByRole('button', { name: /Reposer : qu’est-ce qui a changé depuis hier/ }).click();
  const second = talk.getByRole('article').first();
  await expect(second).toContainText('Réponse mise à jour');
  await expect(second).toContainText('6 enregistrements (5 ajouts, 1 correction, 0 tâche)');
  await expect(second).toContainText('Observation sur B-017 : Mange moins depuis ce matin');

  // 15 et 16. « Pourquoi ta réponse a changé ? » : l'événement ajouté et la comparaison des deux états.
  await ask('Pourquoi ta réponse a changé ?');
  const why = talk.getByRole('article').first();
  await expect(why).toContainText('Comparaison de deux états enregistrés');
  await expect(why).toContainText('5 enregistrements (4 ajouts, 1 correction, 0 tâche)');
  await expect(why).toContainText('6 enregistrements (5 ajouts, 1 correction, 0 tâche)');
  await expect(why).toContainText('1 enregistrement a été reçu par le serveur : 1 ajout, 0 correction, 0 tâche');
  await expect(why).toContainText('Observation sur B-017 : Mange moins depuis ce matin');
  await expect(demo).toBeVisible();

  // La liste équivalente au schéma donne les mêmes informations.
  await page.getByRole('button', { name: 'Liste' }).click();
  await expect(page.getByRole('table', { name: 'Sites de l’exploitation' })).toContainText('Élevage C');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('états limites : demande inconnue, animal introuvable, saisie manuelle, hors connexion sans réponse simulée', async ({ page }) => {
  await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } });
  await page.goto('/');
  const talk = page.getByRole('complementary', { name: 'Parler à mon élevage' });
  const ask = async (text: string) => {
    await page.getByLabel('Votre question ou votre observation').fill(text);
    await page.keyboard.press('Enter');
  };

  await ask('Quel temps fera-t-il demain ?');
  await expect(talk.getByRole('article').first()).toContainText('Je ne reconnais pas cette demande');

  await page.goto('/#/elevage/animal/INCONNU');
  await expect(page.getByRole('alert')).toContainText('Aucun animal « INCONNU » n’est enregistré dans votre périmètre');
  await page.goto('/#/elevage');

  // Saisie manuelle : champs à compléter, validation avant écriture, date impossible refusée par le navigateur ou le serveur.
  await page.getByRole('button', { name: 'Ajouter une observation' }).first().click();
  const draft = talk.getByRole('form', { name: 'Vérifiez, puis confirmez' });
  await draft.getByRole('button', { name: 'Confirmer et enregistrer' }).click();
  await expect(draft).toContainText('Indiquez l’animal concerné');
  await draft.getByLabel('Animal').fill('X-999');
  await draft.getByLabel('Lieu de l’observation').selectOption('C');
  await draft.getByLabel('Inconnue').check();
  await draft.getByLabel('Ce qui est constaté').fill('Essai sur un animal inexistant');
  await draft.getByRole('button', { name: 'Confirmer et enregistrer' }).click();
  await expect(draft).toContainText('Aucun animal enregistré ne correspond à « X-999 »');
  await draft.getByRole('button', { name: 'Abandonner le brouillon' }).click();
  await expect(talk.getByRole('article').first()).toContainText('Brouillon abandonné. Rien n’a été enregistré.');

  // Hors connexion (simulation de démonstration) : données locales datées, aucune réponse inventée, observation gardée sur l'appareil.
  await page.getByLabel(/Couper le réseau/).check();
  await expect(page.getByRole('button', { name: /Hors connexion/ })).toBeVisible();
  await expect(page.getByText('Données conservées sur cet appareil')).toBeVisible();
  await ask('Qu’est-ce qui a changé depuis hier ?');
  await expect(talk.getByRole('article').first()).toContainText('aucune réponse n’est simulée');
  await talk.getByRole('button', { name: 'Préparer une observation (saisie manuelle)' }).click();
  const offline = talk.getByRole('form', { name: 'Vérifiez, puis confirmez' });
  await offline.getByLabel('Animal').fill('B-071');
  await offline.getByLabel('Lieu de l’observation').selectOption('C');
  await offline.getByLabel('Inconnue').check();
  await offline.getByLabel('Ce qui est constaté').fill('Observation saisie hors connexion');
  await offline.getByRole('button', { name: 'Confirmer et enregistrer' }).click();
  await expect(talk.getByRole('article').first()).toContainText('Sur cet appareil seulement');
  await expect(talk.getByRole('article').first()).toContainText('Le serveur n’a pas confirmé la réception');
  const obs = await (await page.request.get('/api/observations', { headers: { 'x-demo-user': 'U-VET' } })).json();
  expect(obs.filter((o: { note: string }) => o.note === 'Observation saisie hors connexion')).toHaveLength(0);

  // Retour du réseau : transmission explicite, reçu, puis l'observation existe côté serveur.
  await page.getByLabel(/Couper le réseau/).uncheck();
  await expect(page.getByRole('button', { name: /Serveur joignable/ })).toBeVisible();
  await talk.getByRole('button', { name: 'Ouvrir les déclarations' }).click();
  await page.getByRole('button', { name: /Transmettre \(1\)/ }).click();
  await expect(page.getByText('1 déclaration(s) reçue(s) par le serveur.')).toBeVisible();
  const after = await (await page.request.get('/api/observations', { headers: { 'x-demo-user': 'U-VET' } })).json();
  expect(after.filter((o: { note: string }) => o.note === 'Observation saisie hors connexion')).toHaveLength(1);
});

test('téléphone (375 px) : liste à la place du schéma, pas de défilement horizontal, mêmes informations', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Mon élevage aujourd’hui' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Sites de l’exploitation' })).toBeVisible();
  await expect(page.getByRole('group', { name: /Schéma des sites/ })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.goto('/#/elevage/animal/B-017');
  await expect(page.getByText('Lieu actuel enregistré :')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: 'test-results/vivant-mobile.png', fullPage: true });
  await ctx.close();
});
