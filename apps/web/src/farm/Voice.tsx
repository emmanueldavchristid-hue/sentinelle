import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranscriptionReply } from '@sentinelle/contracts';
import { api, ApiFailure, NetworkError, type Session } from '../api';

/**
 * Dictée : un enregistrement court, déclenché et arrêté par l'utilisateur, transcrit par le serveur puis jeté.
 * - Pas d'écoute permanente : le micro ne s'ouvre qu'au clic et se referme à l'arrêt, à l'annulation, à la limite de durée
 *   ou si l'on quitte l'écran.
 * - Le microphone actif est signalé en clair, avec un compteur.
 * - Le texte transcrit est rendu à l'utilisateur, qui le relit avant de l'envoyer : la voix n'est jamais le seul accès.
 * - L'audio n'est conservé ni dans le navigateur ni sur le serveur.
 */

const RATE = 16_000;

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

/** Convertit l'enregistrement du navigateur en WAV mono 16 kHz 16 bits (format accepté par le serveur). */
async function toWavBase64(blob: Blob): Promise<{ base64: string; seconds: number }> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
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

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing';

export function Dictation({
  session,
  available,
  maxSeconds,
  offline,
  unavailableReason,
  onText,
}: {
  session: Session | null;
  /** Le serveur sait-il transcrire (assistant IA configuré) ? */
  available: boolean;
  maxSeconds: number;
  offline: boolean;
  unavailableReason: string;
  onText: (text: string, notice: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; cancelled: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const support = micUnavailable();
  const blocked = support ?? (!available ? unavailableReason : offline ? 'Dictée indisponible hors connexion : la transcription passe par le serveur. Le texte reste utilisable.' : null);

  const release = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    rec.current?.stream.getTracks().forEach((t) => t.stop());
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
      try {
        const wav = await toWavBase64(new Blob(chunks, { type }));
        if (wav.seconds < 0.4) {
          setMessage({ tone: 'error', text: 'Enregistrement trop court. Maintenez l’enregistrement le temps de votre phrase, puis arrêtez.' });
          return;
        }
        const r = await api<TranscriptionReply>('/api/assistant/transcribe', { method: 'POST', session, timeoutMs: 45_000, body: { mimeType: 'audio/wav', audio: wav.base64 } });
        if (!r.text.trim()) setMessage({ tone: 'error', text: 'Rien d’audible n’a été transcrit. Rapprochez-vous du micro et réessayez, ou utilisez le texte.' });
        else {
          setMessage({ tone: 'info', text: r.notice });
          onText(r.text.trim(), r.notice);
        }
      } catch (e) {
        setMessage({
          tone: 'error',
          text: e instanceof NetworkError ? 'Connexion interrompue pendant la transcription : rien n’a été transcrit. Réessayez, ou utilisez le texte.' : e instanceof ApiFailure ? (e.body.fields ? Object.values(e.body.fields as Record<string, string>).join(' ') : e.message) : 'L’enregistrement n’a pas pu être lu. Utilisez le texte.',
        });
      } finally {
        setPhase('idle');
      }
    },
    [session, onText],
  );

  const start = async () => {
    setMessage(null);
    setPhase('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const recorder = new MediaRecorder(stream);
      const state = { recorder, stream, chunks: [] as Blob[], cancelled: false };
      rec.current = state;
      recorder.ondataavailable = (ev) => ev.data.size && state.chunks.push(ev.data);
      recorder.onerror = () => {
        state.cancelled = true;
        release();
        setPhase('idle');
        setMessage({ tone: 'error', text: 'L’enregistrement s’est interrompu. Réessayez, ou utilisez le texte.' });
      };
      recorder.onstop = () => {
        release();
        if (state.cancelled) return setPhase('idle');
        void finish(state.chunks, recorder.mimeType);
      };
      recorder.start(250);
      setElapsed(0);
      setPhase('recording');
      const t0 = Date.now();
      timer.current = setInterval(() => {
        const s = (Date.now() - t0) / 1000;
        setElapsed(s);
        if (s >= maxSeconds && recorder.state === 'recording') recorder.stop(); // limite de durée : arrêt et transcription
      }, 200);
    } catch (e) {
      release();
      setPhase('idle');
      setMessage({ tone: 'error', text: micError(e) });
    }
  };
  const stop = () => rec.current?.recorder.state === 'recording' && rec.current.recorder.stop();
  const cancel = () => {
    if (!rec.current) return;
    rec.current.cancelled = true;
    if (rec.current.recorder.state === 'recording') rec.current.recorder.stop();
    setMessage({ tone: 'info', text: 'Enregistrement annulé. Rien n’a été envoyé.' });
  };

  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return (
    <div className="v-voice">
      <div className="flex flex-wrap items-center gap-2">
        {phase === 'recording' ? (
          <>
            <button type="button" className="v-mic" data-recording="true" onClick={stop}>
              <span className="v-mic-dot" aria-hidden="true" />
              Arrêter et transcrire
            </button>
            <button type="button" className="v-chip" onClick={cancel}>
              Annuler
            </button>
            <span className="num text-[15px]" aria-hidden="true">
              {mmss(elapsed)} / {mmss(maxSeconds)}
            </span>
          </>
        ) : (
          <button type="button" className="v-mic" onClick={start} disabled={!!blocked || phase !== 'idle'} aria-describedby="voice-status">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7" />
            </svg>
            {phase === 'starting' ? 'Autorisation du micro…' : phase === 'transcribing' ? 'Transcription…' : 'Dicter'}
          </button>
        )}
      </div>
      <p id="voice-status" role="status" className={`mt-1.5 text-[14px] ${message?.tone === 'error' ? 'text-danger' : 'text-encre-2'}`}>
        {phase === 'recording' ? (
          <>
            <b className="text-laterite">Microphone actif.</b> Parlez, puis arrêtez : l’enregistrement est transcrit, jamais conservé. Limite : {maxSeconds} secondes.
          </>
        ) : (
          (message?.text ?? blocked ?? 'Dictée : un clic pour parler, un clic pour arrêter. Le texte transcrit s’affiche pour relecture avant envoi.')
        )}
      </p>
    </div>
  );
}

// ---------- Lecture à voix haute : voix de synthèse de l'appareil, locale, sans service externe ----------

export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

export function speak(text: string, onEnd: () => void) {
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
export const stopSpeaking = () => canSpeak() && window.speechSynthesis.cancel();
