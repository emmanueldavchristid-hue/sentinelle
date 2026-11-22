import { expect, test } from '@playwright/test';

/**
 * Conversation en direct : brouillon dicté, interruption, confirmation, fermeture, réouverture. VRAIS appels à l'API Live,
 * FAUX microphone (Chrome joue e2e/fixtures/dictee-b017.wav, une voix de synthèse). À la demande :
 *
 *   DIRECT=1 PW_CHANNEL=chrome pnpm --filter @sentinelle/web exec playwright test --project=direct
 */
test.skip(process.env.DIRECT !== '1', 'Conversation en direct à la demande : définir DIRECT=1 (appels réels à l’API Live)');
test.setTimeout(180_000);

const liveFrames = (page: import('@playwright/test').Page) => {
  const got: { type: string; [k: string]: unknown }[] = [];
  const sent: { type: string; [k: string]: unknown }[] = [];
  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/api/assistant/live')) return;
    ws.on('framereceived', (f) => typeof f.payload === 'string' && got.push(JSON.parse(f.payload)));
    ws.on('framesent', (f) => typeof f.payload === 'string' && sent.push(JSON.parse(f.payload)));
  });
  return { got, sent };
};

test('direct : brouillon dicté, interruption, confirmation au bouton rapportée à l’assistant, micro libéré, réouverture', async ({ page }) => {
  test.skip(process.env.GEMINI_LIVE_MODEL === 'modele-inexistant', 'Réservé au vrai modèle');
  expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } })).ok()).toBeTruthy();
  // Garde la trace des flux du micro ouverts par la page, pour vérifier qu'ils sont bien refermés.
  await page.addInitScript(() => {
    const w = window as unknown as { __streams: MediaStream[] };
    w.__streams = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await original(c);
      w.__streams.push(s);
      return s;
    };
  });
  const micState = () => page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.map((s) => s.getTracks().every((t) => t.readyState === 'ended')));
  const { got, sent } = liveFrames(page);
  await page.goto('/');
  const talk = page.getByRole('complementary', { name: 'Parler à mon élevage' });
  const count = async () => (await (await page.request.get('/api/farm/changes', { headers: { 'x-demo-user': 'U-ELEVEUR' } })).json()).data.counts.total as number;
  const before = await count();

  await talk.getByRole('button', { name: 'Parler' }).click();
  await expect(talk.getByText('Microphone actif.')).toBeVisible({ timeout: 20_000 });

  // La phrase dictée devient un brouillon : le modèle a appelé la fonction, rien n'est enregistré.
  const first = talk.getByRole('article').first();
  await expect(first).toContainText(/B[\s-]?0?17/i, { timeout: 40_000 });
  await expect(first.locator('.v-big-ok')).toBeVisible({ timeout: 40_000 });
  expect(await count()).toBe(before);
  const draft = got.find((m) => m.type === 'result') as unknown as { result: { tool: string }; draft?: { id: string } };
  expect(draft.result.tool).toBe('prepare_observation');
  expect(draft.draft?.id).toBeTruthy();

  // 9. Pendant la lecture du brouillon : « Interrompre » rend la parole tout de suite.
  await expect(talk.getByText('Je réponds')).toBeVisible({ timeout: 30_000 });
  await talk.getByRole('button', { name: 'Interrompre' }).click();
  await expect(talk.getByText('Je vous écoute')).toBeVisible({ timeout: 2_000 });
  await expect(talk.getByRole('button', { name: 'Interrompre' })).toHaveCount(0);
  const saidBefore = got.filter((m) => m.type === 'said').length;
  expect(
    got
      .filter((m) => m.type === 'said')
      .map((m) => m.text)
      .join(''),
  ).toMatch(/Brouillon préparé/i);

  // Confirmation au bouton vert : chemin d'écriture habituel, reçu du serveur, puis l'assistant en est informé et le dit.
  await first.locator('.v-big-ok').click();
  await expect(first.getByText('Reçu par le serveur')).toBeVisible({ timeout: 20_000 });
  expect(await count()).toBe(before + 1);
  await expect.poll(() => sent.some((m) => m.type === 'screen' && m.event === 'RECEIVED'), { timeout: 10_000 }).toBe(true);
  await expect
    .poll(
      () =>
        got
          .filter((m) => m.type === 'said')
          .slice(saidBefore)
          .map((m) => m.text)
          .join(''),
      { timeout: 40_000 },
    )
    .toMatch(/enregistr/i);
  // Aucune demande de confirmation à la voix n'a circulé : une seule écriture, celle du bouton.
  expect(got.filter((m) => m.type === 'confirm_request')).toHaveLength(0);

  // 10. Fermeture : l'écran le dit et le micro est réellement libéré.
  await talk.getByRole('button', { name: 'Arrêter la conversation' }).click();
  await expect(talk.getByText('Conversation arrêtée. Le micro est fermé.')).toBeVisible();
  expect(await micState()).toEqual([true]);

  // 11. Reprise : une nouvelle conversation s'ouvre sur le même écran, puis se referme.
  await talk.getByRole('button', { name: 'Parler' }).click();
  await expect(talk.getByText('Microphone actif.')).toBeVisible({ timeout: 20_000 });
  await talk.getByRole('button', { name: 'Arrêter la conversation' }).click();
  await expect(talk.getByText('Conversation arrêtée. Le micro est fermé.')).toBeVisible();
  expect(await micState()).toEqual([true, true]);
  expect(await count()).toBe(before + 1);
});

test('direct : fournisseur en échec à l’ouverture, l’écran le dit et repasse à la dictée', async ({ page }) => {
  // À lancer avec un modèle volontairement inconnu : GEMINI_LIVE_MODEL=modele-inexistant DIRECT=1 ...
  test.skip(process.env.GEMINI_LIVE_MODEL !== 'modele-inexistant', 'Réservé à l’essai de panne (GEMINI_LIVE_MODEL=modele-inexistant)');
  const { got } = liveFrames(page);
  await page.goto('/');
  const talk = page.getByRole('complementary', { name: 'Parler à mon élevage' });
  await talk.getByRole('button', { name: 'Parler' }).click();
  await expect(talk.getByText(/La conversation en direct n’a pas pu s’ouvrir/)).toBeVisible({ timeout: 30_000 });
  await expect(talk.getByText('Le bouton ci-dessous dicte une phrase à la fois.')).toBeVisible();
  // Les modes de secours restent là : dictée d'une phrase, et texte.
  await expect(talk.getByRole('button', { name: 'Parler' })).toBeEnabled();
  await expect(talk.getByRole('button', { name: 'Discussion : non' })).toBeVisible();
  await expect(talk.getByLabel('Votre question ou votre observation')).toBeVisible();
  expect(JSON.stringify(got)).not.toMatch(/not found|v1beta|AIza/i);
});
