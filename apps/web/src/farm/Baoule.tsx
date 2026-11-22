import { useCallback, useEffect, useRef, useState } from 'react';
import type { BaouleIntent, BaouleReply, BaouleStatus } from '@sentinelle/contracts';
import { api, ApiFailure, NetworkError, type Session } from '../api';
import { Dictation } from './Voice';

/**
 * Note vocale en baoulé : l'utilisateur parle baoulé, l'application répond à la voix en baoulé. Les écrits restent en français.
 *
 * Ce n'est pas une conversation : une note courte, transcrite par un modèle ouvert sur le serveur, rapprochée d'une des
 * quelques questions connues, puis une réponse dite à partir de phrases fixes. Les faits et leurs preuves s'affichent en
 * français, comme pour toute autre question : c'est l'écrit qui fait foi.
 * Tant que les phrases n'ont pas été validées par un locuteur, l'écran le dit, à chaque réponse.
 */
const QUESTIONS: { intent: BaouleIntent; label: string }[] = [
  { intent: 'situation', label: 'Comment va mon élevage ?' },
  { intent: 'changes', label: 'Qu’est-ce qui a changé depuis hier ?' },
  { intent: 'missing', label: 'Qu’est-ce qui manque ?' },
  { intent: 'beacons', label: 'Quel animal s’est éloigné ?' },
];

const failure = (e: unknown, what: string): string =>
  e instanceof NetworkError ? `Connexion interrompue : ${what}. Réessayez.` : e instanceof ApiFailure ? e.body.message : `Échec : ${what}. Réessayez.`;

