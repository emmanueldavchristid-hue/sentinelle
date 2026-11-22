import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { LiveClientMessage, LiveEndReason, LiveServerMessage } from '@sentinelle/contracts';
import { isSimulatedOffline, type Session } from '../api';

/**
 * Conversation en direct : la personne parle, l'assistant répond à la voix dès qu'elle a fini, sans étape de transcription.
 *
 * Le son du micro part en continu vers le serveur de l'application (jamais directement vers le fournisseur, dont la clé reste
 * côté serveur), et la voix de l'assistant revient au fil de l'eau. Règles tenues ici :
 * - le micro ne s'ouvre que sur un geste de l'utilisateur ; il est signalé tant qu'il est ouvert ;
 * - la conversation se ferme d'elle-même (silence, durée maximale) et l'écran dit pourquoi ;
 * - pendant que l'assistant parle, le son du micro n'est pas transmis : la voix de l'assistant, reprise par le micro,
 *   ne peut pas être prise pour celle de l'utilisateur. Le bouton « Interrompre » rend la parole tout de suite ;
 * - aucun son n'est gardé sur l'appareil.
 */

export type LivePhase = 'idle' | 'connecting' | 'listening' | 'speaking';

/** Pourquoi la conversation en direct ne peut pas démarrer dans ce navigateur (null : elle le peut). */
export function liveUnavailable(): string | null {
  if (typeof window === 'undefined') return 'Conversation en direct indisponible.';
  if (!window.isSecureContext) return 'Le micro exige une page sécurisée (https ou localhost).';
  if (!navigator.mediaDevices?.getUserMedia) return 'Ce navigateur ne donne pas accès au micro.';
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx || typeof AudioWorkletNode === 'undefined' || typeof WebSocket === 'undefined') return 'Ce navigateur ne permet pas la conversation en direct.';
  return null;
}

function micError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Accès au microphone refusé. Autorisez-le dans la barre d’adresse du navigateur, ou utilisez le texte.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Aucun microphone détecté sur cet appareil. Utilisez le texte.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Le microphone est occupé ou s’est interrompu. Réessayez, ou utilisez le texte.';
  return 'La conversation en direct n’a pas pu démarrer. Utilisez le texte.';
}

interface Handlers {
  onPhase: (p: LivePhase) => void;
  onMessage: (m: LiveServerMessage) => void;
  /** Fin de la conversation. `beforeReady` : elle n'a jamais pu s'ouvrir (l'écran peut proposer la dictée à la place). */
  onEnd: (reason: LiveEndReason, message: string, beforeReady: boolean) => void;
}

/** Une conversation : micro, connexion, lecture de la voix. Sans React, pour que rien ne dépende d'un rendu. */
class LiveConversation {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private ws: WebSocket | null = null;
  private phase: LivePhase = 'idle';
  /** Le serveur a ouvert la conversation, et le micro est en place : les deux sont nécessaires pour écouter. */
  private serverReady = false;
  private micReady = false;
  private ready = false;
  private over = false;
  /** Son capté pendant l'ouverture de la conversation (3 secondes au plus) : la personne peut parler dès l'appui. */
  private early: ArrayBuffer[] = [];
  /** Sons programmés, pas encore finis. */
  private playing = new Set<AudioBufferSourceNode>();
  private nextStart = 0;
  /** Après une interruption : le reste de la réponse en cours est ignoré jusqu'à la fin du tour. */
  private dropping = false;
  /** Le micro n'est pas transmis avant cet instant (fin d'une réponse, signal sonore). */
  private muteUntil = 0;
  private settle: ReturnType<typeof setTimeout> | null = null;

  constructor(private h: Handlers) {}

  private setPhase(p: LivePhase) {
    if (this.phase === p || this.over) return;
    this.phase = p;
    this.h.onPhase(p);
  }

