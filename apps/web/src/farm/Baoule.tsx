import { useCallback, useEffect, useRef, useState } from 'react';
import type { BaouleIntent, BaouleReply, BaouleStatus } from '@sentinelle/contracts';
import { api, ApiFailure, NetworkError, type Session } from '../api';
import { askBaoule, playBaouleReply, prepareBaoule, stopBaouleVoice, unlockBaouleVoice, type BaouleVoiceState } from './baouleVoice';
import { Dictation } from './Voice';

/**
 * Voix en baoulé : l'utilisateur parle baoulé, ou touche une question, et l'application répond à la voix en baoulé.
 * Les écrits restent en français.
 *
 * Ce n'est pas une conversation : une note courte, transcrite par un modèle ouvert sur le serveur, rapprochée d'une des
 * quelques questions connues, puis une réponse dite à partir de phrases fixes. Les faits et leurs preuves s'affichent en
 * français, comme pour toute autre question : c'est l'écrit qui fait foi.
 * Tant que les phrases n'ont pas été validées par un locuteur, l'écran le dit, à chaque réponse.
 *
 * Après les essais au téléphone du 22/11 (lenteur, pas de réponse entendue) :
 * - ce qui a été entendu et les faits s'affichent dès la fin de l'écoute ; la voix suit, sans que l'écran l'attende ;
 * - le lecteur de la voix est débloqué pendant l'appui, pour que le téléphone accepte de jouer la réponse ;
 * - si la question dite n'est pas reconnue, les quatre questions restent à portée de doigt : la réponse est alors dite en
 *   baoulé sans passer par l'écoute ;
 * - « Réponses en baoulé » fait dire en baoulé l'alerte de balise et les réponses aux questions posées en français.
 */
const QUESTIONS: { intent: BaouleIntent; label: string; short: string }[] = [
  { intent: 'situation', label: 'Comment va mon élevage ?', short: 'Mon élevage' },
  { intent: 'changes', label: 'Qu’est-ce qui a changé depuis hier ?', short: 'Depuis hier' },
  { intent: 'missing', label: 'Qu’est-ce qui manque ?', short: 'Ce qui manque' },
  { intent: 'beacons', label: 'Quelle balise s’est éloignée ?', short: 'Balise éloignée' },
];

const failure = (e: unknown, what: string): string =>
  e instanceof NetworkError ? `Connexion interrompue : ${what}. Réessayez.` : e instanceof ApiFailure ? e.body.message : `Échec : ${what}. Réessayez.`;

const VOICE_TEXT: Record<Exclude<BaouleVoiceState, null>, string> = {
  loading: 'La voix se prépare…',
  playing: 'Réponse en cours, en baoulé.',
  blocked: 'Le navigateur attend un appui pour jouer le son.',
  failed: 'La voix a échoué : rien n’a été dit. La réponse écrite reste entière.',
};

