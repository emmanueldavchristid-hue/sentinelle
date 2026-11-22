import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranscriptionReply } from '@sentinelle/contracts';
import { api, ApiFailure, isSimulatedOffline, NetworkError, type Session } from '../api';

/**
 * Voix : parler à l'application, et l'écouter répondre.
 *
 * Parler (dictée) : un enregistrement court, ouvert par l'utilisateur, qui s'arrête de lui-même quand on se tait,
 * transcrit par le serveur puis jeté. Le micro n'est jamais ouvert sans action de l'utilisateur ; il est toujours signalé
 * et toujours limité dans le temps. En mode « discussion », l'utilisateur ouvre une session : le micro se rouvre après
 * chaque réponse, jusqu'à ce qu'il l'arrête, qu'il se taise, ou que la limite de la session soit atteinte.
 *
 * Écouter : voir la seconde partie de ce fichier (réponses à voix haute).
 */

const RATE = 16_000;
/** Niveaux sonores (valeur efficace, de 0 à 1) : au-dessus du premier, quelqu'un parle ; sous le second, c'est le silence. */
const SPEECH_LEVEL = 0.022;
const SILENCE_LEVEL = 0.013;
const SILENCE_STOPS_AFTER_MS = 1500;
const NOTHING_HEARD_AFTER_MS = 8000;

/** Pourquoi la dictée ne peut pas démarrer dans ce navigateur (null : elle le peut). */
export function micUnavailable(): string | null {
  if (typeof window === 'undefined') return 'Micro indisponible.';
  if (!window.isSecureContext) return 'Le micro exige une page sécurisée (https ou localhost).';
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return 'Ce navigateur ne permet pas l’enregistrement audio.';
  return null;
}

function micError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Accès au microphone refusé. Autorisez-le dans la barre d’adresse du navigateur, ou utilisez le texte.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Aucun microphone détecté sur cet appareil. Utilisez le texte.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Le microphone est occupé ou s’est interrompu. Réessayez, ou utilisez le texte.';
  return 'Le microphone n’a pas pu démarrer. Utilisez le texte.';
}

const AudioCtx = (): typeof AudioContext => window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

/** Convertit l'enregistrement du navigateur en WAV mono 16 kHz 16 bits (format accepté par le serveur). */
async function toWavBase64(blob: Blob): Promise<{ base64: string; seconds: number }> {
  const ctx = new (AudioCtx())();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void ctx.close();
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * RATE));
  const offline = new OfflineAudioContext(1, frames, RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const pcm = (await offline.startRendering()).getChannelData(0);
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i]!)) * 0x7fff, true);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(bin), seconds: decoded.duration };
}

export type MicPhase = 'idle' | 'starting' | 'recording' | 'transcribing';
/** Comment un tour de parole s'est terminé sans texte : silence, annulation, ou erreur. */
export type MicEnd = 'silence' | 'cancel' | 'error';

interface Recording {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  cancelled: boolean;
  audio: AudioContext | null;
}

const MicIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7" />
  </svg>
);

