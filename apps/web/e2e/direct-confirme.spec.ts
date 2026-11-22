import { expect, test } from '@playwright/test';

/**
 * Parcours sans lecture ni toucher, en conversation en direct : la personne dicte une observation, écoute le brouillon, dit
 * « Je confirme ». VRAIS appels à l'API Live, FAUX microphone : Chrome joue e2e/fixtures/dictee-puis-confirme.wav (la dictée,
 * 24 secondes de silence, puis « Je confirme. », voix de synthèse). À la demande :
 *
 *   DIRECT=1 PW_CHANNEL=chrome pnpm --filter @sentinelle/web exec playwright test --project=direct-confirme
 */
test.skip(process.env.DIRECT !== '1' || process.env.GEMINI_LIVE_MODEL === 'modele-inexistant', 'Conversation en direct à la demande : définir DIRECT=1 (appels réels à l’API Live)');
test.setTimeout(180_000);

test('direct : « je confirme » dit à la voix enregistre le brouillon lu, une seule fois, et l’assistant annonce le reçu', async ({ page }) => {
  expect((await page.request.post('/api/demo/reset', { headers: { 'x-sentinelle-demo': 'reset' }, data: { withObservation: false } })).ok()).toBeTruthy();
  const got: { type: string; [k: string]: unknown }[] = [];
  const sent: { type: string; [k: string]: unknown }[] = [];
  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/api/assistant/live')) return;
    ws.on('framereceived', (f) => typeof f.payload === 'string' && got.push(JSON.parse(f.payload)));
    ws.on('framesent', (f) => typeof f.payload === 'string' && sent.push(JSON.parse(f.payload)));
  });
  // En cas d'échec, la trace des échanges (sans le son) dit ce que le modèle a entendu, dit et appelé.
  const t0 = Date.now();
  const trace: string[] = [];
  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/api/assistant/live')) return;
    const note = (dir: string) => (f: { payload: string | Buffer }) => {
      if (typeof f.payload !== 'string') return;
      const m = JSON.parse(f.payload) as { type: string; text?: string; result?: { tool: string }; state?: string; message?: string };
      trace.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${dir} ${m.type} ${m.text ?? m.result?.tool ?? m.state ?? m.message ?? ''}`);
    };
    ws.on('framereceived', note('<'));
    ws.on('framesent', note('>'));
  });
  test.info().annotations.push({ type: 'trace', description: 'voir la sortie en cas d’échec' });
  await page.goto('/');
  const talk = page.getByRole('complementary', { name: 'Parler à mon élevage' });
  const count = async () => (await (await page.request.get('/api/farm/changes', { headers: { 'x-demo-user': 'U-ELEVEUR' } })).json()).data.counts.total as number;
  const before = await count();

  // Un seul geste : ouvrir la conversation. Tout le reste se fait à la voix.
  await talk.getByRole('button', { name: 'Parler' }).click();
  await expect(talk.getByText('Microphone actif.')).toBeVisible({ timeout: 20_000 });
  await expect(talk.locator('.v-big-ok')).toBeVisible({ timeout: 40_000 });
  expect(await count()).toBe(before);
  const draft = got.find((m) => m.type === 'result' && (m.result as { tool: string }).tool === 'prepare_observation') as unknown as { draft: { id: string; fingerprint: string } };

  // « Je confirme » : le serveur vérifie la phrase entendue, puis charge l'écran d'enregistrer CE brouillon.
  await expect(talk.getByText('Reçu par le serveur'))
    .toBeVisible({ timeout: 90_000 })
    .catch((e) => {
      console.log(`[trace]\n${trace.join('\n')}`);
      throw e;
    });
  const requests = got.filter((m) => m.type === 'confirm_request');
  expect(requests).toHaveLength(1);
  expect(requests[0]!.draftId).toBe(draft.draft.id);
  expect(requests[0]!.fingerprint).toBe(draft.draft.fingerprint);
  expect(sent.filter((m) => m.type === 'confirm_result').map((m) => m.state)).toEqual(['RECEIVED']);
  expect(await count()).toBe(before + 1);

  // L'assistant annonce l'enregistrement après le reçu, pas avant.
  const heard = got
    .filter((m) => m.type === 'heard')
    .map((m) => m.text)
    .join(' ');
  expect(heard).toMatch(/confirme/i);
  await expect
    .poll(
      () =>
        got
          .slice(got.indexOf(requests[0]!))
          .filter((m) => m.type === 'said')
          .map((m) => m.text)
          .join(''),
      { timeout: 40_000 },
    )
    .toMatch(/enregistr/i);
  console.log(`[entendu] « ${heard.trim()} »`);

  await talk.getByRole('button', { name: 'Arrêter la conversation' }).click();
  await expect(talk.getByText('Conversation arrêtée. Le micro est fermé.')).toBeVisible();
  expect(await count()).toBe(before + 1);
});
