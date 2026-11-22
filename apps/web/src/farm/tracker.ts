import type { AutoDevice } from '@sentinelle/contracts';
import { api, ApiFailure, NetworkError } from '../api';

/**
 * Suivi automatique de cet appareil comme balise (mode démonstration) : ouvrir le lien de l'application suffit.
 *
 * Règles de vérité, tenues ici :
 * - la demande d'autorisation de position du navigateur est le consentement : rien n'est envoyé sans elle, et un bandeau dit
 *   sur l'appareil qu'il est suivi, avec « Arrêter le suivi » ;
 * - la balise n'est créée qu'à la PREMIÈRE position obtenue : un appareil qui refuse ou n'a pas de position ne crée rien ;
 * - chaque position n'est envoyée qu'une fois, avec l'instant où le navigateur l'a obtenue. Une ancienne position n'est JAMAIS
 *   renvoyée avec une nouvelle heure pour « faire vivre » le point : sans nouvelle position, l'appareil est dit muet ;
 * - aucun filtre de précision ni arrondi ici : tout ce que le navigateur donne part tel quel, le serveur dit « incertain »
 *   quand la précision ne permet pas de trancher ;
 * - une balise arrêtée depuis l'écran de l'éleveur n'est pas recréée : il faut le demander sur l'appareil (« Reprendre le suivi »).
 */

/** Une position donnée par le navigateur. `at` : instant où il l'a obtenue (pas l'instant de l'envoi). */
export interface Fix {
  latitude: number;
  longitude: number;
  accuracyM: number;
  at: number;
}
export interface Identity {
  id: string;
  token: string;
  label: string;
}
export type DeviceKind = 'PHONE' | 'COMPUTER';

export type TrackerPhase =
  | 'off' // pas démarré (hors mode démonstration, ou page « balise »)
  | 'insecure' // page hors https : le navigateur ne donne pas la position
  | 'unsupported' // navigateur sans accès à la position
  | 'waiting' // autorisation ou première position attendue
  | 'denied' // position refusée dans le navigateur
  | 'unavailable' // pas de position pour l'instant
  | 'tracking' // au moins une position acceptée par le serveur
  | 'stopped' // « Arrêter le suivi » demandé sur cet appareil
  | 'stopped-remote' // balise arrêtée depuis l'écran de l'éleveur
  | 'full'; // le serveur suit déjà le nombre maximal d'appareils

export interface TrackerState {
  phase: TrackerPhase;
  /** Nom de la balise (« Téléphone 3 »), une fois l'appareil enregistré. */
  label: string | null;
  /** Instant (obtenu par le navigateur) de la dernière position acceptée par le serveur. */
  lastSentAt: number | null;
  lastAccuracyM: number | null;
  /** Vrai si aucune nouvelle position n'a été acceptée depuis un moment : l'appareil est dit muet côté serveur. */
  stale: boolean;
  /** Raison du dernier envoi impossible, en clair (ou, limite d'appareils atteinte, le message du serveur). */
  sendError: string | null;
}

export interface TrackerEnv {
  now(): number;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  kind(): DeviceKind | undefined;
  register(kind: DeviceKind | undefined): Promise<AutoDevice>;
  /** Envoie une position. « too-fast » : le serveur l'a ignorée (une mesure par seconde au plus), elle reste à envoyer. */
  send(identity: Identity, fix: Fix): Promise<'accepted' | 'too-fast'>;
  stop(identity: Identity): Promise<void>;
}

const IDENTITY_KEY = 'sentinelle.appareil';
/** « ici » : arrêt demandé sur cet appareil. « eleveur » : balise arrêtée depuis l'écran de l'éleveur. */
const STOP_KEY = 'sentinelle.appareil.arret';
/** Espacement minimal entre deux envois : le serveur n'accepte qu'une mesure par seconde. */
export const MIN_SPACING_MS = 1000;
/** Une position qui n'a pas pu partir n'est plus envoyée passé ce délai : elle ne dit plus où est l'appareil. */
export const MAX_FIX_AGE_MS = 15_000;
/** Au-delà, sans position acceptée, le bandeau dit que l'appareil est muet (même seuil que le serveur). */
export const STALE_AFTER_MS = 20_000;
/** Après un refus du serveur (limite atteinte, appareil inconnu à répétition), on attend avant de redemander. */
const HOLD_MS = 30_000;