  /** Passe à l'écoute dès que le serveur et le micro sont prêts, et transmet ce qui a été capté entre-temps. */
  private listenWhenReady() {
    if (this.ready || this.over || !this.serverReady || !this.micReady) return;
    this.ready = true;
    performance.mark('sentinelle-live-ecoute');
    this.beep();
    for (const pcm of this.early.splice(0)) if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm);
    this.setPhase('listening');
  }

  async start(session: Session | null, contextAnimalId: string | null) {
    this.setPhase('connecting');
    // La connexion s'ouvre en même temps que le micro, pour ne pas faire attendre.
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/assistant/live`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => this.send({ type: 'start', demoUser: session?.userId, contextAnimalId: contextAnimalId ?? undefined });
    ws.onmessage = (ev: MessageEvent<string | ArrayBuffer>) => {
      if (typeof ev.data !== 'string') return this.play(ev.data);
      let m: LiveServerMessage;
      try {
        m = JSON.parse(ev.data) as LiveServerMessage;
      } catch {
        return;
      }
      if (m.type === 'ready') {
        this.serverReady = true;
        this.listenWhenReady();
      } else if (m.type === 'interrupted') {
        this.flush();
        this.dropping = false;
      } else if (m.type === 'turn_complete' || m.type === 'heard') this.dropping = false;
      else if (m.type === 'end') return this.finish(m.reason, m.message);
      this.h.onMessage(m);
    };
    ws.onerror = () => this.finish('error', this.serverReady ? 'La conversation s’est interrompue. Le micro est fermé.' : 'La conversation en direct n’a pas pu s’ouvrir.');
    ws.onclose = () => this.finish('error', this.serverReady ? 'La conversation s’est interrompue. Le micro est fermé.' : 'La conversation en direct n’a pas pu s’ouvrir.');
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      this.ctx = ctx;
      await ctx.resume().catch(() => {});
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      performance.mark('sentinelle-live-micro');
      if (this.over) return this.release();
      await ctx.audioWorklet.addModule('/live-capture.js');
      if (this.over) return this.release();
      const capture = new AudioWorkletNode(ctx, 'live-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      const silent = ctx.createGain();
      silent.gain.value = 0; // le micro n'est jamais rejoué dans les haut-parleurs
      ctx.createMediaStreamSource(this.stream).connect(capture).connect(silent).connect(ctx.destination);
      capture.port.onmessage = (ev: MessageEvent<{ pcm: ArrayBuffer }>) => {
        if (this.over) return;
        if (!this.ready) return void (this.early.length < 60 && this.early.push(ev.data.pcm));
        if (this.phase !== 'listening' || performance.now() < this.muteUntil) return;
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(ev.data.pcm);
      };
      this.micReady = true;
      this.listenWhenReady();
    } catch (e) {
      return this.finish('error', micError(e));
    }
  }

  send(m: LiveClientMessage) {
    // Une action faite à l'écran appelle une nouvelle phrase de l'assistant : elle ne doit pas être ignorée après une interruption.
    if (m.type === 'screen' || m.type === 'confirm_result') this.dropping = false;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** Court signal sonore : la personne sait, sans lire, qu'elle peut parler. */
  private beep() {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.09, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.18);
    } catch {
      /* pas de signal sonore : l'écran indique l'état */
    }
  }

  /** Voix de l'assistant : PCM 16 bits mono 24 kHz, joué bout à bout dès réception. */
  private play(data: ArrayBuffer) {
    const ctx = this.ctx;
    if (!ctx || this.over || this.dropping || data.byteLength < 2) return;
    const pcm = new Int16Array(data, 0, Math.floor(data.byteLength / 2));
    const buf = ctx.createBuffer(1, pcm.length, 24_000);
    const out = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.04, this.nextStart);
    this.nextStart = at + buf.duration;
    this.playing.add(src);
    if (this.settle) clearTimeout(this.settle);
    this.settle = null;
    // Repère de mesure : instant où le premier son d'une réponse commence réellement à être joué.
    if (this.phase !== 'speaking') performance.mark('sentinelle-live-son', { startTime: performance.now() + Math.max(0, (at - ctx.currentTime) * 1000) });
    this.setPhase('speaking');
    src.onended = () => {
      this.playing.delete(src);
      if (this.playing.size) return;
      // Fin probable de la réponse : on attend un court instant qu'aucun autre son n'arrive avant de rendre la parole.
      this.settle = setTimeout(() => {
        if (this.playing.size || this.over) return;
        this.muteUntil = performance.now() + 200;
        this.setPhase('listening');
      }, 160);
    };
    src.start(at);
  }

  private flush() {
    for (const s of this.playing) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* déjà arrêté */
      }
    }
    this.playing.clear();
    this.nextStart = 0;
    if (this.settle) clearTimeout(this.settle);
    this.settle = null;
  }

  /** L'utilisateur reprend la parole pendant une réponse : la lecture s'arrête, le micro est de nouveau transmis. */
  interrupt() {
    if (this.phase !== 'speaking') return;
    this.dropping = true;
    this.flush();
    this.muteUntil = performance.now() + 150;
    this.setPhase('listening');
  }

  stop() {
    this.send({ type: 'stop' });
    this.finish('stopped', 'Conversation arrêtée. Le micro est fermé.');
  }

  private release() {
    this.flush();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* déjà fermée */
      }
    }
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  private finish(reason: LiveEndReason, message: string) {
    if (this.over) return;
    const beforeReady = !this.serverReady;
    this.phase = 'idle';
    this.h.onPhase('idle');
    this.over = true;
    this.release();
    this.h.onEnd(reason, message, beforeReady);
  }
}

export interface LiveHandle {
  /** Transmet un message à la conversation ouverte (résultat d'une confirmation, action faite à l'écran). */
  send: (m: LiveClientMessage) => void;
  active: () => boolean;
}

const MicIcon = () => (
  <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7" />
  </svg>
);

/** Gros bouton « Parler » de la conversation en direct. Un appui ouvre la conversation, un second la ferme. */
export function LiveTalk({
  session,
  animalId,
  offline,
  maxSeconds,
  quiet,
  handle,
  onMessage,
  onActive,
  onFailedToOpen,
}: {
  session: Session | null;
  animalId: string | null;
  offline: boolean;
  maxSeconds: number;
  /** Masque la ligne d'explication au repos (affichage simple). */
  quiet: boolean;
  handle: Ref<LiveHandle>;
  onMessage: (m: LiveServerMessage) => void;
  onActive: (on: boolean) => void;
  /** La conversation n'a pas pu s'ouvrir : l'écran peut repasser à la dictée. */
  onFailedToOpen: (message: string) => void;
}) {
  const [phase, setPhase] = useState<LivePhase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [note, setNote] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const conv = useRef<LiveConversation | null>(null);
  const cb = useRef({ onMessage, onActive, onFailedToOpen });
  cb.current = { onMessage, onActive, onFailedToOpen };
  const support = liveUnavailable();
  const blocked = support ?? (offline || isSimulatedOffline() ? 'Conversation en direct indisponible hors connexion. Le texte reste utilisable.' : null);

  useImperativeHandle(handle, () => ({ send: (m) => conv.current?.send(m), active: () => conv.current !== null }), []);

  // Quitter l'écran ferme toujours le micro et la conversation.
  useEffect(
    () => () => {
      conv.current?.stop();
      conv.current = null;
    },
    [],
  );
  useEffect(() => {
    if (phase === 'idle') return;
    const t0 = Date.now() - elapsed * 1000;
    const t = setInterval(() => setElapsed((Date.now() - t0) / 1000), 500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase === 'idle']);

  const start = useCallback(() => {
    if (conv.current) return;
    setNote(null);
    setElapsed(0);
    const c = new LiveConversation({
      onPhase: setPhase,
      onMessage: (m) => cb.current.onMessage(m),
      onEnd: (reason, message, beforeReady) => {
        if (conv.current === c) conv.current = null;
        cb.current.onActive(false);
        const failed = reason === 'upstream' || reason === 'error' || reason === 'unavailable' || reason === 'auth';
        setNote({ tone: failed ? 'error' : 'info', text: message });
        if (failed && beforeReady) cb.current.onFailedToOpen(message);
      },
    });
    conv.current = c;
    cb.current.onActive(true);
    void c.start(session, animalId);
  }, [session, animalId]);

  const active = phase !== 'idle';
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const label = phase === 'listening' ? 'Arrêter la conversation' : phase === 'speaking' ? 'Arrêter la conversation' : phase === 'connecting' ? 'Connexion…' : 'Parler';
  const title = phase === 'listening' ? 'Je vous écoute' : phase === 'speaking' ? 'Je réponds' : phase === 'connecting' ? 'Micro…' : 'Parler';
  const status =
    phase === 'listening' ? (
      <>
        <b className="text-laterite">Microphone actif.</b> Parlez : je réponds dès que vous avez fini. Le son est transmis à l’assistant, jamais conservé. Touchez le bouton pour arrêter.
      </>
    ) : phase === 'speaking' ? (
      <>Je réponds à voix haute. Le micro n’est pas transmis pendant ma réponse : touchez « Interrompre » pour reprendre la parole.</>
    ) : phase === 'connecting' ? (
      'Ouverture de la conversation…'
    ) : (
      (note?.text ?? blocked ?? (quiet ? '' : 'Conversation en direct : appuyez, parlez, la réponse est dite dès que vous avez fini. Elle se ferme d’elle-même quand vous vous taisez.'))
    );

  return (
    <div className="v-voice v-voice-big" data-live={phase}>
      <div className="flex flex-wrap items-center justify-start gap-3">
        <button
          type="button"
          className="v-mic-big"
          data-recording={phase === 'listening' ? 'true' : undefined}
          data-speaking={phase === 'speaking' ? 'true' : undefined}
          data-busy={phase === 'connecting' ? 'true' : undefined}
          onClick={() => (active ? conv.current?.stop() : start())}
          disabled={!active && !!blocked}
          aria-describedby="live-status"
          aria-label={label}
        >
          {active && phase !== 'connecting' ? <span className="v-mic-stop" aria-hidden="true" /> : <MicIcon />}
        </button>
        <span className="min-w-0">
          <span className="v-display block text-[24px]">{title}</span>
          {active && phase !== 'connecting' && (
            <span className="num text-[15px] text-encre-2" aria-hidden="true">
              {mmss(elapsed)} / {mmss(maxSeconds)}
            </span>
          )}
        </span>
        {phase === 'speaking' && (
          <button type="button" className="v-chip" onClick={() => conv.current?.interrupt()}>
            Interrompre
          </button>
        )}
      </div>
      {status && (
        <p id="live-status" role="status" className={`mt-1.5 text-[14px] ${note?.tone === 'error' && !active ? 'text-danger' : 'text-encre-2'}`}>
          {status}
        </p>
      )}
    </div>
  );
}
