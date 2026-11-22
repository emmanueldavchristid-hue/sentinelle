import type { AssistantReply, BaouleIntent, BaouleReply } from '@sentinelle/contracts';
import { api, isSimulatedOffline, type Session } from '../api';
import { onStopSpeech, stopSpeech } from './Voice';

/**
 * La voix baoulé de l'écran : UN lecteur, partagé par la note vocale, les questions au toucher, l'alerte de balise et les
 * réponses aux questions posées en français.
 *
 * Pourquoi un seul lecteur gardé : sur un téléphone, un navigateur ne joue un son que s'il fait suite à un geste. La réponse
 * en baoulé arrive plusieurs secondes après l'appui sur le micro : un lecteur créé à ce moment-là est refusé, et la personne
 * n'entend rien (constat des essais du 22/11 : « il ne répond pas »). Le lecteur est donc « débloqué » pendant le geste, par
 * un silence d'un dixième de seconde, puis réutilisé pour dire la réponse.
 * Si le navigateur refuse quand même, l'écran le dit et offre un bouton : rien n'est présenté comme dit sans l'avoir été.
 */
export type BaouleVoiceState = 'loading' | 'playing' | 'blocked' | 'failed' | null;

/** Un dixième de seconde de silence (WAV, 8 kHz, 8 bits). */
const SILENCE = (() => {
  const n = 800;
  const b = new Uint8Array(44 + n).fill(128);
  const v = new DataView(b.buffer);
  const ascii = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  ascii(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  ascii(36, 'data');
  v.setUint32(40, n, true);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return `data:audio/wav;base64,${btoa(s)}`;
})();

let player: HTMLAudioElement | null = null;
let unlocked = false;
let turn = 0;
let report: ((s: BaouleVoiceState) => void) | null = null;

const element = () => (player ??= new Audio());
const tell = (mine: number, s: BaouleVoiceState): void => {
  if (mine === turn) report?.(s);
};

/** À appeler PENDANT un geste de l'utilisateur (appui sur le micro, sur une question) : autorise la réponse à venir. */
export function unlockBaouleVoice() {
  if (unlocked || typeof Audio === 'undefined') return;
  const a = element();
  // Ne coupe pas une réponse en cours : le déblocage n'a de sens que si le lecteur est au repos.
  if (!a.paused && a.src && a.src !== SILENCE) return;
  a.src = SILENCE;
  void a
    .play()
    .then(() => {
      unlocked = true;
    })
    .catch(() => {});
}

export function stopBaouleVoice() {
  turn++;
  if (player && !player.paused) player.pause();
  report?.(null);
  report = null;
}
// « Arrêter », une nouvelle question ou la voix de synthèse en français font taire la voix baoulé.
onStopSpeech(stopBaouleVoice);

/** Sons déjà reçus, pour réécouter sans redemander (les identifiants de voix expirent côté serveur). */
const sounds = new Map<string, string>();
const keep = (id: string, url: string) => {
  if (sounds.size >= 12) {
    const [k, v] = sounds.entries().next().value as [string, string];
    URL.revokeObjectURL(v);
    sounds.delete(k);
  }
  sounds.set(id, url);
};

async function fetchVoice(voiceId: string, session: Session | null): Promise<string | null> {
  const hit = sounds.get(voiceId);
  if (hit) return hit;
  if (isSimulatedOffline()) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(`/api/assistant/baoule/voix/${encodeURIComponent(voiceId)}`, { signal: ctrl.signal, headers: session ? { 'x-demo-user': session.userId } : {} });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('audio')) return null;
    const url = URL.createObjectURL(await res.blob());
    keep(voiceId, url);
    return url;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dit la réponse baoulé d'une `BaouleReply` (son joint, ou à récupérer par son identifiant). `onState` suit la lecture :
 * « loading » (la voix se prépare), « playing », puis null à la fin ; « blocked » si le navigateur refuse de jouer sans
 * nouveau geste (un bouton doit alors être offert) ; « failed » si la voix n'a pas pu être produite.
 */
export async function playBaouleReply(r: Pick<BaouleReply, 'audio' | 'voiceId'>, session: Session | null, onState: (s: BaouleVoiceState) => void): Promise<void> {
  stopSpeech(); // fait taire la voix française ET une réponse baoulé précédente
  const mine = ++turn;
  report = onState;
  tell(mine, 'loading');
  const src = r.audio ? `data:audio/wav;base64,${r.audio}` : r.voiceId ? await fetchVoice(r.voiceId, session) : null;
  if (mine !== turn) return;
  if (!src) return tell(mine, 'failed');
  const a = element();
  a.onended = () => tell(mine, null);
  a.onerror = () => tell(mine, 'failed');
  a.src = src;
  try {
    await a.play();
    unlocked = true;
    tell(mine, 'playing');
  } catch {
    tell(mine, 'blocked');
  }
}

/** Demande au serveur la réponse baoulé à une question CHOISIE (sans note vocale), en deux temps : les faits d'abord. */
export const askBaoule = (intent: BaouleIntent | 'unknown', session: Session | null) => api<BaouleReply>('/api/assistant/baoule/question', { method: 'POST', session, timeoutMs: 30_000, body: { intent, voice: 'later' } });

/** Prépare côté serveur la voix des réponses du moment. Sans effet si la voix baoulé n'est pas disponible. */
export const prepareBaoule = (session: Session | null) => api<{ prepared: number }>('/api/assistant/baoule/preparer', { method: 'POST', session, timeoutMs: 15_000 }).catch(() => null);

/** Question baoulé équivalente à la réponse d'une question posée en français ; undefined s'il n'y a pas de gabarit baoulé. */
export function baouleIntentOf(intent: AssistantReply['intent']): BaouleIntent | undefined {
  return intent === 'situation' || intent === 'changes' || intent === 'missing' || intent === 'beacons' ? intent : undefined;
}

const PREF_KEY = 'sentinelle.reponsesBaoule';
/** « Réponses à voix haute en baoulé » : choix gardé sur cet appareil, désactivé par défaut. */
export const baouleRepliesPref = {
  get: () => {
    try {
      return localStorage.getItem(PREF_KEY) === 'oui';
    } catch {
      return false;
    }
  },
  set: (on: boolean) => {
    try {
      localStorage.setItem(PREF_KEY, on ? 'oui' : 'non');
    } catch {
      /* préférence valable pour cette page seulement */
    }
  },
};