export function Dictation({
  session,
  available,
  maxSeconds,
  offline,
  unavailableReason,
  onText,
  big = false,
  startSignal = 0,
  onPhase,
  onEnd,
  quiet = false,
  handle,
  labels,
}: {
  session: Session | null;
  /** Le serveur sait-il transcrire (assistant IA configuré) ? */
  available: boolean;
  maxSeconds: number;
  offline: boolean;
  unavailableReason: string;
  onText: (text: string) => void;
  /** Gros bouton rond à icône, pour un usage sans lecture. */
  big?: boolean;
  /** Incrémenté par l'écran pour rouvrir le micro (mode discussion). */
  startSignal?: number;
  onPhase?: (p: MicPhase) => void;
  onEnd?: (why: MicEnd) => void;
  /** Masque la ligne d'explication au repos (affichage simple). */
  quiet?: boolean;
  /**
   * Traitement propre de l'enregistrement (WAV 16 kHz en base64) à la place de la transcription par l'assistant : sert à la
   * note vocale en baoulé, qui passe par un autre chemin. Renvoie un message d'erreur à afficher, ou null.
   */
  handle?: (wavBase64: string) => Promise<string | null>;
  /** Libellés propres à cet usage : bouton au repos, bouton pendant le traitement, phrase d'explication. */
  labels?: { idle: string; busy: string; hint: string };
}) {
  const [phase, setPhaseState] = useState<MicPhase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const rec = useRef<Recording | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const cb = useRef({ onText, onPhase, onEnd, handle });
  cb.current = { onText, onPhase, onEnd, handle };
  const setPhase = useCallback((p: MicPhase) => {
    setPhaseState(p);
    cb.current.onPhase?.(p);
  }, []);
  const support = micUnavailable();
  const blocked = support ?? (!available ? unavailableReason : offline ? 'Dictée indisponible hors connexion : la transcription passe par le serveur. Le texte reste utilisable.' : null);

  const release = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    rec.current?.stream.getTracks().forEach((t) => t.stop());
    void rec.current?.audio?.close().catch(() => {});
  }, []);
  // Quitter l'écran referme toujours le micro.
  useEffect(
    () => () => {
      if (rec.current) rec.current.cancelled = true;
      release();
    },
    [release],
  );

  const finish = useCallback(
    async (chunks: Blob[], type: string) => {
      setPhase('transcribing');
      let end: MicEnd | null = null;
      try {
        const wav = await toWavBase64(new Blob(chunks, { type }));
        if (wav.seconds < 0.4) {
          setMessage({ tone: 'error', text: 'Enregistrement trop court. Parlez après avoir appuyé sur le micro.' });
          end = 'silence';
          return;
        }
        if (cb.current.handle) {
          const problem = await cb.current.handle(wav.base64);
          setMessage(problem ? { tone: 'error', text: problem } : null);
          if (problem) end = 'error';
          return;
        }
        const r = await api<TranscriptionReply>('/api/assistant/transcribe', { method: 'POST', session, timeoutMs: 45_000, body: { mimeType: 'audio/wav', audio: wav.base64 } });
        if (!r.text.trim()) {
          setMessage({ tone: 'error', text: 'Rien d’audible n’a été transcrit. Rapprochez-vous du micro et réessayez, ou utilisez le texte.' });
          end = 'silence';
        } else {
          setMessage(null);
          cb.current.onText(r.text.trim());
        }
      } catch (e) {
        end = 'error';
        setMessage({
          tone: 'error',
          text: e instanceof NetworkError ? 'Connexion interrompue pendant la transcription : rien n’a été transcrit. Réessayez, ou utilisez le texte.' : e instanceof ApiFailure ? (e.body.fields ? Object.values(e.body.fields as Record<string, string>).join(' ') : e.message) : 'L’enregistrement n’a pas pu être lu. Utilisez le texte.',
        });
      } finally {
        setPhase('idle');
        if (end) cb.current.onEnd?.(end);
      }
    },
    [session, setPhase],
  );

  const start = useCallback(async () => {
    if (rec.current && rec.current.recorder.state === 'recording') return;
    setMessage(null);
    setPhase('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const recorder = new MediaRecorder(stream);
      const state: Recording = { recorder, stream, chunks: [], cancelled: false, audio: null };
      rec.current = state;
      recorder.ondataavailable = (ev) => ev.data.size && state.chunks.push(ev.data);
      recorder.onerror = () => {
        state.cancelled = true;
        release();
        setPhase('idle');
        setMessage({ tone: 'error', text: 'L’enregistrement s’est interrompu. Réessayez, ou utilisez le texte.' });
        cb.current.onEnd?.('error');
      };
      recorder.onstop = () => {
        release();
        if (state.cancelled) return setPhase('idle');
        void finish(state.chunks, recorder.mimeType);
      };

      // Détection du silence : on mesure le niveau sonore pour arrêter l'enregistrement quand la personne a fini de parler.
      let level: (() => number) | null = null;
      try {
        const audio = new (AudioCtx())();
        state.audio = audio;
        const analyser = audio.createAnalyser();
        analyser.fftSize = 1024;
        audio.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        level = () => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          return Math.sqrt(sum / buf.length);
        };
      } catch {
        level = null; // pas de mesure possible : arrêt manuel ou à la limite de durée
      }

      recorder.start(250);
      setElapsed(0);
      setPhase('recording');
      const t0 = Date.now();
      let spoke = false;
      let loud = 0;
      let quietSince: number | null = null;
      timer.current = setInterval(() => {
        const now = Date.now();
        const s = (now - t0) / 1000;
        setElapsed(s);
        if (recorder.state !== 'recording') return;
        if (s >= maxSeconds) return recorder.stop(); // limite de durée : arrêt et transcription
        if (!level) return;
        const l = level();
        if (l > SPEECH_LEVEL) {
          loud++;
          if (loud >= 2) spoke = true;
          quietSince = null;
        } else if (l < SILENCE_LEVEL) {
          loud = 0;
          quietSince ??= now;
          if (spoke && now - quietSince >= SILENCE_STOPS_AFTER_MS) return recorder.stop(); // la personne a fini de parler
          if (!spoke && now - t0 >= NOTHING_HEARD_AFTER_MS) {
            state.cancelled = true;
            recorder.stop();
            setMessage({ tone: 'info', text: 'Je n’ai rien entendu. Appuyez sur le micro pour réessayer.' });
            cb.current.onEnd?.('silence');
          }
        }
      }, 120);
    } catch (e) {
      release();
      setPhase('idle');
      setMessage({ tone: 'error', text: micError(e) });
      cb.current.onEnd?.('error');
    }
  }, [finish, maxSeconds, release, setPhase]);

  const stop = () => rec.current?.recorder.state === 'recording' && rec.current.recorder.stop();
  const cancel = () => {
    if (!rec.current) return;
    rec.current.cancelled = true;
    if (rec.current.recorder.state === 'recording') rec.current.recorder.stop();
    setMessage({ tone: 'info', text: 'Enregistrement annulé. Rien n’a été envoyé.' });
    cb.current.onEnd?.('cancel');
  };

  // Réouverture demandée par l'écran (mode discussion) : seulement si rien n'est en cours et que la dictée est possible.
  const lastSignal = useRef(startSignal);
  useEffect(() => {
    if (startSignal === lastSignal.current) return;
    lastSignal.current = startSignal;
    if (!blocked && phase === 'idle') void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSignal]);

  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const recording = phase === 'recording';
  const label = recording ? 'Arrêter et transcrire' : phase === 'starting' ? 'Autorisation du micro…' : phase === 'transcribing' ? (labels?.busy ?? 'Transcription…') : big ? 'Parler' : (labels?.idle ?? 'Dicter');
  const status = recording ? (
    <>
      <b className="text-laterite">Microphone actif.</b> Parlez : l’enregistrement s’arrête quand vous vous taisez. Il est transcrit, jamais conservé. Limite : {maxSeconds} secondes.
    </>
  ) : (
    (message?.text ?? blocked ?? (quiet ? '' : (labels?.hint ?? 'Dictée : appuyez, parlez, l’enregistrement s’arrête quand vous vous taisez. Votre phrase est transcrite puis envoyée.')))
  );

  return (
    <div className={big ? 'v-voice v-voice-big' : 'v-voice'} data-live={big && recording ? 'listening' : undefined}>
      <div className={`flex flex-wrap items-center gap-3 ${big ? 'justify-start' : ''}`}>
        <button type="button" className={big ? 'v-mic-big' : 'v-mic'} data-recording={recording ? 'true' : undefined} data-busy={phase === 'starting' || phase === 'transcribing' ? 'true' : undefined} onClick={recording ? stop : start} disabled={!recording && (!!blocked || phase !== 'idle')} aria-describedby="voice-status" aria-label={big ? label : undefined}>
          {recording ? <span className={big ? 'v-mic-stop' : 'v-mic-dot'} aria-hidden="true" /> : <MicIcon size={big ? 38 : 18} />}
          {!big && label}
        </button>
        {big && (
          <span className="min-w-0">
            <span className="v-voice-state">{recording ? 'Je vous écoute' : phase === 'transcribing' ? 'Je transcris…' : phase === 'starting' ? 'Micro…' : 'Parler'}</span>
            {recording && (
              <span className="num text-[15px] text-encre-2" aria-hidden="true">
                {mmss(elapsed)} / {mmss(maxSeconds)}
              </span>
            )}
          </span>
        )}
        {recording && (
          <>
            {!big && (
              <span className="num text-[15px]" aria-hidden="true">
                {mmss(elapsed)} / {mmss(maxSeconds)}
              </span>
            )}
            <button type="button" className="v-chip" onClick={cancel}>
              Annuler
            </button>
          </>
        )}
      </div>
      {status && (
        <p id="voice-status" role="status" className={`mt-1.5 text-[14px] ${message?.tone === 'error' && !recording ? 'text-danger' : 'text-encre-2'}`}>
          {status}
        </p>
      )}
    </div>
  );
}