/** Ce que le navigateur dit être : téléphone, ordinateur, ou rien de sûr (tablette). Sert au nom et à la source affichée. */
export function deviceKind(nav: { userAgent?: string; userAgentData?: { mobile?: boolean }; maxTouchPoints?: number }): DeviceKind | undefined {
  const ua = nav.userAgent ?? '';
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return undefined;
  if (nav.userAgentData?.mobile === true || /Android|iPhone|iPod|Windows Phone|Mobile/i.test(ua)) return 'PHONE';
  // Un iPad récent se présente comme un Mac : l'écran tactile le trahit.
  if (/Macintosh/i.test(ua) && (nav.maxTouchPoints ?? 0) > 1) return undefined;
  if (/Windows|Macintosh|Linux|CrOS|X11/i.test(ua)) return 'COMPUTER';
  return undefined;
}

export class AutoTracker {
  private identity: Identity | null = null;
  /** Dernière position obtenue. Elle n'est envoyée que si elle est plus récente que la dernière acceptée. */
  private latest: Fix | null = null;
  /** Instant de la dernière position réglée (acceptée, ou refusée pour de bon) : elle ne repartira pas. */
  private settledAt: number | null = null;
  private busy = false;
  private lastAttempt = Number.NEGATIVE_INFINITY;
  private holdUntil = 0;
  private unknownInARow = 0;
  private state: TrackerState = { phase: 'off', label: null, lastSentAt: null, lastAccuracyM: null, stale: false, sendError: null };
  private listeners = new Set<() => void>();

  constructor(private env: TrackerEnv) {}

  getState = (): TrackerState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(patch: Partial<TrackerState>) {
    const next = { ...this.state, ...patch };
    if ((Object.keys(next) as (keyof TrackerState)[]).every((k) => next[k] === this.state[k])) return;
    this.state = next;
    for (const fn of this.listeners) fn();
  }

