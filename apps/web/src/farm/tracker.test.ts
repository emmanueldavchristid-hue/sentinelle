import { describe, expect, it } from 'vitest';
import { ApiFailure, NetworkError } from '../api';
import { AutoTracker, deviceKind, MAX_FIX_AGE_MS, STALE_AFTER_MS, type Fix, type Identity, type TrackerEnv } from './tracker';

/** Faux serveur et faux stockage : on vérifie ce que le suivi envoie, quand, et avec quelle heure. */
function setup(storage = new Map<string, string>()) {
  const world = {
    now: 1_000_000,
    registered: 0,
    stopped: [] as string[],
    sent: [] as { id: string; at: number; latitude: number; sentAt: number }[],
    /** Réponse du faux serveur au prochain envoi. */
    next: 'accepted' as 'accepted' | 'too-fast' | Error,
    registerError: null as Error | null,
    storage,
  };
  const env: TrackerEnv = {
    now: () => world.now,
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v), removeItem: (k) => void storage.delete(k) },
    kind: () => 'PHONE',
    register: async () => {
      if (world.registerError) throw world.registerError;
      world.registered += 1;
      return { id: `BAL-000${world.registered}`, token: `jeton-${world.registered}`, label: `Téléphone ${world.registered}`, radiusM: 30 };
    },
    send: async (identity: Identity, fix: Fix) => {
      const answer = world.next;
      world.next = 'accepted';
      if (answer instanceof Error) throw answer;
      if (answer === 'accepted') world.sent.push({ id: identity.id, at: fix.at, latitude: fix.latitude, sentAt: world.now });
      return answer;
    },
    stop: async (identity) => {
      world.stopped.push(identity.id);
    },
  };
  const tracker = new AutoTracker(env);
  const fix = (latitude: number, at = world.now): Fix => ({ latitude, longitude: -4, accuracyM: 5, at });
  /** Laisse passer le temps, seconde par seconde, comme le fait le navigateur. */
  const pass = async (ms: number) => {
    for (let t = 0; t < ms; t += 1000) {
      world.now += 1000;
      tracker.tick();
      await settle();
    }
  };
  return { world, tracker, fix, pass };
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const refusal = (status: number, body: Record<string, unknown>) => new ApiFailure(status, { error: 'X', message: 'refus', ...body } as never);