// ---------- Écouter : voix de synthèse du serveur (Gemini), sinon voix de synthèse de l'appareil ----------

/**
 * Pour une personne qui ne lit pas, la réponse doit pouvoir s'écouter. Le texte lu est celui affiché à l'écran : la voix
 * n'ajoute aucun fait. C'est toujours une voix de synthèse, annoncée comme telle.
 * - Voix du serveur : le texte est envoyé au serveur, qui le fait dire par le modèle de synthèse configuré (rien n'est conservé).
 * - Repli : la voix de synthèse de l'appareil (hors connexion, service indisponible, pas de modèle vocal configuré).
 */
export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

function speakOnDevice(text: string, onEnd: () => void) {
  if (!canSpeak()) return onEnd();
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'fr-FR';
  const fr = window.speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('fr'));
  if (fr) u.voice = fr;
  u.onend = onEnd;
  u.onerror = onEnd;
  window.speechSynthesis.speak(u);
}

export type VoiceVia = 'server' | 'device';
const PREF_KEY = 'sentinelle.reponsesVocales';
export const voiceRepliesPref = {
  get: () => {
    try {
      return localStorage.getItem(PREF_KEY) !== 'non';
    } catch {
      return true;
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

const cache = new Map<string, string>(); // texte -> adresse locale du son déjà produit (réécoute sans nouvel appel)
let player: HTMLAudioElement | null = null;
let generation = 0;

export function stopSpeech() {
  generation++;
  if (player) {
    player.pause();
    player = null;
  }
  if (canSpeak()) window.speechSynthesis.cancel();
}

async function serverAudio(text: string, session: Session | null): Promise<string | null> {
  const hit = cache.get(text);
  if (hit) return hit;
  if (isSimulatedOffline()) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch('/api/assistant/speak', { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json', ...(session ? { 'x-demo-user': session.userId } : {}) }, body: JSON.stringify({ text }) });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('audio')) return null;
    const url = URL.createObjectURL(await res.blob());
    if (cache.size >= 20) {
      const [k, v] = cache.entries().next().value as [string, string];
      URL.revokeObjectURL(v);
      cache.delete(k);
    }
    cache.set(text, url);
    return url;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dit un texte. `onState` reçoit « loading » (la voix se prépare), puis la voix utilisée, puis null à la fin.
 * Si le navigateur refuse de jouer un son sans geste de l'utilisateur, la lecture s'arrête simplement : le bouton
 * « Écouter » reste disponible.
 */
export async function playSpeech(text: string, opts: { session: Session | null; server: boolean; onState: (s: 'loading' | VoiceVia | null) => void }) {
  stopSpeech();
  const mine = generation;
  const said = text.slice(0, 900);
  if (!said.trim()) return opts.onState(null);
  const end = () => mine === generation && opts.onState(null);
  if (opts.server) {
    opts.onState('loading');
    const url = await serverAudio(said, opts.session);
    if (mine !== generation) return;
    if (url) {
      const a = new Audio(url);
      player = a;
      a.onended = end;
      a.onerror = end;
      try {
        await a.play();
        if (mine === generation) opts.onState('server');
        return;
      } catch {
        player = null; // lecture refusée par le navigateur : on tente la voix de l'appareil
      }
    }
  }
  if (!canSpeak() || mine !== generation) return end();
  opts.onState('device');
  speakOnDevice(said, end);
}
