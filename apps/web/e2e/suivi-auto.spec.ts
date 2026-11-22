import { devices, expect, test } from '@playwright/test';

/**
 * Suivi automatique de bout en bout, sans IA : deux navigateurs ouvrent simplement la page d'accueil, avec une position
 * ÉMULÉE par le navigateur de test (`setGeolocation`). Ce ne sont ni un vrai téléphone ni un vrai GPS : le verrou d'écran,
 * un vrai tunnel https et la cadence réelle d'un GPS restent à essayer à la main.
 * Le navigateur de test ne livre une position que lorsqu'on la change : entre deux changements, l'appareil émulé ne reçoit
 * AUCUNE nouvelle position, et l'application n'en invente pas (il finit par être dit muet). Un vrai GPS, lui, en livre en continu.
 */
test('suivi automatique : ouvrir le lien suffit, repère commun, déplacement suivi, bandeau de transparence, arrêt et reprise', async ({ page, browser }) => {
  test.setTimeout(150_000);
  expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } })).ok()).toBeTruthy();
  const farmer = { headers: { 'x-demo-user': 'U-ELEVEUR' } };
  const read = async () => (await page.request.get('/api/farm/devices', farmer)).text();

  // L'écran de l'éleveur. Son propre navigateur n'a pas l'autorisation de position : il le dit en une ligne, et ne crée aucune balise.
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Balises' });
  await expect(panel).toContainText('Tout appareil qui ouvre le lien de l’application et autorise sa position est suivi automatiquement comme balise');
  await expect(panel).toContainText('Repère commun : pas encore fixé. La première position reçue d’un appareil le fixera.');
  await expect(panel).toContainText('Aucun appareil suivi, aucune balise associée. Rien n’est mesuré pour l’instant.');
  await expect(page.getByRole('region', { name: 'Suivi de cet appareil' })).toContainText('n’est pas suivi comme balise');
  await expect(page.getByRole('region', { name: 'Suivi de cet appareil' }).getByRole('button', { name: 'Arrêter le suivi' })).toHaveCount(0);

  // Un « téléphone » (375 px, navigateur mobile) ouvre la page d'accueil. Aucune action : ni association, ni QR, ni bouton.
  const home = { latitude: 5.36, longitude: -4.0083, accuracy: 5 };
  const phoneCtx = await browser.newContext({ userAgent: devices['Pixel 7'].userAgent, isMobile: true, hasTouch: true, viewport: { width: 375, height: 800 }, permissions: ['geolocation'], geolocation: home });
  const phone = await phoneCtx.newPage();
  await phone.goto('/');
  const banner = phone.getByRole('region', { name: 'Suivi de cet appareil' });
  await expect(banner).toContainText('Cet appareil est suivi comme balise « Téléphone 1 » : sa position est envoyée au serveur de démonstration.', { timeout: 15_000 });
  await expect(banner.getByRole('button', { name: 'Arrêter le suivi' })).toBeVisible();
  await expect(phone.getByRole('heading', { level: 1, name: 'Mon élevage aujourd’hui' })).toBeVisible();
  // Le bandeau tient sur un téléphone de 375 px, reste visible quand on fait défiler, et ne masque pas la page.
  expect(await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await phone.evaluate(() => window.scrollTo(0, 1200));
  await expect(banner).toBeInViewport();
  expect((await banner.boundingBox())!.height).toBeLessThan(110);
  await phone.screenshot({ path: 'test-results/suivi-auto-telephone.png' });
  await phone.evaluate(() => window.scrollTo(0, 0));

  // Sur l'écran de l'éleveur, l'appareil est apparu tout seul : il a fixé le repère, il est donc à 0 m.
  const autos = panel.getByRole('list', { name: 'Appareils suivis automatiquement' });
  await expect(autos.getByRole('listitem')).toHaveCount(1, { timeout: 15_000 });
  const phoneRow = autos.getByRole('listitem').filter({ hasText: 'Téléphone 1' });
  await expect(phoneRow).toContainText('Dans la zone');
  await expect(phoneRow).toContainText('0 m du repère');
  await expect(phoneRow).toContainText('GPS du téléphone');
  await expect(phoneRow).toContainText(/reçue (à l’instant|il y a \d+ s)/);
  await expect(panel).toContainText(/Repère commun : fixé par Téléphone 1 le \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2} \(première position reçue\), précision de cette position : ± 5 m/);

  // Un « ordinateur » ouvre à son tour la page d'accueil, une dizaine de mètres à l'est : même repère, sans rien fixer.
  const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['geolocation'], geolocation: { latitude: home.latitude, longitude: home.longitude + 0.0001, accuracy: 5 } });
  const desk = await deskCtx.newPage();
  await desk.goto('/');
  const deskBanner = desk.getByRole('region', { name: 'Suivi de cet appareil' });
  await expect(deskBanner).toContainText('Cet appareil est suivi comme balise « Ordinateur 2 »', { timeout: 15_000 });
  await expect(deskBanner).toContainText(/Dernière position envoyée à \d{2}:\d{2}:\d{2} \(± 5 m\)/);
  await expect(autos.getByRole('listitem')).toHaveCount(2, { timeout: 15_000 });
  const deskRow = autos.getByRole('listitem').filter({ hasText: 'Ordinateur 2' });
  await expect(deskRow).toContainText('11 m du repère, vers l’est');
  // Un ordinateur n'a pas de GPS : sa mesure ne s'appelle pas « GPS du téléphone ».
  await expect(deskRow).toContainText('position du navigateur');
  await expect(deskRow).not.toContainText('GPS du téléphone');
  // La carte s'appelle « suivi GPS » parce qu'un téléphone transmet ; elle dit que le serveur calcule, et ne prétend pas que rien n'est transmis.
  const map = page.getByRole('region', { name: 'Suivi GPS autour du repère' });
  await expect(map).toContainText('calculée par le serveur à partir de la position que son navigateur envoie');
  await expect(map).toContainText('repère commun');
  await expect(map).not.toContainText('Aucune coordonnée géographique n’est transmise');
  await expect(map).toContainText('Ordinateur 2');

  // Le téléphone se déplace vers le nord, en quatre étapes : la distance affichée suit CHAQUE étape, sans rester figée.
  for (const [dLat, meters] of [
    [0.0002, 22],
    [0.0005, 56],
    [0.0007, 78],
    [0.0009, 100],
  ] as const) {
    const moved = Date.now();
    await phoneCtx.setGeolocation({ latitude: home.latitude + dLat, longitude: home.longitude, accuracy: 5 });
    await expect(phoneRow).toContainText(`${meters} m du repère, vers le nord`, { timeout: 8000 });
    // Envoi (une seconde au plus) puis relecture (deux secondes) : l'écran suit en quelques secondes.
    expect(Date.now() - moved).toBeLessThan(8000);
  }
  await expect(phoneRow).toContainText('Hors de la zone');
  const alert = page.getByRole('alert').filter({ hasText: 'hors de sa zone' });
  await expect(alert).toContainText('Téléphone 1');
  await expect(alert).toContainText('vers le nord');
  await expect(alert).toContainText('Sa distance est calculée par le serveur, à partir de la position envoyée par l’appareil et du repère commun.');
  await expect(map).toContainText(/100 m au nord/);
  await expect.poll(async () => await map.locator('polyline').count(), { timeout: 10_000 }).toBeGreaterThan(0);
  // La trajectoire reçue passe par les étapes, dans l'ordre, plein nord.
  const body = await read();
  const beacons = JSON.parse(body).data.beacons as { label: string; auto: boolean; track: { eastM: number; northM: number }[]; latest: { source: string } }[];
  const track = beacons.find((b) => b.label === 'Téléphone 1')!.track;
  expect(track.length).toBeGreaterThanOrEqual(5);
  expect(track[0]!.northM).toBeLessThan(1);
  expect(track.at(-1)!.northM).toBeGreaterThan(99);
  expect(track.every((t, i) => Math.abs(t.eastM) < 2 && (i === 0 || t.northM >= track[i - 1]!.northM))).toBe(true);
  for (const m of [22, 56, 78]) expect(track.some((t) => Math.abs(t.northM - m) < 1.5)).toBe(true);
  expect(beacons.find((b) => b.label === 'Ordinateur 2')!.latest.source).toBe('BROWSER_POSITION');
  // Aucune coordonnée ne revient du serveur : seulement des mètres par rapport au repère.
  expect(body).not.toMatch(/latitude|longitude|5\.36\d|4\.008\d/);
  await map.scrollIntoViewIfNeeded();
  await map.screenshot({ path: 'test-results/suivi-auto-carte.png' });
  await page.screenshot({ path: 'test-results/suivi-auto-eleveur.png', fullPage: true });

  // Pendant ce temps, l'ordinateur n'a reçu aucune nouvelle position de son navigateur : rien n'a été renvoyé pour le faire
  // vivre. Sa ligne dit l'ancienneté de sa dernière position (et « muette » passé vingt secondes), pas une heure rafraîchie.
  await expect(deskRow).toContainText(/reçue il y a \d+ s|muette depuis \d+ s/);
  const deskSeen = (JSON.parse(await read()).data.beacons as { label: string; latest: { observedAt: string; receivedAt: string } }[]).find((b) => b.label === 'Ordinateur 2')!.latest;
  expect(Date.now() - Date.parse(deskSeen.receivedAt)).toBeGreaterThan(5000);

  // « Placer le repère sur cet appareil » : confirmé d'un second clic. L'ordinateur passe à 0 m, le téléphone est mesuré depuis lui.
  await deskRow.getByRole('button', { name: /^Placer le repère sur cet appareil/ }).click();
  await deskRow.getByRole('button', { name: /^Confirmer/ }).click();
  await expect(panel).toContainText(/Repère commun : placé sur Ordinateur 2 le .* \(depuis cet écran\)/, { timeout: 10_000 });
  await expect(deskRow).toContainText('0 m du repère', { timeout: 15_000 });
  await expect(phoneRow).toContainText('101 m du repère, vers le nord', { timeout: 15_000 });
  // L'incident ouvert avec l'ancien repère est terminé pour ce motif ; l'ancienne trajectoire n'est plus dessinée depuis le nouveau repère.
  const after = JSON.parse(await read()).data as { incidents: { closeReason: string | null }[]; beacons: { label: string; track: { northM: number }[]; latest: { observedAt: string } }[] };
  expect(after.incidents.some((i) => i.closeReason === 'ANCHOR_MOVED')).toBe(true);
  expect(after.beacons.find((b) => b.label === 'Téléphone 1')!.track.every((t) => t.northM > 95)).toBe(true);
  // La dernière position de l'ordinateur est ré-exprimée par rapport au nouveau repère, avec son heure d'origine : rien n'est rajeuni.
  expect(after.beacons.find((b) => b.label === 'Ordinateur 2')!.latest.observedAt).toBe(deskSeen.observedAt);

  // « Arrêter le suivi » sur le téléphone : la balise est arrêtée côté serveur, le bandeau le dit, et rien n'est recréé au rechargement.
  await banner.getByRole('button', { name: 'Arrêter le suivi' }).click();
  await expect(banner).toContainText('Suivi arrêté sur cet appareil : sa position n’est plus envoyée.');
  await expect(phoneRow).toContainText('Arrêtée', { timeout: 10_000 });
  await phone.reload();
  await expect(banner).toContainText('Suivi arrêté sur cet appareil');
  await phoneCtx.setGeolocation({ latitude: home.latitude + 0.001, longitude: home.longitude, accuracy: 5 });
  await phone.waitForTimeout(3500);
  await expect(autos.getByRole('listitem')).toHaveCount(2);
  // « Reprendre le suivi » : action explicite, une nouvelle balise est créée à la position suivante.
  await banner.getByRole('button', { name: 'Reprendre le suivi' }).click();
  await expect(banner).toContainText('Cet appareil est suivi comme balise « Téléphone 3 »', { timeout: 15_000 });
  await expect(autos.getByRole('listitem')).toHaveCount(3, { timeout: 15_000 });

  // Arrêt depuis l'écran de l'éleveur : à sa position suivante, l'appareil l'apprend, le dit, et ne se réenregistre pas tout seul.
  await deskRow.getByRole('button', { name: 'Arrêter Ordinateur 2' }).click();
  await expect(deskRow).toContainText('Arrêtée', { timeout: 10_000 });
  await deskCtx.setGeolocation({ latitude: home.latitude + 0.00002, longitude: home.longitude + 0.0001, accuracy: 5 });
  await expect(deskBanner).toContainText('Le suivi de cet appareil a été arrêté depuis l’écran de l’éleveur', { timeout: 20_000 });
  await desk.reload();
  await expect(deskBanner).toContainText('a été arrêté depuis l’écran de l’éleveur');
  await deskCtx.setGeolocation({ latitude: home.latitude + 0.00004, longitude: home.longitude + 0.0001, accuracy: 5 });
  await desk.waitForTimeout(3000);
  await expect(autos.getByRole('listitem')).toHaveCount(3);

  // La page « balise » (association à la main) garde son propre parcours : pas de second suivi sur elle.
  await desk.goto('/#/balise/BAL-0000/jeton-invalide');
  await expect(desk.getByRole('alert')).toContainText('Cette balise est inconnue');
  await expect(desk.getByRole('region', { name: 'Suivi de cet appareil' })).toHaveCount(0);

  await phoneCtx.close();
  await deskCtx.close();
  expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } })).ok()).toBeTruthy();
});

