import { expect, test } from '@playwright/test';

/**
 * « Écouter et discuter » depuis un incident d'éloignement : l'assistant en direct relit lui-même l'incident et le résume à la
 * voix, sans que l'utilisateur ait à le raconter. VRAIS appels à l'API Live ; le faux microphone ne joue que du silence
 * (e2e/fixtures/silence.wav) et la balise transmet une distance SIMULÉE par l'API. À la demande :
 *
 *   DIRECT=1 PW_CHANNEL=chrome pnpm --filter @sentinelle/web exec playwright test --project=direct-incident
 */
test.skip(process.env.DIRECT !== '1' || process.env.GEMINI_LIVE_MODEL === 'modele-inexistant', 'Conversation en direct à la demande : définir DIRECT=1 (appels réels à l’API Live)');
test.setTimeout(150_000);

test('direct : depuis l’alerte, l’assistant relit l’incident enregistré et le résume à la voix', async ({ page }) => {
  const FARMER = { 'x-demo-user': 'U-ELEVEUR' };
  expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } })).ok()).toBeTruthy();
  const { id, token } = await (await page.request.post('/api/farm/devices', { headers: FARMER, data: { label: 'Poulet A', animalId: 'B-071', radiusM: 20 } })).json();
  expect((await page.request.post(`/api/devices/${id}/readings`, { headers: { 'x-device-token': token }, data: { source: 'SIMULATED', observedAt: new Date().toISOString(), distanceM: 55, accuracyM: null } })).status()).toBe(201);

  const got: { type: string; [k: string]: unknown }[] = [];
  const sent: { type: string; [k: string]: unknown }[] = [];
  let audioIn = 0;
  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/api/assistant/live')) return;
    ws.on('framereceived', (f) => (typeof f.payload === 'string' ? got.push(JSON.parse(f.payload)) : (audioIn += f.payload.length)));
    ws.on('framesent', (f) => typeof f.payload === 'string' && sent.push(JSON.parse(f.payload)));
  });

  // L'alerte mène à l'incident : la synthèse est là tout de suite, lue dans les données.
  await page.goto('/');
  const alert = page.getByRole('alert').filter({ hasText: 'hors de sa zone' });
  await expect(alert).toContainText('données simulées', { timeout: 15_000 });
  await alert.getByRole('button', { name: 'Comprendre avec Sentinelle' }).click();
  const talk = page.getByRole('complementary', { name: 'Parler à mon élevage' });
  const synth = talk.getByRole('article').first();
  await expect(synth).toContainText('Poulet A');
  const incidentId = /INC-[0-9A-F]{5}/.exec(page.url())![0];

  // « Écouter et discuter » : la conversation s'ouvre sur cet incident, et l'assistant commence par le résumer.
  await synth.getByRole('button', { name: 'Écouter et discuter' }).click();
  await expect(talk.getByTestId('live-talk')).toHaveAttribute('aria-label', 'Arrêter la conversation', { timeout: 20_000 });
  expect(sent.find((m) => m.type === 'start')).toMatchObject({ contextIncidentId: incidentId, speakIncident: true });
  await expect.poll(() => got.some((m) => m.type === 'result'), { timeout: 40_000 }).toBe(true);
  const result = got.find((m) => m.type === 'result')!.result as { tool: string; params: { incidentId: string } };
  expect(result.tool).toBe('incident');
  expect(result.params.incidentId).toBe(incidentId);
  await expect.poll(() => audioIn, { timeout: 40_000 }).toBeGreaterThan(40_000);
  await expect.poll(() => got.filter((m) => m.type === 'turn_complete').length, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(talk.getByText('Je vous écoute')).toBeVisible({ timeout: 40_000 });
  const said = got
    .filter((m) => m.type === 'said')
    .map((m) => m.text)
    .join('');
  console.log(`[dit] « ${said.trim()} »`);
  // Le résumé parle bien de cette balise et de sa mesure, sans parler d'évasion de l'animal.
  expect(said).toMatch(/balise/i);
  expect(said).toMatch(/Poulet A|B-071|B zéro soixante/i);
  expect(said).toMatch(/55|cinquante-cinq/i);
  expect(said).not.toMatch(/évad|enfui|échapp/i);
  const turn = talk.getByRole('article').first();
  await expect(turn).toContainText(`Écouter l’incident ${incidentId}`);
  await expect(turn).toContainText('Dit en direct par l’IA (transcription automatique)');

  await talk.getByRole('button', { name: 'Arrêter la conversation' }).click();
  await expect(talk.getByText('Conversation arrêtée. Le micro est fermé.')).toBeVisible();
});
