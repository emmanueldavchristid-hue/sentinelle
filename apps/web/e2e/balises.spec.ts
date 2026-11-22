import { expect, test } from '@playwright/test';

/**
 * Balise de démonstration de bout en bout, sans IA : un second navigateur joue le téléphone, avec une position GPS
 * ÉMULÉE par le navigateur de test (ce n'est pas un vrai téléphone : le parcours réel reste à essayer à la main).
 */
test('balise : association, repère, éloignement, alerte, incident compris avec l’assistant, question, preuve, mode simulé, arrêt', async ({ page, browser }) => {
  expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } })).ok()).toBeTruthy();
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Balises' });
  const talk = page.getByRole('complementary', { name: 'Parler à mon élevage' });
  await expect(panel).toContainText('Aucun appareil suivi, aucune balise associée. Rien n’est mesuré pour l’instant.');
  // Ce navigateur de test n'a pas l'autorisation de position : il n'est pas suivi, et le dit en une ligne.
  await expect(page.getByRole('region', { name: 'Suivi de cet appareil' })).toContainText('n’est pas suivi comme balise');

  // Association à un animal : lien à ouvrir sur le téléphone, avec l'avertissement « localhost » quand il s'applique.
  await panel.getByRole('button', { name: 'Associer une balise' }).click();
  await panel.getByLabel('Animal associé (facultatif)').fill('X-999');
  await panel.getByRole('button', { name: 'Créer le lien de la balise' }).click();
  await expect(panel.getByRole('alert')).toContainText('Animal inconnu dans votre périmètre');
  await panel.getByLabel('Animal associé (facultatif)').fill('b-071');
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

  // L'écran de l'éleveur suit la balise, sans alerte tant qu'elle est dans la zone. La vue « zone » la place à sa distance.
  // Suivi GPS : le téléphone transmet sa position par rapport au repère, la carte montre donc de vraies directions.
  const map = page.getByRole('region', { name: 'Suivi GPS autour du repère' });
  await expect(map).toBeVisible({ timeout: 15_000 });
  await expect(map).toContainText('Le nord est en haut');
  await expect(map).toContainText('Aucune coordonnée géographique n’est transmise');
  await expect(panel).toContainText('Dans la zone', { timeout: 15_000 });
  await expect(panel).toContainText('GPS du téléphone');
  await expect(page.getByRole('alert').filter({ hasText: 'hors de sa zone' })).toHaveCount(0);

  // Le téléphone s'éloigne d'environ 100 m : alerte dans l'application.
  // Il part en trois étapes (un peu vers l'est, puis plein nord) : la trajectoire reçue se dessine point par point.
  for (const [dLat, dLon] of [
    [0.0003, 0.0002],
    [0.0006, 0.0002],
  ] as const) {
    await phoneCtx.setGeolocation({ latitude: home.latitude + dLat, longitude: home.longitude + dLon, accuracy: 5 });
    await phone.waitForTimeout(3600);
  }
  await phoneCtx.setGeolocation({ latitude: home.latitude + 0.0009, longitude: home.longitude, accuracy: 5 });
  await expect(phone.getByRole('region', { name: 'État enregistré par le serveur' })).toContainText('Hors de la zone', { timeout: 20_000 });
  const alert = page.getByRole('alert').filter({ hasText: 'hors de sa zone' });
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(alert).toContainText(id);
  await expect(alert).toContainText('associée à B-071');
  await expect(alert).toContainText('pour un seuil de 30 m');
  // Le téléphone est parti vers le nord (latitude croissante) : la direction est dite, et la trajectoire est tracée.
  await expect(alert).toContainText('vers le nord');
  await expect(map).toContainText(/100 m au nord/);
  await expect.poll(async () => await map.locator('polyline').count(), { timeout: 15_000 }).toBeGreaterThan(0);
  const track = (await (await page.request.get('/api/farm/devices', { headers: { 'x-demo-user': 'U-ELEVEUR' } })).json()).data.beacons[0].track as { eastM: number; northM: number }[];
  expect(track.length).toBeGreaterThan(1);
  expect(Math.abs(track.at(-1)!.eastM)).toBeLessThan(3);
  expect(track.at(-1)!.northM).toBeGreaterThan(95);
  // Les étapes intermédiaires sont dans la trajectoire : un passage à une vingtaine de mètres vers l'est.
  expect(track.some((t) => t.eastM > 15 && t.northM > 25 && t.northM < 80)).toBe(true);
  await map.scrollIntoViewIfNeeded();
  await map.screenshot({ path: 'test-results/suivi-gps.png' });
  await expect(alert).toContainText('La balise mesure sa propre distance, pas la position de l’animal');
  await page.screenshot({ path: 'test-results/balise-alerte.png' });
  await phone.screenshot({ path: 'test-results/balise-telephone.png', fullPage: true });

  // « Comprendre avec Sentinelle » : l'assistant s'ouvre sur l'incident enregistré et en affiche tout de suite la synthèse,
  // lue dans les données, sans demander à l'utilisateur de raconter ce qui s'est passé.
  await alert.getByRole('button', { name: 'Comprendre avec Sentinelle' }).click();
  await expect(page).toHaveURL(/#\/elevage\/incident\/INC-[0-9A-F]{5}$/);
  const incidentId = /INC-[0-9A-F]{5}/.exec(page.url())![0];
  const synth = talk.getByRole('article').first();
  await expect(synth).toContainText(`Incident ${incidentId} : la balise de démonstration ${id}, associée à B-071, a été mesurée hors de sa zone`);
  await expect(synth).toContainText('Mesure qui a ouvert l’incident');
  await expect(synth).toContainText('pour un seuil de 30 m. Source : GPS du téléphone');
  await expect(synth).toContainText('Incident toujours ouvert');
  await expect(synth).toContainText('État actuel.');
  await expect(synth).toContainText('sans IA');
  await expect(synth.getByRole('button', { name: 'Écouter et discuter' })).toBeVisible();
  await page.screenshot({ path: 'test-results/incident-synthese.png' });
  // La preuve de l'incident : l'enregistrement conservé, avec sa règle.
  await synth.getByRole('button', { name: `Incident ${incidentId}` }).first().click();
  const proof = page.getByRole('dialog');
  await expect(proof).toContainText('Hors de la zone si la distance mesurée dépasse le seuil même en retirant la précision annoncée.');
  await expect(proof).toContainText('ouvert');
  await proof.getByRole('button', { name: 'Fermer' }).click();
  // Une seule alerte pour l'épisode : les mesures suivantes n'en créent pas d'autre.
  const incidents = (await (await page.request.get('/api/farm/devices', { headers: { 'x-demo-user': 'U-ELEVEUR' } })).json()).data.incidents as { id: string }[];
  expect(incidents.map((i) => i.id)).toEqual([incidentId]);

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

  // L'incident est terminé : il reste proposé sous une forme calme, et sa relecture donne l'état ACTUEL, pas celui de l'alerte.
  const closed = page.getByRole('status').filter({ hasText: 'Incident terminé' });
  await expect(closed).toContainText('n’est plus mesurée hors de sa zone depuis', { timeout: 20_000 });
  await closed.getByRole('button', { name: 'Comprendre avec Sentinelle' }).click();
  const again = talk.getByRole('article').first();
  await expect(again).toContainText('la balise a de nouveau été mesurée dans la zone');
  await expect(again).toContainText(/État actuel\. .*dans la zone\. 5 m du repère/);
  await expect(again).toContainText('DONNÉES SIMULÉES');

  // Lien direct vers l'incident, ouvert dans un navigateur neuf : la destination est gardée après l'ouverture de session,
  // et la synthèse s'affiche sans aucun clic ni lecture audio automatique.
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const direct = await fresh.newPage();
  await direct.goto(`/#/elevage/incident/${incidentId}`);
  const arrival = direct.getByRole('complementary', { name: 'Parler à mon élevage' }).getByRole('article').first();
  await expect(arrival).toContainText(`Incident ${incidentId}`, { timeout: 15_000 });
  await expect(arrival).toContainText('État actuel.');
  await expect(arrival.getByRole('button', { name: 'Écouter et discuter' })).toBeVisible();
  await expect(direct).toHaveURL(new RegExp(`#/elevage/incident/${incidentId}$`));
  await direct.goto('/#/elevage/incident/INC-00000');
  await direct.reload();
  await expect(direct.getByRole('complementary', { name: 'Parler à mon élevage' }).getByRole('alert')).toContainText('Aucun incident « INC-00000 » n’est enregistré dans votre périmètre.');
  await fresh.close();

  // Arrêt depuis l'écran de l'éleveur : la balise n'envoie plus rien et le téléphone le dit.
  await panel.getByRole('button', { name: 'Arrêter' }).click();
  await expect(panel).toContainText('Arrêtée', { timeout: 15_000 });
  await expect(phone.getByText('Cette balise a été arrêtée')).toBeVisible({ timeout: 15_000 });
  await phoneCtx.close();

  // Un lien de balise invalide le dit, sans rien exposer.
  await page.goto('/#/balise/BAL-0000/jeton-invalide');
  await expect(page.getByRole('alert')).toContainText('Cette balise est inconnue ou son lien n’est plus valable');
});