  private read(key: string): string | null {
    try {
      return this.env.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  private write(key: string, value: string | null) {
    try {
      if (value === null) this.env.storage?.removeItem(key);
      else this.env.storage?.setItem(key, value);
    } catch {
      /* stockage indisponible : l'état vaut pour cette page seulement */
    }
  }
  private storedIdentity(): Identity | null {
    try {
      const v = JSON.parse(this.read(IDENTITY_KEY) ?? 'null') as Identity | null;
      return v && typeof v.id === 'string' && typeof v.token === 'string' && typeof v.label === 'string' ? v : null;
    } catch {
      return null;
    }
  }
  private forget() {
    this.identity = null;
    this.write(IDENTITY_KEY, null);
  }

  /** Vrai si le suivi veut des positions : l'écoute de la position et le verrou d'écran n'ont de sens que dans ce cas. */
  wantsPositions(): boolean {
    return this.state.phase === 'waiting' || this.state.phase === 'denied' || this.state.phase === 'unavailable' || this.state.phase === 'tracking' || this.state.phase === 'full';
  }

  /**
   * Démarre (ou reprend l'état gardé dans le navigateur). `blocked` : raison pour laquelle le navigateur ne donnera pas de position.
   * Aucun appel au serveur ici : l'appareil n'est enregistré qu'à sa première position.
   */
  start(blocked: 'insecure' | 'unsupported' | null = null) {
    this.identity = this.storedIdentity();
    const stop = this.read(STOP_KEY);
    this.latest = null;
    if (stop === 'ici' || stop === 'eleveur') {
      this.set({ phase: stop === 'ici' ? 'stopped' : 'stopped-remote', label: null, sendError: null, stale: false });
      // L'arrêt demandé ici n'a peut-être pas atteint le serveur (réseau coupé à ce moment) : on le redit.
      if (stop === 'ici' && this.identity) void this.tellStopped(this.identity);
      return;
    }
    if (blocked) return this.set({ phase: blocked, label: this.identity?.label ?? null });
    this.set({ phase: 'waiting', label: this.identity?.label ?? null, sendError: null, stale: false });
  }

  /** L'écoute s'arrête (changement de page vers « balise », démontage) : ce n'est pas un arrêt du suivi demandé par quelqu'un. */
  detach() {
    this.latest = null;
    this.set({ phase: 'off' });
  }

  /** Une autre fenêtre du même navigateur a arrêté ou repris le suivi, ou a enregistré l'appareil : on s'aligne. */
  syncFromStorage() {
    if (this.state.phase === 'off' || this.state.phase === 'insecure' || this.state.phase === 'unsupported') return;
    const stop = this.read(STOP_KEY);
    const stoppedHere = this.state.phase === 'stopped' || this.state.phase === 'stopped-remote';
    if ((stop === 'ici' || stop === 'eleveur') && !stoppedHere) {
      this.latest = null;
      this.identity = this.storedIdentity();
      this.set({ phase: stop === 'ici' ? 'stopped' : 'stopped-remote', label: null, sendError: null });
    } else if (!stop && stoppedHere) this.start();
    else if (!stop && !this.busy) {
      const stored = this.storedIdentity();
      if (stored && stored.id !== this.identity?.id) {
        this.identity = stored;
        this.set({ label: stored.label });
      }
    }
  }

  /** Le navigateur a donné une position. */
  onFix(fix: Fix) {
    if (!this.wantsPositions()) return;
    if (this.latest && fix.at <= this.latest.at) {
      // La même position livrée deux fois (écoute et demande directe) : rien de nouveau.
      if (fix.latitude === this.latest.latitude && fix.longitude === this.latest.longitude) return;
      // Une position différente, mais sans instant plus récent (horloge du capteur) : elle est nouvelle, son instant est celui de sa livraison.
      fix = { ...fix, at: Math.max(this.env.now(), this.latest.at + 1) };
    }
    this.latest = fix;
    if (this.state.phase === 'denied' || this.state.phase === 'unavailable') this.set({ phase: this.state.lastSentAt === null ? 'waiting' : 'tracking' });
    void this.pump();
  }

  /** Le navigateur n'a pas donné de position. 1 : refusée. 2 : indisponible. 3 : pas obtenue à temps. */
  onGeoError(code: number) {
    if (!this.wantsPositions() || this.state.phase === 'full') return;
    if (code === 1) return this.set({ phase: 'denied' });
    // Une position déjà acceptée reste dite : le bandeau dira seulement qu'il n'y en a pas de nouvelle.
    if (this.state.phase !== 'tracking') this.set({ phase: 'unavailable' });
  }

  /** À appeler chaque seconde : renvoie une position restée en attente, et met à jour « muet ». */
  tick() {
    if (this.state.phase === 'tracking' && this.state.lastSentAt !== null) this.set({ stale: this.env.now() - this.state.lastSentAt > STALE_AFTER_MS });
    void this.pump();
  }

  /**
   * Envoie la dernière position obtenue, si elle est nouvelle. Une seule requête à la fois, une par seconde au plus.
   * Rien ne part s'il n'y a pas de position plus récente que la dernière acceptée.
   */
  async pump(): Promise<void> {
    if (!this.wantsPositions() || this.busy) return;
    const fix = this.latest;
    const now = this.env.now();
    if (!fix || (this.settledAt !== null && fix.at <= this.settledAt)) return;
    if (now - fix.at > MAX_FIX_AGE_MS) {
      // Trop ancienne pour dire où est l'appareil : elle ne partira pas. La prochaine position réelle partira.
      this.settledAt = fix.at;
      return;
    }
    if (now < this.holdUntil || now - this.lastAttempt < MIN_SPACING_MS) return;
    this.busy = true;
    this.lastAttempt = now;
    try {
      if (!this.identity) {
        // Une autre fenêtre a pu enregistrer l'appareil entre-temps : on ne crée pas une seconde balise.
        const stored = this.storedIdentity();
        this.identity = stored ?? (await this.registerNow());
        this.set({ label: this.identity.label });
      }
      const result = await this.env.send(this.identity, fix);
      if (result === 'accepted') {
        this.settledAt = fix.at;
        this.unknownInARow = 0;
        this.set({ phase: 'tracking', label: this.identity.label, lastSentAt: fix.at, lastAccuracyM: fix.accuracyM, stale: false, sendError: null });
      }
      // « too-fast » : la position reste à envoyer au prochain passage, avec son instant d'origine.
    } catch (e) {
      this.onSendFailure(e, fix);
    } finally {
      this.busy = false;
    }
  }

  private async registerNow(): Promise<Identity> {
    const d = await this.env.register(this.env.kind());
    const identity = { id: d.id, token: d.token, label: d.label };
    this.write(IDENTITY_KEY, JSON.stringify(identity));
    return identity;
  }

  private onSendFailure(e: unknown, fix: Fix) {
    if (e instanceof ApiFailure && e.status === 401) {
      // Le serveur ne connaît plus cet appareil (démonstration réinitialisée) : il n'a pas été arrêté par quelqu'un, on le
      // réenregistre à la prochaine tentative. Si cela se répète, on attend plutôt que de créer des balises en boucle.
      this.forget();
      this.unknownInARow += 1;
      if (this.unknownInARow >= 3) this.holdUntil = this.env.now() + HOLD_MS;
      this.set({ label: null, lastSentAt: null, stale: false, sendError: this.unknownInARow >= 3 ? 'le serveur ne reconnaît pas cet appareil pour l’instant' : null, phase: 'waiting' });
    } else if (e instanceof ApiFailure && e.status === 409 && e.body.reason === 'STOPPED') {
      // Arrêtée depuis l'écran de l'éleveur : on ne recrée pas une balise qu'il vient d'arrêter.
      this.forget();
      this.latest = null;
      this.write(STOP_KEY, 'eleveur');
      this.set({ phase: 'stopped-remote', label: null, sendError: null, stale: false });
    } else if (e instanceof ApiFailure && e.status === 409 && e.body.reason === 'AUTO_LIMIT') {
      this.holdUntil = this.env.now() + HOLD_MS;
      this.set({ phase: 'full', sendError: e.message });
    } else if (e instanceof ApiFailure) {
      // Position refusée pour de bon (instant incohérent avec l'heure du serveur, par exemple) : elle ne repartira pas.
      this.settledAt = fix.at;
      const field = e.body.fields && typeof e.body.fields === 'object' ? Object.values(e.body.fields as Record<string, string>)[0] : null;
      this.set({ sendError: field ?? e.message });
    } else {
      // Réseau : la même position repartira au prochain passage tant qu'elle est récente, avec son instant d'origine.
      this.set({ sendError: e instanceof NetworkError ? 'serveur injoignable' : 'erreur inattendue' });
    }
  }

  private async tellStopped(identity: Identity) {
    try {
      await this.env.stop(identity);
      // Le serveur a arrêté la balise : son jeton ne sert plus à rien.
      if (this.identity?.id === identity.id) this.forget();
    } catch {
      /* réseau coupé : la demande sera redite à la prochaine ouverture ; rien n'est plus envoyé d'ici là */
    }
  }

  /** « Arrêter le suivi » : plus rien n'est envoyé, le refus est gardé dans ce navigateur, et la balise est arrêtée côté serveur. */
  async stopByUser(): Promise<void> {
    this.write(STOP_KEY, 'ici');
    this.latest = null;
    this.set({ phase: 'stopped', label: null, sendError: null, stale: false });
    if (this.identity) await this.tellStopped(this.identity);
  }

  /** « Reprendre le suivi » : action explicite sur l'appareil. Une nouvelle balise sera créée à la prochaine position. */
  resume(blocked: 'insecure' | 'unsupported' | null = null) {
    this.write(STOP_KEY, null);
    this.forget();
    this.settledAt = null;
    this.holdUntil = 0;
    this.unknownInARow = 0;
    this.set({ lastSentAt: null, lastAccuracyM: null });
    this.start(blocked);
  }
}

/** Environnement réel : API du serveur, stockage du navigateur. */
export function browserEnv(): TrackerEnv {
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return {
    now: () => Date.now(),
    storage,
    kind: () => deviceKind(navigator as Navigator & { userAgentData?: { mobile?: boolean } }),
    register: (kind) => api<AutoDevice>('/api/devices/auto', { method: 'POST', body: kind ? { kind } : {} }),
    send: async (identity, fix) => {
      const r = await api<{ accepted: boolean }>(`/api/devices/${encodeURIComponent(identity.id)}/position`, {
        method: 'POST',
        headers: { 'x-device-token': identity.token },
        body: { latitude: fix.latitude, longitude: fix.longitude, accuracyM: fix.accuracyM, observedAt: new Date(fix.at).toISOString() },
      });
      return r.accepted ? 'accepted' : 'too-fast';
    },
    stop: async (identity) => {
      await api(`/api/devices/${encodeURIComponent(identity.id)}/stop`, { method: 'POST', headers: { 'x-device-token': identity.token }, body: {} });
    },
  };
}

/** Sans nouvelle position livrée depuis ce délai, on en DEMANDE une vraie au navigateur (jamais la même renvoyée). */
const ASK_FRESH_AFTER_MS = 4000;

/**
 * Branche le suivi sur le navigateur : écoute de la position, envoi, verrou d'écran. Renvoie de quoi tout débrancher.
 * - `watchPosition` en haute précision, sans cache (`maximumAge: 0`) : chaque position livrée est nouvelle ;
 * - certains navigateurs ne livrent une position que de loin en loin, surtout à l'arrêt : on demande alors une position fraîche
 *   (`getCurrentPosition`, sans cache). C'est une nouvelle mesure, avec son propre instant ; si le navigateur n'en donne pas,
 *   rien n'est envoyé et l'appareil est dit muet ;
 * - écran gardé allumé quand le navigateur le permet (un téléphone en veille n'envoie plus rien), repris au retour sur la page.
 */
/** Raison pour laquelle ce navigateur ne donnera pas de position, s'il y en a une : pas d'accès, ou page hors https (hors localhost). */
export const browserBlocked = (): 'insecure' | 'unsupported' | null => (!('geolocation' in navigator) ? 'unsupported' : !window.isSecureContext ? 'insecure' : null);

export function attachBrowser(tracker: AutoTracker): () => void {
  const blocked = browserBlocked();
  tracker.start(blocked);
  if (blocked) return () => tracker.detach();
  const geo = navigator.geolocation;
  let watchId: number | null = null;
  let lastDelivery = 0;
  let granted = false;
  let asking = false;
  let lock: WakeLockSentinel | null = null;
  const OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 };

  const onPosition = (p: GeolocationPosition) => {
    const now = Date.now();
    lastDelivery = now;
    granted = true;
    // L'instant est celui que donne le navigateur ; s'il est manifestement faux (horloge du capteur), celui de la livraison.
    const at = Math.abs(p.timestamp - now) < 5 * 60_000 ? Math.min(p.timestamp, now) : now;
    tracker.onFix({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: p.coords.accuracy, at });
    void keepAwake();
  };
  const onError = (e: GeolocationPositionError) => tracker.onGeoError(e.code);
  const watch = () => {
    if (watchId !== null) geo.clearWatch(watchId);
    watchId = geo.watchPosition(onPosition, onError, OPTIONS);
  };
  const unwatch = () => {
    if (watchId !== null) geo.clearWatch(watchId);
    watchId = null;
    granted = false;
  };
  async function keepAwake() {
    if (lock || !('wakeLock' in navigator) || document.visibilityState !== 'visible' || !tracker.wantsPositions()) return;
    try {
      const l = await navigator.wakeLock.request('screen');
      lock = l;
      l.addEventListener('release', () => {
        if (lock === l) lock = null;
      });
    } catch {
      /* refusé par le navigateur (économie d'énergie, par exemple) : le suivi continue tant que l'écran reste allumé */
    }
  }
  const sleep = () => {
    void lock?.release().catch(() => {});
    lock = null;
  };
  /** Aligne l'écoute sur l'état du suivi : arrêté, plus aucune position n'est demandée au navigateur. */
  const align = () => {
    if (tracker.wantsPositions()) {
      if (watchId === null) watch();
    } else {
      unwatch();
      sleep();
    }
  };
  const unsubscribe = tracker.subscribe(align);
  align();

  const timer = setInterval(() => {
    tracker.tick();
    if (!granted || asking || !tracker.wantsPositions() || document.visibilityState !== 'visible' || Date.now() - lastDelivery < ASK_FRESH_AFTER_MS) return;
    asking = true;
    geo.getCurrentPosition(
      (p) => {
        asking = false;
        if (watchId !== null) onPosition(p);
      },
      () => {
        asking = false;
      },
      { ...OPTIONS, timeout: 10_000 },
    );
  }, 1000);
  const onVisible = () => {
    if (document.visibilityState !== 'visible' || !tracker.wantsPositions()) return;
    // Au retour sur la page : certains navigateurs ont suspendu l'écoute en arrière-plan, et le verrou d'écran a été relâché.
    if (Date.now() - lastDelivery > ASK_FRESH_AFTER_MS) watch();
    void keepAwake();
  };
  const onStorage = () => tracker.syncFromStorage();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('storage', onStorage);
  return () => {
    clearInterval(timer);
    unsubscribe();
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('storage', onStorage);
    unwatch();
    sleep();
    tracker.detach();
  };
}