test('dix appareils suivis : la vue de la zone reste lisible (points numérotés, liste numérotée)', async ({ page }) => {
  expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } })).ok()).toBeTruthy();
  // Dix appareils enregistrés et positionnés par l'API, comme le feraient dix navigateurs : positions de TEST, pas des mesures.
  const home = { latitude: 5.36, longitude: -4.0083 };
  for (let i = 0; i < 10; i++) {
    const d = (await (await page.request.post('/api/devices/auto', { data: { kind: i % 3 ? 'PHONE' : 'COMPUTER' } })).json()) as { id: string; token: string };
    const angle = (i * 2 * Math.PI) / 10;
    const meters = i === 0 ? 0 : 8 + i * 6;
    const r = await page.request.post(`/api/devices/${d.id}/position`, {
      headers: { 'x-device-token': d.token },
      data: { latitude: home.latitude + (meters * Math.cos(angle)) / 111_195, longitude: home.longitude + (meters * Math.sin(angle)) / 110_700, accuracyM: 4, observedAt: new Date().toISOString() },
    });
    expect(r.status()).toBe(201);
  }
  await page.goto('/');
  const map = page.getByRole('region', { name: 'Suivi GPS autour du repère' });
  await expect(map).toBeVisible({ timeout: 15_000 });
  const list = map.getByRole('list', { name: 'Balises autour du repère' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveCount(10);
  // Chaque appareil : son numéro sur le schéma, et dans la liste son nom, sa distance, son statut en toutes lettres, sa source.
  await expect(map.locator('svg .v-sky-mark')).toHaveCount(10);
  const item = (name: string) => list.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) });
  // Numéro (ordre d'arrivée), distance, nom, statut en toutes lettres, source : tout ce que le libellé du schéma portait.
  await expect(item('Ordinateur 1')).toHaveText(/^10 m\s*Ordinateur 1.*dans la zone · seuil 30 m · position du navigateur, ± 4 m/s);
  await expect(item('Téléphone 9')).toHaveText(/^956 m\s*Téléphone 9.*hors de la zone · seuil 30 m · GPS du téléphone, ± 4 m/s);
  await expect(item('Ordinateur 10')).toContainText('hors de la zone');
  // Les libellés ne se chevauchent plus autour des points : il n'y a plus de libellé de balise dans le schéma.
  // (Le nom reste dans l'info-bulle et le libellé accessible de chaque point.)
  await expect(map.locator('svg text').filter({ hasText: /Téléphone|Ordinateur/ })).toHaveCount(0);
  await expect(map.locator('svg .v-sky-mark text')).toHaveText(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  await expect(map.getByRole('button', { name: 'Balise Téléphone 9 : hors de la zone, 56 m du repère. Ouvrir la source.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  const panel = page.getByRole('region', { name: 'Balises' });
  await expect(panel.getByRole('list', { name: 'Appareils suivis automatiquement' }).getByRole('listitem')).toHaveCount(10);
  await map.scrollIntoViewIfNeeded();
  await map.screenshot({ path: 'test-results/suivi-auto-dix-appareils.png' });
  expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } })).ok()).toBeTruthy();
});
