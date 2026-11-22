import { expect, test } from '@playwright/test';
import type { BaouleReply } from '@sentinelle/contracts';

/**
 * Note vocale en baoulé, de bout en bout dans Chrome, avec le VRAI service local de parole (modèles ouverts sur ce poste) et
 * un FAUX microphone : Chrome joue une fois e2e/fixtures/question-baoule-nouveautes.wav, une question prononcée par la voix de
 * synthèse baoulé (« Ngue like uflɛ yɛ ɔ juli ? »), pas par une personne.
 * À la demande uniquement : il faut que tools/baoule/serveur.py soit lancé.
 *
 *   BAOULE=1 PW_CHANNEL=chrome pnpm --filter @sentinelle/web exec playwright test --project=baoule
 *
 * Ce test vérifie la chaîne et la cohérence de l'écran avec ce que le serveur a répondu. Il ne prouve ni que le baoulé est
 * juste, ni qu'une vraie voix sera reconnue : le modèle d'écoute ne retrouve pas toujours une question aussi courte, et le
 * test accepte donc les deux issues (reconnue, non reconnue) pourvu que l'écran dise exactement ce qui s'est passé.
 */
test.skip(process.env.BAOULE !== '1', 'Test de la voix en baoulé à la demande : définir BAOULE=1 (service local de parole lancé)');
test.setTimeout(240_000);
test.use({ storageState: { cookies: [], origins: [] } });

test('baoulé : une note vocale, une réponse dite en baoulé, les faits affichés en français', async ({ page }) => {
  expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } })).ok()).toBeTruthy();
  await page.goto('/');
  const talk = page.getByRole('complementary', { name: 'Parler à mon élevage' });
  const zone = talk.getByRole('region', { name: /Parler en baoulé/ });
  await expect(zone).toBeVisible({ timeout: 30_000 });
  // L'interface reste en français, et les limites de cette voix sont toujours écrites.
  await expect(page.getByRole('heading', { level: 1, name: 'Mon élevage aujourd’hui' })).toBeVisible();
  await expect(zone.getByRole('note', { name: 'Limites de la voix en baoulé' })).toContainText(/premier jet, pas encore validé par un locuteur|validées par un locuteur/);
  await expect(zone.getByRole('note', { name: 'Limites de la voix en baoulé' })).toContainText('la réponse écrite, en français, fait foi');

  const answered = page.waitForResponse((r) => r.url().endsWith('/api/assistant/baoule'), { timeout: 200_000 });
  const t0 = Date.now();
  await zone.getByRole('button', { name: 'Parler en baoulé' }).click();
  await expect(zone.getByText('Microphone actif.')).toBeVisible({ timeout: 15_000 });
  const res = await answered;
  expect(res.status()).toBe(200);
  const r = (await res.json()) as BaouleReply;
  console.log(`[baoulé] entendu « ${r.heard} » → ${r.intent} (${r.score}) ; écoute ${(r.listenMs / 1000).toFixed(1)} s, voix ${(r.speakMs / 1000).toFixed(1)} s, total depuis l’appui ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // Quelque chose a été entendu, une réponse a été composée et réellement prononcée.
  expect(r.heard.length).toBeGreaterThan(2);
  expect(r.audio && r.audio.length).toBeGreaterThan(20_000);
  expect(r.spoken).not.toMatch(/\d/);

  const last = zone.getByRole('status', { name: 'Dernière note vocale en baoulé' });
  await expect(last).toContainText(`« ${r.heard} »`);
  await expect(last).toContainText(`« ${r.spoken} »`);
  await expect(last).toContainText(r.spokenFr);
  await expect(last.getByRole('button', { name: /Réécouter la réponse en baoulé|Arrêter/ })).toBeVisible();
  const exchange = talk.getByRole('article').first();
  await expect(exchange).toContainText('Note vocale en baoulé (transcription automatique)');

  if (r.intent === 'unknown') {
    // Rien n'est deviné : aucune lecture de données, et l'écran le dit.
    expect(r.reply.results).toEqual([]);
    await expect(last).toContainText('Question non reconnue : aucune donnée lue, rien n’est deviné.');
  } else {
    // La question retenue est dite, et le chiffre annoncé est celui de la lecture affichée.
    await expect(last).toContainText(`Question retenue : ${r.question}`);
    expect(r.reply.results.length).toBeGreaterThan(0);
    if (r.intent === 'changes') {
      const total = (await (await page.request.get('/api/farm/changes', { headers: { 'x-demo-user': 'U-ELEVEUR' } })).json()).data.counts.total as number;
      expect(r.spokenFr).toContain(total > 0 ? `${total} nouvelles choses` : 'rien de nouveau');
    }
  }
});