export function BaouleTalk({
  session,
  status,
  offline,
  detailed,
  maxSeconds,
  replies,
  onReplies,
  dataVersion,
  onStart,
  onReply,
}: {
  session: Session | null;
  status: BaouleStatus;
  offline: boolean;
  detailed: boolean;
  maxSeconds: number;
  /** « Réponses en baoulé » : l'alerte de balise et les réponses aux questions en français sont dites en baoulé. */
  replies: boolean;
  onReplies: (on: boolean) => void;
  /** Change quand les données de l'écran changent : la voix des réponses du moment est alors préparée de nouveau. */
  dataVersion: number;
  /** Une question part : l'écran coupe toute autre lecture à voix haute. */
  onStart: () => void;
  /** La lecture des données (en français) rejoint la conversation affichée, avec ses preuves. */
  onReply: (r: BaouleReply) => void;
}) {
  const [last, setLast] = useState<BaouleReply | null>(null);
  const [voice, setVoice] = useState<BaouleVoiceState>(null);
  const [asking, setAsking] = useState<BaouleIntent | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [teach, setTeach] = useState<BaouleIntent>('situation');
  const [taught, setTaught] = useState<string | null>(null);
  const cb = useRef({ onStart, onReply });
  cb.current = { onStart, onReply };
  useEffect(() => () => stopBaouleVoice(), []);

  // La voix des réponses probables est préparée dès que l'écran s'ouvre, puis à chaque changement des données :
  // quand la question arrive, la phrase et son nombre sont déjà prononcés.
  useEffect(() => {
    if (status.available && !offline) void prepareBaoule(session);
  }, [status.available, offline, session, dataVersion]);

  const say = useCallback((r: BaouleReply) => void playBaouleReply(r, session, setVoice), [session]);
  const received = useCallback(
    (r: BaouleReply) => {
      setLast(r);
      cb.current.onReply(r);
      say(r);
    },
    [say],
  );

  /** Note vocale : l'écoute d'abord (les faits s'affichent), la voix ensuite. */
  const ask = useCallback(
    async (wav: string): Promise<string | null> => {
      cb.current.onStart();
      setProblem(null);
      try {
        received(await api<BaouleReply>('/api/assistant/baoule', { method: 'POST', session, timeoutMs: 100_000, body: { mimeType: 'audio/wav', audio: wav, voice: 'later' } }));
        return null;
      } catch (e) {
        return failure(e, 'la note vocale n’a pas été traitée, rien n’a été répondu');
      }
    },
    [session, received],
  );

  /** Question touchée : pas d'écoute, la réponse est lue dans les données puis dite en baoulé. */
  const choose = useCallback(
    async (intent: BaouleIntent) => {
      unlockBaouleVoice();
      cb.current.onStart();
      setProblem(null);
      setAsking(intent);
      try {
        received(await askBaoule(intent, session));
      } catch (e) {
        setProblem(failure(e, 'la question n’a pas été traitée, rien n’a été répondu'));
      } finally {
        setAsking(null);
      }
    },
    [session, received],
  );

  const learn = useCallback(
    async (wav: string): Promise<string | null> => {
      setTaught(null);
      try {
        const r = await api<{ heard: string; examples: number }>('/api/assistant/baoule/exemple', { method: 'POST', session, timeoutMs: 100_000, body: { mimeType: 'audio/wav', audio: wav, intent: teach } });
        setTaught(`Formulation gardée pour « ${QUESTIONS.find((q) => q.intent === teach)!.label} » : « ${r.heard} » (transcription automatique). Seul ce texte est gardé, pas le son.`);
        return null;
      } catch (e) {
        return failure(e, 'la formulation n’a pas été gardée');
      }
    },
    [session, teach],
  );

  const blocked = !status.available ? (status.reason ?? 'Voix en baoulé indisponible sur ce serveur.') : offline ? 'Voix en baoulé indisponible hors connexion : elle passe par le serveur.' : '';
  const unknown = last?.intent === 'unknown';

  return (
    <section className="v-bci mt-4" aria-labelledby="baoule-h">
      <h3 id="baoule-h" className="text-[15.5px] font-semibold">
        Parler en baoulé <span className="v-field-flag ml-1 text-amber">à l’essai</span>
      </h3>
      {/* Toujours visible : ce que cette voix sait faire, et ce qui n'est pas vérifié. */}
      <p role="note" aria-label="Limites de la voix en baoulé" className="mt-1 text-[13.5px] text-encre-2">
        {status.validated ? 'Phrases validées par un locuteur.' : 'Les phrases dites en baoulé sont un premier jet, pas encore validé par un locuteur.'} Quatre questions sont reconnues ; les chiffres dits sont ceux lus dans les données, et la
        réponse écrite, en français, fait foi.
      </p>

      {/* L'appui débloque le lecteur : c'est ce qui permet au téléphone de jouer la réponse, qui arrive après l'écoute. */}
      <div className="mt-2" onPointerDownCapture={unlockBaouleVoice} onKeyDownCapture={unlockBaouleVoice}>
        <Dictation
          session={session}
          available={status.available}
          maxSeconds={maxSeconds}
          offline={offline}
          unavailableReason={blocked}
          onText={() => {}}
          handle={ask}
          labels={{ idle: 'Parler en baoulé', busy: 'J’écoute…', hint: 'Appuyez, posez votre question en baoulé, en une phrase entière : l’enregistrement s’arrête quand vous vous taisez.' }}
          quiet={!detailed}
        />
      </div>

      <div className="mt-3" role="group" aria-label="Questions dont la réponse est dite en baoulé">
        <p className="text-[13.5px] text-encre-2">{unknown ? 'Question non reconnue. Touchez-en une : la réponse est dite en baoulé.' : 'Ou touchez une question : la réponse est dite en baoulé.'}</p>
        <div className="v-bci-row mt-1.5" data-urge={unknown ? 'true' : undefined}>
          {QUESTIONS.map((q) => (
            <button key={q.intent} type="button" className="v-bci-q" title={q.label} disabled={!!blocked || asking !== null} data-busy={asking === q.intent ? 'true' : undefined} onClick={() => void choose(q.intent)}>
              <span aria-hidden="true" className="v-bci-mark" />
              <span>
                {q.short}
                <span className="sr-only"> : {q.label} Réponse dite en baoulé.</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {problem && (
        <p role="alert" className="mt-2 border-l-[3px] border-danger pl-3 text-[14px]">
          {problem}
        </p>
      )}

      {last && (
        <div className="v-bci-last mt-3" role="status" aria-label="Dernière réponse en baoulé">
          {last.via === 'choice' ? (
            <p>
              <span className="text-encre-2">Question choisie :</span> {last.question}
            </p>
          ) : (
            <>
              <p>
                <span className="text-encre-2">Entendu (transcription automatique) :</span> « {last.heard || (last.silence ? 'aucune parole dans l’enregistrement' : 'rien d’audible')} »
              </p>
              <p>
                <span className="text-encre-2">{last.question ? `Question retenue : ${last.question}` : 'Question non reconnue : aucune donnée lue, rien n’est deviné.'}</span>
              </p>
            </>
          )}
          <p>
            <span className="text-encre-2">{voice === 'failed' ? 'Texte prévu, non dit :' : 'En baoulé :'}</span> « {last.spoken} »
          </p>
          <p>
            <span className="text-encre-2">Sens :</span> {last.spokenFr}
          </p>
          <p className="mt-1.5 flex flex-wrap items-center gap-2">
            {voice === 'playing' ? (
              <button type="button" className="v-chip" onClick={() => stopBaouleVoice()}>
                ■ Arrêter
              </button>
            ) : (
              <button type="button" className={voice === 'blocked' ? 'v-btn-go' : 'v-chip'} style={voice === 'blocked' ? { minHeight: 44 } : undefined} disabled={voice === 'loading'} onClick={() => say(last)}>
                ▶ {voice === 'blocked' ? 'Écouter la réponse en baoulé' : 'Réécouter la réponse en baoulé'}
              </button>
            )}
            {voice && (
              <span className={`text-[14px] ${voice === 'failed' ? 'text-danger' : 'text-encre-2'}`} data-voice={voice}>
                {VOICE_TEXT[voice]}
              </span>
            )}
          </p>
          {detailed && (
            <p className="v-meta mt-1">
              {last.via === 'choice' ? 'Question choisie au toucher : aucune écoute.' : `Ressemblance avec la question retenue : ${Math.round(last.score * 100)} %. Écoute : ${(last.listenMs / 1000).toFixed(1)} s${status.engine ? ` (moteur ${status.engine})` : ''}.`} Modèles ouverts exécutés sur le
              serveur, sans service en ligne.
            </p>
          )}
        </div>
      )}

      <p className="mt-3">
        <button type="button" className="v-chip" aria-pressed={replies} disabled={!status.available} onClick={() => (unlockBaouleVoice(), onReplies(!replies))}>
          Réponses à voix haute en baoulé : {replies ? 'oui' : 'non'}
        </button>
        <span className="mt-1 block text-[13.5px] text-encre-2">
          {replies ? 'L’alerte de balise et les réponses qui ont une phrase baoulé (élevage, depuis hier, manques, balises) sont dites en baoulé. Les autres restent dites en français.' : 'Activé, l’alerte de balise et les réponses aux questions posées en français sont dites en baoulé quand une phrase baoulé existe.'}
        </span>
      </p>

      {detailed && status.available && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[14px]">Apprendre une formulation (par une personne qui parle baoulé){status.examples ? ` · ${status.examples} gardée${status.examples > 1 ? 's' : ''}` : ''}</summary>
          <p className="v-meta mt-1.5">La personne choisit une question, puis la pose en baoulé, à sa façon, en une phrase entière. Sa formulation sert ensuite de point de comparaison : c’est ce qui rend l’écoute fiable avec de vraies voix.</p>
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