export function BaouleTalk({
  session,
  status,
  offline,
  detailed,
  maxSeconds,
  onStart,
  onReply,
}: {
  session: Session | null;
  status: BaouleStatus;
  offline: boolean;
  detailed: boolean;
  maxSeconds: number;
  /** Une note vocale part : l'écran coupe toute autre lecture à voix haute. */
  onStart: () => void;
  /** La lecture des données (en français) rejoint la conversation affichée, avec ses preuves. */
  onReply: (r: BaouleReply) => void;
}) {
  const [last, setLast] = useState<BaouleReply | null>(null);
  const [playing, setPlaying] = useState(false);
  const [teach, setTeach] = useState<BaouleIntent>('situation');
  const [taught, setTaught] = useState<string | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const cb = useRef({ onStart, onReply });
  cb.current = { onStart, onReply };

  const stop = useCallback(() => {
    player.current?.pause();
    player.current = null;
    setPlaying(false);
  }, []);
  useEffect(() => stop, [stop]);

  const play = useCallback(
    (audio: string) => {
      stop();
      const a = new Audio(`data:audio/wav;base64,${audio}`);
      player.current = a;
      a.onended = () => setPlaying(false);
      a.onerror = () => setPlaying(false);
      setPlaying(true);
      void a.play().catch(() => setPlaying(false));
    },
    [stop],
  );

  const ask = useCallback(
    async (wav: string): Promise<string | null> => {
      cb.current.onStart();
      stop();
      try {
        const r = await api<BaouleReply>('/api/assistant/baoule', { method: 'POST', session, timeoutMs: 150_000, body: { mimeType: 'audio/wav', audio: wav } });
        setLast(r);
        cb.current.onReply(r);
        if (r.audio) play(r.audio);
        return null;
      } catch (e) {
        return failure(e, 'la note vocale n’a pas été traitée, rien n’a été répondu');
      }
    },
    [session, play, stop],
  );

  const learn = useCallback(
    async (wav: string): Promise<string | null> => {
      setTaught(null);
      try {
        const r = await api<{ heard: string; examples: number }>('/api/assistant/baoule/exemple', { method: 'POST', session, timeoutMs: 150_000, body: { mimeType: 'audio/wav', audio: wav, intent: teach } });
        setTaught(`Formulation gardée pour « ${QUESTIONS.find((q) => q.intent === teach)!.label} » : « ${r.heard} » (transcription automatique). Seul ce texte est gardé, pas le son.`);
        return null;
      } catch (e) {
        return failure(e, 'la formulation n’a pas été gardée');
      }
    },
    [session, teach],
  );

  const blocked = !status.available ? (status.reason ?? 'Voix en baoulé indisponible sur ce serveur.') : offline ? 'Voix en baoulé indisponible hors connexion : elle passe par le serveur.' : '';

  return (
    <section className="mt-4 border-t border-encre/15 pt-3" aria-labelledby="baoule-h">
      <h3 id="baoule-h" className="text-[15.5px] font-semibold">
        Parler en baoulé <span className="v-field-flag ml-1 text-amber">à l’essai</span>
      </h3>
      {/* Toujours visible : ce que cette voix sait faire, et ce qui n'est pas vérifié. */}
      <p role="note" aria-label="Limites de la voix en baoulé" className="mt-1 text-[13.5px] text-encre-2">
        {status.validated ? 'Phrases validées par un locuteur.' : 'Les phrases dites en baoulé sont un premier jet, pas encore validé par un locuteur.'} Quatre questions sont reconnues ; les chiffres dits sont ceux lus dans les données, et la
        réponse écrite, en français, fait foi. Comptez une dizaine de secondes.
      </p>
      <div className="mt-2">
        <Dictation
          session={session}
          available={status.available}
          maxSeconds={maxSeconds}
          offline={offline}
          unavailableReason={blocked}
          onText={() => {}}
          handle={ask}
          labels={{ idle: 'Parler en baoulé', busy: 'J’écoute et je réponds…', hint: 'Appuyez, posez votre question en baoulé : l’enregistrement s’arrête quand vous vous taisez.' }}
          quiet={!detailed}
        />
      </div>
      {last && (
        <div className="mt-2 text-[14px]" role="status" aria-label="Dernière note vocale en baoulé">
          <p>
            <span className="text-encre-2">Entendu (transcription automatique) :</span> « {last.heard || 'rien d’audible'} »
          </p>
          <p>
            <span className="text-encre-2">{last.question ? `Question retenue : ${last.question}` : 'Question non reconnue : aucune donnée lue, rien n’est deviné.'}</span>
          </p>
          <p>
            <span className="text-encre-2">{last.audio ? 'Dit en baoulé :' : 'La voix a échoué, rien n’a été dit. Texte prévu :'}</span> « {last.spoken} »
          </p>
          <p>
            <span className="text-encre-2">Sens :</span> {last.spokenFr}
          </p>
          {last.audio && (
            <button type="button" className="v-chip mt-1.5" aria-pressed={playing} onClick={() => (playing ? stop() : play(last.audio!))}>
              {playing ? '■ Arrêter' : '▶ Réécouter la réponse en baoulé'}
            </button>
          )}
          {detailed && (
            <p className="v-meta mt-1">
              Ressemblance avec la question retenue : {Math.round(last.score * 100)} %. Écoute : {(last.listenMs / 1000).toFixed(1)} s, voix : {(last.speakMs / 1000).toFixed(1)} s. Modèles ouverts exécutés sur le serveur, sans service en ligne.
            </p>
          )}
        </div>
      )}
      {detailed && status.available && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[14px]">Apprendre une formulation (par une personne qui parle baoulé){status.examples ? ` · ${status.examples} gardée${status.examples > 1 ? 's' : ''}` : ''}</summary>
          <p className="v-meta mt-1.5">La personne choisit une question, puis la pose en baoulé, à sa façon, en une phrase entière. Sa formulation sert ensuite de point de comparaison.</p>
          <label className="mt-2 block text-[14px]" htmlFor="baoule-teach">
            Question à apprendre
          </label>
          <select id="baoule-teach" className="mt-1 w-full border border-encre/30 bg-transparent px-2 py-1.5 text-[15px]" value={teach} onChange={(e) => setTeach(e.target.value as BaouleIntent)}>
            {QUESTIONS.map((q) => (
              <option key={q.intent} value={q.intent}>
                {q.label}
              </option>
            ))}
          </select>
          <div className="mt-2">
            <Dictation
              session={session}
              available={status.available}
              maxSeconds={maxSeconds}
              offline={offline}
              unavailableReason={blocked}
              onText={() => {}}
              handle={learn}
              labels={{ idle: 'Enregistrer cette formulation', busy: 'Transcription…', hint: 'Appuyez, dites la question en baoulé, puis taisez-vous.' }}
            />
          </div>
          {taught && (
            <p role="status" className="mt-1.5 text-[14px]">
              {taught}
            </p>
          )}
        </details>
      )}
    </section>
  );
}