describe('Suivi automatique de l’appareil : ce qui part, quand, avec quelle heure', () => {
  it('rien n’est créé sans position : l’appareil ne s’enregistre qu’à sa première position', async () => {
    const { world, tracker, fix, pass } = setup();
    tracker.start();
    expect(tracker.getState().phase).toBe('waiting');
    await pass(5000);
    expect(world.registered).toBe(0);
    expect(world.sent).toEqual([]);
    tracker.onGeoError(1);
    expect(tracker.getState().phase).toBe('denied');
    await pass(5000);
    expect(world.registered).toBe(0);
    // La position finit par arriver (autorisation accordée) : enregistrement, puis envoi.
    tracker.onFix(fix(5.36));
    await settle();
    expect(world.registered).toBe(1);
    expect(world.sent).toHaveLength(1);
    expect(tracker.getState()).toMatchObject({ phase: 'tracking', label: 'Téléphone 1', lastAccuracyM: 5 });
  });

  it('jamais deux fois la même position : sans nouvelle position, rien ne part, et l’appareil est dit muet', async () => {
    const { world, tracker, fix, pass } = setup();
    tracker.start();
    const first = world.now;
    tracker.onFix(fix(5.36));
    await settle();
    expect(world.sent).toHaveLength(1);
    await pass(STALE_AFTER_MS + 5000);
    expect(world.sent).toHaveLength(1);
    expect(tracker.getState()).toMatchObject({ phase: 'tracking', stale: true, lastSentAt: first });
    // La même position livrée une seconde fois par le navigateur (même instant) ne repart pas non plus.
    tracker.onFix(fix(5.36, first));
    await pass(3000);
    expect(world.sent).toHaveLength(1);
    // Une nouvelle position : elle part, avec son propre instant, et l'appareil n'est plus muet.
    tracker.onFix(fix(5.3601));
    await settle();
    expect(world.sent).toHaveLength(2);
    expect(world.sent[1]!.at).toBe(world.now);
    expect(tracker.getState().stale).toBe(false);
  });

  it('chaque nouvelle position part avec l’instant où elle a été obtenue ; une par seconde au plus, la plus récente d’abord', async () => {
    const { world, tracker, fix, pass } = setup();
    tracker.start();
    tracker.onFix(fix(1));
    await settle();
    // Trois positions dans la même seconde : le serveur n'en accepte qu'une par seconde, c'est la plus récente qui part.
    world.now += 200;
    tracker.onFix(fix(2));
    world.now += 200;
    tracker.onFix(fix(3));
    world.now += 200;
    const third = world.now;
    tracker.onFix(fix(4));
    await settle();
    expect(world.sent.map((s) => s.latitude)).toEqual([1]);
    await pass(1000);
    expect(world.sent.map((s) => s.latitude)).toEqual([1, 4]);
    expect(world.sent[1]!.at).toBe(third);
    expect(world.sent[1]!.sentAt).toBeGreaterThan(third);
    // Un appareil en mouvement, une position par seconde : toutes partent, aucune n'est retenue.
    for (let i = 0; i < 5; i++) {
      world.now += 1000;
      tracker.onFix(fix(10 + i));
      await settle();
    }
    expect(world.sent.map((s) => s.latitude)).toEqual([1, 4, 10, 11, 12, 13, 14]);
    expect(world.sent.every((s, i, all) => i === 0 || s.at > all[i - 1]!.at)).toBe(true);
  });

  it('position ignorée par le serveur ou réseau coupé : elle repart telle quelle, avec son instant d’origine ; trop ancienne, elle ne part plus', async () => {
    const { world, tracker, fix, pass } = setup();
    tracker.start();
    tracker.onFix(fix(1));
    await settle();
    world.now += 1000;
    const observed = world.now;
    world.next = 'too-fast';
    tracker.onFix(fix(2));
    await settle();
    expect(world.sent).toHaveLength(1);
    await pass(1000);
    expect(world.sent[1]).toMatchObject({ latitude: 2, at: observed });
    // Réseau coupé : le bandeau le dit, et la position repart quand le réseau revient, si elle est encore récente.
    world.now += 1000;
    const cut = world.now;
    world.next = new NetworkError();
    tracker.onFix(fix(3));
    await settle();
    expect(tracker.getState().sendError).toMatch(/serveur injoignable/);
    await pass(2000);
    expect(world.sent[2]).toMatchObject({ latitude: 3, at: cut });
    expect(tracker.getState().sendError).toBeNull();
    // Coupure longue : la position est trop ancienne pour dire où est l'appareil, elle n'est jamais envoyée.
    world.now += 1000;
    world.next = new NetworkError();
    tracker.onFix(fix(4));
    await settle();
    world.next = new NetworkError();
    world.now += MAX_FIX_AGE_MS + 1000;
    tracker.tick();
    await settle();
    await pass(5000);
    expect(world.sent.map((s) => s.latitude)).toEqual([1, 2, 3]);
  });

  it('identité gardée dans le navigateur : réutilisée à la réouverture, sans nouvel enregistrement', async () => {
    const first = setup();
    first.tracker.start();
    first.tracker.onFix(first.fix(1));
    await settle();
    expect(first.world.registered).toBe(1);
    const again = setup(first.world.storage);
    again.tracker.start();
    // Le nom est affiché dès l'ouverture, avant même la première position.
    expect(again.tracker.getState()).toMatchObject({ phase: 'waiting', label: 'Téléphone 1' });
    again.tracker.onFix(again.fix(2));
    await settle();
    expect(again.world.registered).toBe(0);
    expect(again.world.sent[0]).toMatchObject({ id: 'BAL-0001', latitude: 2 });
  });

  it('appareil inconnu du serveur (démonstration réinitialisée) : réenregistré, sans boucle', async () => {
    const { world, tracker, fix, pass } = setup();
    tracker.start();
    tracker.onFix(fix(1));
    await settle();
    world.now += 1000;
    world.next = refusal(401, {});
    tracker.onFix(fix(2));
    await settle();
    expect(tracker.getState()).toMatchObject({ phase: 'waiting', label: null });
    await pass(1000);
    expect(world.registered).toBe(2);
    expect(world.sent.at(-1)).toMatchObject({ id: 'BAL-0002', latitude: 2 });
    // Le serveur refuse encore et encore : on n'enchaîne pas les enregistrements.
    for (let i = 0; i < 12; i++) {
      world.now += 1000;
      world.next = refusal(401, {});
      tracker.onFix(fix(10 + i));
      tracker.tick();
      await settle();
    }
    expect(world.registered).toBeLessThanOrEqual(5);
    expect(tracker.getState().sendError).toMatch(/ne reconnaît pas cet appareil/);
    expect(world.registered).toBeGreaterThanOrEqual(2);
  });

  it('balise arrêtée depuis l’écran de l’éleveur : elle n’est pas recréée, même après rechargement ; « Reprendre le suivi » en crée une nouvelle', async () => {
    const { world, tracker, fix, pass } = setup();
    tracker.start();
    tracker.onFix(fix(1));
    await settle();
    world.now += 1000;
    world.next = refusal(409, { reason: 'STOPPED' });
    tracker.onFix(fix(2));
    await settle();
    expect(tracker.getState().phase).toBe('stopped-remote');
    expect(tracker.wantsPositions()).toBe(false);
    tracker.onFix(fix(3));
    await pass(5000);
    expect(world.registered).toBe(1);
    expect(world.sent).toHaveLength(1);
    // Rechargement de la page : toujours arrêté, aucun appel au serveur.
    const reload = setup(world.storage);
    reload.tracker.start();
    expect(reload.tracker.getState().phase).toBe('stopped-remote');
    reload.tracker.onFix(reload.fix(4));
    await reload.pass(3000);
    expect(reload.world.registered).toBe(0);
    expect(reload.world.sent).toEqual([]);
    // Action explicite sur l'appareil : une nouvelle balise, à la prochaine position.
    reload.tracker.resume();
    expect(reload.tracker.getState().phase).toBe('waiting');
    expect(reload.world.registered).toBe(0);
    reload.tracker.onFix(reload.fix(5));
    await settle();
    expect(reload.world.registered).toBe(1);
    expect(reload.tracker.getState().phase).toBe('tracking');
  });

  it('« Arrêter le suivi » : la balise est arrêtée côté serveur, le refus est gardé, plus rien ne part', async () => {
    const { world, tracker, fix, pass } = setup();
    tracker.start();
    tracker.onFix(fix(1));
    await settle();
    await tracker.stopByUser();
    expect(world.stopped).toEqual(['BAL-0001']);
    expect(tracker.getState()).toMatchObject({ phase: 'stopped', label: null });
    expect(tracker.wantsPositions()).toBe(false);
    tracker.onFix(fix(2));
    await pass(3000);
    expect(world.sent).toHaveLength(1);
    const reload = setup(world.storage);
    reload.tracker.start();
    expect(reload.tracker.getState().phase).toBe('stopped');
    expect(reload.world.registered).toBe(0);
    // Une autre fenêtre du même navigateur s'aligne : arrêtée ici, arrêtée là.
    const other = setup(new Map());
    other.tracker.start();
    other.tracker.onFix(other.fix(1));
    await settle();
    other.world.storage.set('sentinelle.appareil.arret', 'ici');
    other.tracker.syncFromStorage();
    expect(other.tracker.getState().phase).toBe('stopped');
  });

  it('limite d’appareils atteinte, position hors https ou sans accès : dit en clair, sans rien envoyer', async () => {
    const { world, tracker, fix, pass } = setup();
    world.registerError = refusal(409, { reason: 'AUTO_LIMIT', message: '40 appareils sont déjà suivis automatiquement.' });
    tracker.start();
    tracker.onFix(fix(1));
    await settle();
    expect(tracker.getState()).toMatchObject({ phase: 'full', sendError: '40 appareils sont déjà suivis automatiquement.' });
    await pass(5000);
    expect(world.sent).toEqual([]);
    const blocked = setup();
    blocked.tracker.start('insecure');
    expect(blocked.tracker.getState().phase).toBe('insecure');
    blocked.tracker.onFix(blocked.fix(1));
    await settle();
    expect(blocked.world.registered).toBe(0);
  });

  it('téléphone, ordinateur, ou rien de sûr', () => {
    expect(deviceKind({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36' })).toBe('PHONE');
    expect(deviceKind({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' })).toBe('PHONE');
    expect(deviceKind({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' })).toBe('COMPUTER');
    expect(deviceKind({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', userAgentData: { mobile: false } })).toBe('COMPUTER');
    expect(deviceKind({ userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' })).toBeUndefined();
    expect(deviceKind({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15', maxTouchPoints: 5 })).toBeUndefined();
    expect(deviceKind({ userAgent: '' })).toBeUndefined();
  });
});
