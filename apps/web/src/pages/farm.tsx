import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { beaconName, draftFingerprint, isSpokenCancellation, normalizeSpoken, spokenConfirmation, type AnimalData, type AssistantReply, type BeaconsData, type ChangesData, type LiveServerMessage, type ObservationDraftData, type SiteSummary, type SituationData, type ToolResult } from '@sentinelle/contracts';
import { api, ApiFailure, errorMessage, NetworkError } from '../api';
import { enqueueObservation } from '../local';
import { formatTemporal, type TemporalValue } from '@sentinelle/domain';
import { go, useApp } from '../state';
import { BeaconAlert, BeaconsPanel } from '../farm/Beacons';
import { Constellation } from '../farm/Constellation';
import { Zone } from '../farm/Zone';
import { LiveTalk, type LiveHandle } from '../farm/Live';
import { canSpeak, Dictation, playSpeech, stopSpeech, voiceRepliesPref, type MicPhase, type VoiceVia } from '../farm/Voice';
import { DraftCard, describeDraft, EvidenceDialog, fmtInstant, fmtState, PlainAnswer, plainSentence, ResultView, SimpleDraft, SourceChip, Timeline, type DraftValues } from '../farm/parts';
import { conversation, display, draftOf, firstResult, refsOf, resultDigest, resultKey, resultSummary, session as farmSession, useDetailed, useExchanges, useFresh, useWrites, type Exchange } from '../farm/store';

/**
 * « Mon élevage aujourd'hui » : écran d'ouverture de SENTINELLE VIVANT.
 * Affichage simple par défaut (voix d'abord, phrases courtes, gros boutons) ; l'affichage détaillé montre d'emblée les natures
 * d'information, les sources, les dates et les limites, qui restent sinon à un clic (« Détails et preuves »).
 * La conversation (à droite) et la représentation de l'exploitation (à gauche) forment un seul écran :
 * une réponse met en évidence ses événements dans la constellation et la chronologie, une écriture confirmée y apparaît.
 * Toutes les données viennent des fonctions /api/farm/* ; rien n'est simulé hors connexion.
 */

const dayFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Abidjan', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const QUICK = ['Qu’est-ce qui a changé depuis hier ?', 'Quelles informations manquent ?', 'Montre-moi B-017'];

/** Lecture d'une fonction de l'exploitation, avec repli sur la dernière lecture conservée sur l'appareil. */
function useTool<T>(path: string | null, cacheKey: string | null, version: number) {
  const { session, db, connection } = useApp();
  const [state, setState] = useState<{ path: string | null; data: ToolResult<T> | null; error: unknown; loading: boolean; local: boolean }>({ path, data: null, error: null, loading: !!path, local: false });
  const online = connection === 'online';
  useEffect(() => {
    if (!path) return setState({ path, data: null, error: null, loading: false, local: false });
    let alive = true;
    setState((s) => ({ path, data: s.path === path ? s.data : null, error: null, loading: true, local: s.path === path ? s.local : false }));
    api<ToolResult<T>>(path, { session })
      .then(async (data) => {
        if (!alive) return;
        setState({ path, data, error: null, loading: false, local: false });
        if (cacheKey && db) await db.cache.put({ key: cacheKey, value: data, savedAt: data.asOf }).catch(() => {});
      })
      .catch(async (error) => {
        const cached = cacheKey && db ? await db.cache.get(cacheKey).catch(() => undefined) : undefined;
        if (!alive) return;
        setState((s) => ({ path, data: (cached?.value as ToolResult<T> | undefined) ?? (s.path === path ? s.data : null), error, loading: false, local: true }));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, session, db, version, online]);
  return state.path === path ? state : { path, data: null, error: null, loading: !!path, local: false };
}

function localDraftReply(animalId: string | null): AssistantReply {
  const missing = { value: null, status: 'MISSING' as const, message: null };
  const data: ObservationDraftData = { sourceText: null, animal: animalId ? { value: animalId, status: 'DEDUCED', message: 'Animal affiché à l’écran. À vérifier.' } : missing, site: missing, eventTime: missing, note: missing, ready: false, possibleDuplicate: null };
  return {
    mode: 'direct',
    provider: null,
    intent: 'draft',
    text: null,
    notice: 'Saisie manuelle préparée sur cet appareil, sans le serveur.',
    results: [{ tool: 'prepare_observation', params: {}, asOf: new Date().toISOString(), period: null, statements: [{ nature: 'SUGGESTION', text: 'Brouillon préparé sur cet appareil. Rien n’est enregistré tant que vous n’avez pas confirmé.', sources: [] }], data, sources: [], limits: ['Hors connexion : les champs seront vérifiés par le serveur au moment de la transmission.'] }],
    ungrounded: false,
    suggestions: [],
  };
}

/**
 * Texte dit à voix haute pour une réponse : le texte de l'IA, sinon les premières phrases de la lecture, sans les identifiants
 * de source. Un brouillon est décrit en entier (animal, lieu, date, texte) pour qu'une personne qui ne lit pas sache ce qu'elle
 * va confirmer. Rien n'est dit qui ne soit pas affiché.
 */
function spokenText(reply: AssistantReply | null, sites: { id: string; name: string }[] = []): string {
  if (!reply) return '';
  const draft = reply.results.find((r) => r.tool === 'prepare_observation') as ToolResult<ObservationDraftData> | undefined;
  let said: string;
  if (draft) {
    const d = draft.data;
    const site = d.site.value ? (sites.find((x) => x.id === d.site.value)?.name ?? d.site.value) : null;
    said = [
      'Brouillon préparé. Rien n’est enregistré pour l’instant.',
      d.animal.value ? `Animal : ${d.animal.value}.` : 'L’animal reste à indiquer.',
      site ? `Lieu : ${site}${d.site.status === 'DEDUCED' ? ', proposé, à vérifier' : ''}.` : 'Le lieu reste à indiquer.',
      d.eventTime.value ? `Date de l’événement : ${formatTemporal(d.eventTime.value as TemporalValue)}.` : 'La date reste à indiquer.',
      d.note.value ? `Ce qui est constaté : ${d.note.value}.` : 'Le texte reste à compléter.',
      d.ready ? 'Si c’est exact, dites « je confirme », ou appuyez sur le bouton vert. Sinon, dites « non ».' : 'Complétez ce qui manque avant de confirmer.',
    ].join(' ');
  } else {
    said = reply.text ?? reply.results[0]?.statements.slice(0, 4).map((st) => st.text).join(' ') ?? reply.notice ?? '';
  }
  return said
    .replace(/\[(?:OBS|REC|TASK|ANIMAL|SITE|DEVICE):[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const newExchange = (question: string): Exchange => ({ id: crypto.randomUUID(), question, askedAt: new Date().toISOString(), pending: true, error: null, offline: false, reply: null, key: null, update: null, compared: null, draft: null, receipt: null });

/** Ce qu'a donné la confirmation d'un brouillon : reçu du serveur, gardé sur l'appareil, refusé, ou brouillon incomplet. */
type ConfirmOutcome = 'RECEIVED' | 'QUEUED' | 'FAILED' | 'INVALID';
/** Conversation en direct : comment la réponse a été produite. Toujours affiché avec la réponse. */
const LIVE_NOTICE = 'Réponse dite en direct par l’IA. Le texte affiché est la transcription automatique de sa voix : il n’a pas été contrôlé avant d’être entendu. Les lectures ci-dessous sont les données consultées pendant cet échange : ce sont elles qui font foi.';
const LIVE_UNGROUNDED = 'Réponse dite en direct par l’IA sans lecture des données de l’exploitation : à prendre comme une suggestion, pas comme un fait.';
const LIVE_ACTION = 'Action faite sur le brouillon pendant cet échange : son état (reçu du serveur, abandon) est affiché sur le brouillon lui-même.';
interface LiveTurn {
  id: string;
  heard: string;
  said: string;
  results: ToolResult[];
  acted: boolean;
  /** Identifiant donné par le serveur au brouillon préparé pendant ce tour : une confirmation à la voix le vise, lui et pas un autre. */
  draftId: string | null;
}
/** Un brouillon lu ne se confirme à la voix que pendant ce délai ; au-delà, il reste le bouton. */
const VOICE_CONFIRM_MAX_MS = 5 * 60_000;
/** Mode discussion : la session s'arrête d'elle-même après cette durée ou ce nombre d'échanges. */
const DISCUSSION_MAX_MS = 3 * 60_000;
const DISCUSSION_MAX_TURNS = 12;

const SpeakerIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 9v6h4l5 4V5L8 9H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
  </svg>
);

/** Un échange : la question, puis la réponse en affichage simple (phrases, gros boutons) ou détaillé (natures, sources, limites). */
function ExchangeView({
  ex,
  detailed,
  sites,
  canHear,
  speaking,
  voiceState,
  draftErrors,
  onListen,
  onAsk,
  onSource,
  onManual,
  onConfirm,
  onDiscard,
}: {
  ex: Exchange;
  detailed: boolean;
  sites: SiteSummary[];
  canHear: boolean;
  speaking: boolean;
  voiceState: 'loading' | VoiceVia | null;
  draftErrors: Partial<Record<'animal' | 'site' | 'eventTime' | 'note', string>>;
  onListen: () => void;
  onAsk: (q: string) => void;
  onSource: (ref: string) => void;
  onManual: () => void;
  onConfirm: (v: DraftValues) => void;
  onDiscard: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const draft = draftOf(ex);
  const reply = ex.reply;
  const draftOpen = !!draft && (ex.draft === 'open' || ex.draft === 'saving');
  const others = reply?.results.filter((r) => r.tool !== 'prepare_observation') ?? [];
  const sourceCount = refsOf(reply).length;
  const listenButton = canHear && reply && spokenText(reply, sites) && (
    <p className="flex flex-wrap items-center gap-2">
      <button type="button" className="v-chip" aria-pressed={speaking} onClick={onListen}>
        {!detailed && <SpeakerIcon />}
        <span className={detailed ? '' : 'ml-1.5'}>{speaking ? '■ Arrêter la lecture' : detailed ? '▶ Écouter la réponse' : 'Écouter'}</span>
      </button>
      {speaking && (
        <span className="v-meta" role="status">
          {voiceState === 'loading' ? 'La voix se prépare…' : voiceState === 'server' ? 'Voix de synthèse (Gemini). Elle lit le texte affiché, sans rien ajouter.' : voiceState === 'device' ? 'Voix de synthèse de cet appareil. Elle lit le texte affiché, sans rien ajouter.' : ''}
        </span>
      )}
    </p>
  );
  const aiText = reply?.text ? (
    <div className="v-statement" data-nature={reply.ungrounded ? 'SUGGESTION' : 'FACT'}>
      <span className="v-nature text-encre-2">
        <span className="v-nature-glyph" aria-hidden="true">
          ✎
        </span>
        {reply.ungrounded ? (reply.live ? 'Suggestion dite en direct par l’IA' : 'Suggestion formulée par l’IA') : reply.live ? `Dit en direct par l’IA (transcription automatique) · ${reply.provider}` : `Formulé par l’IA · ${reply.provider}`}
      </span>
      <p className="max-w-[64ch] text-[16px] leading-[1.5] whitespace-pre-line">
        {/* Les identifiants cités par le modèle deviennent des sources cliquables (ils ont été contrôlés par le serveur). */}
        {reply.text.split(/\[((?:OBS|REC|TASK|ANIMAL|SITE|DEVICE):[A-Za-z0-9@-]+)\]/g).map((part, i) => (i % 2 ? <SourceChip key={i} sourceRef={part} onSource={onSource} /> : part))}
      </p>
    </div>
  ) : null;
  const updateCard = ex.update && (
    <div className="v-update">
      <p className="v-field-flag text-laterite">Réponse mise à jour</p>
      <p className="mt-1">
        À <span className="num">{fmtState(ex.update.previousAsOf).slice(11)}</span> : {ex.update.previousSummary}.
        <br />
        Maintenant : <b>{ex.update.currentSummary}</b>.
      </p>
      <button type="button" className="btn btn-sm mt-2" onClick={() => onAsk('Pourquoi ta réponse a changé ?')}>
        Pourquoi ta réponse a changé ?
      </button>
    </div>
  );
  const compareCard = ex.compared && (
    <div className="v-update">
      <p className="v-field-flag text-laterite">Comparaison de deux états enregistrés</p>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="num text-encre-2">{fmtState(ex.compared.from).slice(11)}</dt>
        <dd>{ex.compared.before}</dd>
        <dt className="num text-encre-2">{fmtState(ex.compared.to).slice(11)}</dt>
        <dd>
          <b>{ex.compared.after}</b>
        </dd>
      </dl>
    </div>
  );
  const receiptBlocks = (
    <>
      {ex.receipt?.state === 'RECEIVED' && (
        <div className="v-receipt" role="status">
          <p className="v-field-flag text-paturage">✓ Reçu par le serveur</p>
          <p className="mt-1">
            Observation enregistrée, reçue le <span className="num">{ex.receipt.receivedAt ? (detailed ? fmtState(ex.receipt.receivedAt) : fmtState(ex.receipt.receivedAt).slice(0, 16)) : ''}</span>.
          </p>
          {detailed && <p className="v-meta mt-0.5">{ex.receipt.message}</p>}
          <p className="mt-2">
            {detailed && <SourceChip sourceRef={ex.receipt.ref} onSource={onSource} />}
            <button type="button" className="v-chip" onClick={() => onAsk(QUICK[0]!)}>
              {detailed ? 'Reposer : qu’est-ce qui a changé depuis hier ?' : 'Voir ce qui a changé depuis hier'}
            </button>
          </p>
        </div>
      )}
      {ex.receipt?.state === 'QUEUED' && (
        <div className="v-update" role="status">
          <p className="v-field-flag text-laterite">↑ Sur cet appareil seulement</p>
          <p className="mt-1">Le serveur n’a pas confirmé la réception. L’observation est conservée sur cet appareil et sera transmise depuis « Déclarations » au retour du réseau. Elle n’apparaît pas encore dans la chronologie.</p>
          {detailed && <p className="v-meta mt-0.5">{ex.receipt.message}</p>}
          <button type="button" className="btn btn-sm mt-2" onClick={() => go('envois')}>
            Ouvrir les déclarations
          </button>
        </div>
      )}
      {ex.receipt?.state === 'FAILED' && (
        <p role="alert" className="border-l-[3px] border-danger pl-3">
          Le serveur a refusé l’enregistrement : {ex.receipt.message}. Rien n’a été écrit. Corrigez le brouillon puis confirmez de nouveau.
        </p>
      )}
    </>
  );
  const unknownHelp = reply?.intent === 'unknown' && (
    <div className="flex flex-wrap gap-2">
      {reply.suggestions.slice(0, 3).map((q) => (
        <button key={q} type="button" className="v-chip" onClick={() => onAsk(q)}>
          {q}
        </button>
      ))}
      <button type="button" className="v-chip" onClick={onManual}>
        Ajouter une observation
      </button>
    </div>
  );
  const form = draft && draftOpen && <DraftCard id={`d-${ex.id}`} draft={draft.data} sites={sites} busy={ex.draft === 'saving'} serverErrors={draftErrors} onConfirm={onConfirm} onDiscard={onDiscard} onSource={onSource} />;

  return (
    <article className="v-exchange v-appear" aria-label={`Question : ${ex.question}`}>
      <p className="v-question">{ex.question}</p>
      {detailed && <p className="v-meta num mt-0.5">{fmtState(ex.askedAt).slice(11)}</p>}
      {ex.pending && (
        <div className="mt-3 space-y-2" role="status" aria-label="Lecture des données en cours">
          <div className="v-skeleton h-4 w-3/4" />
          <div className="v-skeleton h-4 w-1/2" />
        </div>
      )}
      {ex.error && (
        <div role="alert" className="mt-3 border-l-[3px] border-danger pl-3">
          <p>{ex.error}</p>
          {ex.offline && (
            <button type="button" className="btn btn-sm mt-2" onClick={onManual}>
              Préparer une observation (saisie manuelle)
            </button>
          )}
        </div>
      )}
      {reply && detailed && (
        <div className="mt-3 space-y-3">
          <p className="v-notice">{reply.notice}</p>
          {listenButton}
          {updateCard}
          {compareCard}
          {aiText}
          {others.map((r, i) => (
            <ResultView key={i} result={r} onSource={onSource} />
          ))}
          {draft && draftOpen && (
            <>
              <ResultView result={draft} onSource={onSource} />
              {form}
            </>
          )}
          {ex.draft === 'discarded' && <p className="v-notice">Brouillon abandonné. Rien n’a été enregistré.</p>}
          {receiptBlocks}
          {unknownHelp}
          {others.length > 0 && !draft && <p className="v-meta">{sourceCount ? `${sourceCount} source${sourceCount > 1 ? 's' : ''} mise${sourceCount > 1 ? 's' : ''} en évidence dans la constellation et la chronologie.` : 'Aucune source à mettre en évidence.'}</p>}
        </div>
      )}
      {reply && !detailed && (
        <div className="mt-3 space-y-3">
          {updateCard}
          {compareCard}
          {reply.text ? (
            <p className="max-w-[60ch] text-[18px] leading-[1.5] whitespace-pre-line">{plainSentence(reply.text.replace(/\s*\[(?:OBS|REC|TASK|ANIMAL|SITE|DEVICE):[^\]]+\]/g, ''))}</p>
          ) : (
            others[0] && <PlainAnswer result={others[0]} />
          )}
          {/* Ce qui touche à la vérité de la réponse reste visible même en affichage simple. */}
          {(reply.ungrounded || (others.length === 0 && !draft)) && <p className="v-notice">{reply.notice}</p>}
          {reply.live && !reply.ungrounded && others.length > 0 && <p className="v-meta">Dit en direct par l’IA (transcription automatique). Les données lues sont dans « Détails et preuves ».</p>}
          {draft && draftOpen && (draft.data.ready && !editing ? <SimpleDraft draft={draft.data} sites={sites} busy={ex.draft === 'saving'} onConfirm={onConfirm} onDiscard={onDiscard} onEdit={() => setEditing(true)} /> : form)}
          {ex.draft === 'discarded' && <p className="v-notice">Brouillon abandonné. Rien n’a été enregistré.</p>}
          {receiptBlocks}
          {unknownHelp}
          {listenButton}
          {(others.length > 0 || draft) && (
            <details className="v-meta">
              <summary className="cursor-pointer text-[14.5px]">Détails et preuves{sourceCount ? ` (${sourceCount} source${sourceCount > 1 ? 's' : ''})` : ''}</summary>
              <div className="mt-2 space-y-3 text-encre">
                <p className="v-notice">{reply.notice}</p>
                {aiText}
                {reply.results.map((r, i) => (
                  <ResultView key={i} result={r} onSource={onSource} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </article>
  );
}

export function FarmHome({ animalId }: { animalId: string | null }) {
  const { session, db, connection, health, syncNow, bumpOutbox, outboxVersion } = useApp();
  const exchanges = useExchanges();
  const fresh = useFresh();
  const writes = useWrites();
  const detailed = useDetailed();
  const [reloads, setReloads] = useState(0);
  const version = writes + reloads;
  const [text, setText] = useState('');
  const [sourceRef, setSourceRef] = useState<string | null>(null);
  const [draftErrors, setDraftErrors] = useState<Record<string, Partial<Record<'animal' | 'site' | 'eventTime' | 'note', string>>>>({});
  const [pendingOutbox, setPendingOutbox] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);

  const situation = useTool<SituationData>('/api/farm/situation', 'farm.situation', version);
  const changes = useTool<ChangesData>('/api/farm/changes', 'farm.changes', version);
  const animal = useTool<AnimalData>(animalId ? `/api/farm/animals/${encodeURIComponent(animalId)}` : null, animalId ? `farm.animal.${animalId}` : null, version);
  // Balises de démonstration : relues toutes les 4 secondes tant qu'au moins une est suivie (lecture réelle, pas un flux simulé).
  const [beaconTick, setBeaconTick] = useState(0);
  const beacons = useTool<BeaconsData>('/api/farm/devices', null, version + beaconTick);
  const beaconList = beacons.data?.data.beacons ?? [];
  const beaconsActive = beaconList.some((b) => b.status !== 'STOPPED');
  useEffect(() => {
    if (!beaconsActive) return;
    const t = setInterval(() => setBeaconTick((n) => n + 1), 4000);
    return () => clearInterval(t);
  }, [beaconsActive]);

  useEffect(() => {
    db?.outbox.where('state').anyOf(['PENDING', 'SENDING', 'FAILED']).count().then(setPendingOutbox).catch(() => {});
  }, [db, outboxVersion]);
  useEffect(() => {
    document.title = `${animalId ? `${animalId} · ` : ''}Mon élevage aujourd’hui · Sentinelle Vivant (démonstrateur)`;
  }, [animalId]);

  const latest = exchanges.find((e) => e.reply) ?? null;
  const highlight = useMemo(() => new Set(latest ? refsOf(latest.reply) : []), [latest]);
  const sites = situation.data?.data.sites ?? [];
  const sitesRef = useRef(sites);
  sitesRef.current = sites;
  const s = situation.data?.data ?? null;
  const offline = connection === 'offline';
  const assistant = health?.assistant;
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<'loading' | VoiceVia | null>(null);
  const [voiceReplies, setVoiceReplies] = useState(voiceRepliesPref.get);
  useEffect(() => () => stopSpeech(), []);
  const serverVoice = !!assistant?.voice?.speech && !offline;
  const canHear = serverVoice || canSpeak();
  const canDictate = !!assistant?.voice?.available;
  /** Dit un texte à voix haute (voix de synthèse du serveur, sinon de l'appareil). `id` désigne l'échange concerné. */
  const say = useCallback(
    (id: string, said: string) => {
      if (!said) return;
      setSpeakingId(id);
      void playSpeech(said, {
        session,
        server: serverVoice,
        onState: (st) => {
          setVoiceState(st);
          if (st === null) setSpeakingId((cur) => (cur === id ? null : cur));
        },
      });
    },
    [session, serverVoice],
  );
  // Les fonctions asynchrones lisent toujours la préférence et la voix courantes.
  const voice = useRef({ on: voiceReplies, say });
  voice.current = { on: voiceReplies, say };
  /** Vrai tant qu'une conversation en direct est ouverte : la voix de synthèse se tait, l'assistant parle déjà. */
  const liveOn = useRef(false);
  const autoSay = (id: string, said: string) => !liveOn.current && voice.current.on && voice.current.say(id, said);
  // Une balise qui sort de sa zone est aussi annoncée à voix haute, une fois, si les réponses vocales sont activées.
  const alertKey = (beacons.data?.data.alerts ?? []).join(',');
  const lastAlert = useRef('');
  useEffect(() => {
    if (alertKey && alertKey !== lastAlert.current) {
      const out = beaconList.filter((b) => beacons.data!.data.alerts.includes(b.id));
      autoSay('alerte-balise', `Attention. ${out.map((b) => `La balise ${beaconName(b)}${b.animalId ? `, associée à ${b.animalId},` : ''} est hors de sa zone`).join('. ')}.`);
    }
    lastAlert.current = alertKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertKey]);
  /** Bouton « Écouter » d'une réponse : lit, ou arrête si elle est en cours de lecture. */
  const listen = (ex: Exchange) => {
    if (speakingId === ex.id) {
      stopSpeech();
      setVoiceState(null);
      return setSpeakingId(null);
    }
    say(ex.id, spokenText(ex.reply, sites) || ex.error || '');
  };

  const ask = useCallback(
    async (question: string, spoken = false) => {
      const q = question.trim();
      if (!q) return;
      const ex = newExchange(q);
      const all = conversation.get();
      conversation.add(ex);
      setText('');
      // Dernière réponse mise à jour : ses deux états servent à « Pourquoi ta réponse a changé ? ».
      const updated = all.find((e) => e.update && firstResult(e));
      const compare = updated ? { from: updated.update!.previousAsOf, to: firstResult(updated)!.asOf } : undefined;
      const history = all
        .filter((e) => e.reply)
        .slice(0, 5)
        .reverse()
        .flatMap((e) => [
          { role: 'user' as const, text: e.question.slice(0, 600) },
          { role: 'model' as const, text: `${e.reply!.text ?? e.reply!.results.flatMap((r) => r.statements.slice(0, 3).map((st) => st.text)).join(' ')} ${e.reply!.results.map((r) => `(fonction ${r.tool}, état des données asOf=${r.asOf})`).join(' ')}`.slice(0, 1900) },
        ]);
      try {
        const reply = await api<AssistantReply>('/api/assistant/ask', { method: 'POST', session, timeoutMs: 45_000, body: { text: q, contextAnimalId: animalId ?? undefined, contextRef: sourceRef ?? [...highlight][0], compare, history } });
        const first = reply.results[0] ?? null;
        const key = first ? resultKey(first) : null;
        const previous = key ? all.find((e) => e.key === key && firstResult(e)) : undefined;
        const prevResult = previous ? firstResult(previous)! : null;
        const update = first && prevResult && resultDigest(prevResult) !== resultDigest(first) ? { previousAsOf: prevResult.asOf, previousSummary: resultSummary(prevResult), currentSummary: resultSummary(first) } : null;
        const compared = reply.intent === 'why_changed' && compare && updated ? { from: compare.from, to: compare.to, before: updated.update!.previousSummary, after: updated.update!.currentSummary } : null;
        conversation.patch(ex.id, { pending: false, reply, key, update, compared, draft: reply.results.some((r) => r.tool === 'prepare_observation') ? 'open' : null });
        // Réponses à voix haute : chaque réponse est aussi dite (toujours si la question a été dictée), sans rien changer à l'écran.
        if (spoken) voice.current.say(ex.id, spokenText(reply, sitesRef.current));
        else autoSay(ex.id, spokenText(reply, sitesRef.current));
        if (reply.results.some((r) => r.tool === 'beacons')) setBeaconTick((n) => n + 1);
        const shown = reply.results.find((r) => r.tool === 'animal');
        if (shown) go(`elevage/animal/${encodeURIComponent(String(shown.params.animalId))}`);
      } catch (e) {
        const off = e instanceof NetworkError;
        autoSay(ex.id, off ? 'Serveur injoignable. La conversation est indisponible, aucune réponse n’est inventée.' : 'La demande n’a pas pu aboutir.');
        conversation.patch(ex.id, {
          pending: false,
          offline: off,
          error: off ? 'Serveur injoignable : la conversation est indisponible et aucune réponse n’est simulée. Les données affichées sont les dernières lues. Vous pouvez préparer une observation en saisie manuelle : elle sera transmise au retour du réseau.' : e instanceof ApiFailure && e.body.fields ? Object.values(e.body.fields as Record<string, string>).join(' ') : errorMessage(e),
        });
      }
      answerRef.current?.focus({ preventScroll: true });
    },
    [session, animalId, sourceRef, highlight],
  );

  const manualDraft = useCallback(async () => {
    const ex = newExchange(animalId ? `Nouvelle observation sur ${animalId} (saisie manuelle)` : 'Nouvelle observation (saisie manuelle)');
    conversation.add(ex);
    try {
      const r = await api<ToolResult<ObservationDraftData>>('/api/farm/observations/draft', { method: 'POST', session, body: animalId ? { animalId } : {} });
      conversation.patch(ex.id, { pending: false, draft: 'open', reply: { mode: 'direct', provider: null, intent: 'draft', text: null, notice: 'Saisie manuelle, sans IA. Les champs sont vérifiés par le serveur à la confirmation.', results: [r], ungrounded: false, suggestions: [] } });
    } catch {
      conversation.patch(ex.id, { pending: false, draft: 'open', reply: localDraftReply(animalId) });
    }
  }, [session, animalId]);

  const confirmDraft = useCallback(
    async (ex: Exchange, v: DraftValues): Promise<ConfirmOutcome> => {
      if (!db) return 'INVALID';
      conversation.patch(ex.id, { draft: 'saving' });
      setDraftErrors((d) => ({ ...d, [ex.id]: {} }));
      let values = v;
      // Validation des champs par le serveur avant l'écriture (identité de l'animal, lieu, date). Hors connexion : faite à la transmission.
      try {
        const check = await api<ToolResult<ObservationDraftData>>('/api/farm/observations/draft', { method: 'POST', session, body: { animalId: v.animalId, siteId: v.locationId, eventTime: v.eventTime, note: v.note } });
        const d = check.data;
        if (!d.ready || !d.animal.value || !d.site.value || !d.eventTime.value || !d.note.value) {
          setDraftErrors((x) => ({ ...x, [ex.id]: { ...(d.animal.value ? {} : { animal: d.animal.message ?? 'Animal à préciser' }), ...(d.site.value ? {} : { site: d.site.message ?? 'Lieu à préciser' }), ...(d.eventTime.value ? {} : { eventTime: d.eventTime.message ?? 'Date à préciser' }), ...(d.note.value ? {} : { note: d.note.message ?? 'Texte à compléter' }) } }));
          conversation.patch(ex.id, { draft: 'open' });
          return 'INVALID';
        }
        values = { animalId: d.animal.value, locationId: d.site.value, eventTime: d.eventTime.value, note: d.note.value };
      } catch (e) {
        if (!(e instanceof NetworkError)) {
          setDraftErrors((x) => ({ ...x, [ex.id]: { note: errorMessage(e) } }));
          conversation.patch(ex.id, { draft: 'open' });
          return 'INVALID';
        }
      }
      const item = await enqueueObservation(db, values);
      bumpOutbox();
      await syncNow();
      const saved = await db.outbox.get(item.id);
      const ref = `OBS:${item.id}`;
      const label = describeDraft(values, sitesRef.current);
      if (saved?.state === 'RECEIVED') {
        autoSay(ex.id, 'Observation enregistrée. Le serveur a confirmé la réception.');
        conversation.patch(ex.id, { draft: 'confirmed', receipt: { state: 'RECEIVED', ref, receivedAt: saved.receivedAt, duplicate: false, message: label } });
        farmSession.markWritten(ref);
        return 'RECEIVED';
      } else if (saved?.state === 'FAILED' && saved.permanent) {
        autoSay(ex.id, 'Le serveur a refusé l’enregistrement. Rien n’a été écrit.');
        conversation.patch(ex.id, { draft: 'open', receipt: { state: 'FAILED', ref, receivedAt: null, duplicate: false, message: saved.lastError ?? 'Refusée par le serveur' } });
        return 'FAILED';
      } else {
        autoSay(ex.id, 'Observation gardée sur cet appareil. Le serveur n’a pas encore confirmé la réception.');
        conversation.patch(ex.id, { draft: 'confirmed', receipt: { state: 'QUEUED', ref, receivedAt: null, duplicate: false, message: label } });
        return 'QUEUED';
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, session, syncNow, bumpOutbox],
  );

  /**
   * Entrée d'une phrase, dite ou écrite. Si un brouillon complet vient d'être présenté et que la phrase est une confirmation
   * (« je confirme », « oui ») ou un abandon (« non », « annule »), elle s'applique à ce brouillon : c'est la confirmation de
   * l'utilisateur, à la voix. Sinon, c'est une question.
   */
  const submit = useCallback(
    (raw: string, spoken = false) => {
      if (!normalizeSpoken(raw)) return;
      const open = conversation.get().find((e) => e.draft === 'open' && draftOf(e)?.data.ready);
      const d = open ? draftOf(open)!.data : null;
      if (open && d) {
        // « je confirme » vaut pour le brouillon ouvert s'il est récent ; un simple « oui » seulement s'il vient d'être présenté.
        const kind = spokenConfirmation(raw);
        const recent = Date.now() - Date.parse(open.askedAt) <= VOICE_CONFIRM_MAX_MS;
        const justShown = conversation.get()[0]?.id === open.id;
        if (kind && recent && (kind === 'explicit' || justShown) && d.animal.value && d.site.value && d.eventTime.value && d.note.value) {
          setText('');
          void confirmDraft(open, { animalId: d.animal.value, locationId: d.site.value, eventTime: d.eventTime.value, note: d.note.value });
          return;
        }
        if (isSpokenCancellation(raw)) {
          setText('');
          conversation.patch(open.id, { draft: 'discarded' });
          autoSay(open.id, 'Brouillon abandonné. Rien n’a été enregistré.');
          return;
        }
      }
      void ask(raw, spoken);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ask, confirmDraft],
  );

  // ---------- Mode discussion : le micro se rouvre après chaque réponse, dans une session ouverte et bornée par l'utilisateur ----------
  const [discussion, setDiscussion] = useState(false);
  const [micPhase, setMicPhase] = useState<MicPhase>('idle');
  const [startSignal, setStartSignal] = useState(0);
  const [micKey, setMicKey] = useState(0);
  const talk = useRef({ since: 0, turns: 0 });
  const busy = exchanges.some((e) => e.pending || e.draft === 'saving');
  /** Pourquoi la dernière discussion s'est arrêtée : dit à l'écran, pour que la fin de l'écoute ne passe jamais inaperçue. */
  const [talkNote, setTalkNote] = useState<string | null>(null);
  const endDiscussion = useCallback((why: string) => {
    setDiscussion(false);
    setTalkNote(why);
    setMicKey((k) => k + 1); // referme le micro s'il est ouvert
  }, []);
  useEffect(() => {
    if (!discussion || micPhase !== 'idle' || busy || speakingId !== null) return;
    if (Date.now() - talk.current.since > DISCUSSION_MAX_MS || talk.current.turns >= DISCUSSION_MAX_TURNS) return endDiscussion('Discussion terminée : la limite de la session est atteinte. Le micro est fermé.');
    const t = setTimeout(() => {
      talk.current.turns++;
      setStartSignal((n) => n + 1);
    }, 500);
    return () => clearTimeout(t);
  }, [discussion, micPhase, busy, speakingId, endDiscussion]);

  // ---------- Conversation en direct : l'assistant écoute et répond à la voix, sans étape de transcription ----------
  const liveInfo = assistant?.voice?.live;
  const [livePref, setLivePref] = useState(true);
  /** La conversation en direct n'a pas pu s'ouvrir : l'écran repasse à la dictée et le dit. */
  const [liveBroken, setLiveBroken] = useState<string | null>(null);
  const liveMode = !!liveInfo?.available && livePref && !liveBroken && !offline;
  const liveHandle = useRef<LiveHandle>(null);
  const liveTurns = useRef(new Map<number, LiveTurn>());
  const liveModel = useRef<string | null>(null);
  liveModel.current = liveInfo?.model ?? null;
  const confirmRef = useRef(confirmDraft);
  confirmRef.current = confirmDraft;
  const onLiveActive = useCallback((on: boolean) => {
    liveOn.current = on;
    if (on) {
      stopSpeech();
      setSpeakingId(null);
      setVoiceState(null);
      liveTurns.current = new Map();
    } else {
      // Fin de la conversation : plus rien n'est attendu pour les échanges restés ouverts.
      for (const t of liveTurns.current.values()) conversation.patch(t.id, { pending: false });
    }
  }, []);
  const onLive = useCallback((m: LiveServerMessage) => {
    const turns = liveTurns.current;
    const turnOf = (n: number): LiveTurn => {
      let t = turns.get(n);
      if (!t) {
        const ex = newExchange('…');
        conversation.add(ex);
        t = { id: ex.id, heard: '', said: '', results: [], acted: false, draftId: null };
        turns.set(n, t);
      }
      return t;
    };
    const lastTurn = () => turnOf(Math.max(1, ...turns.keys()));
    /** Chaque échange en direct garde ce qui a été entendu, ce qui a été dit, et les lectures de données faites entre les deux. */
    const show = (t: LiveTurn, done = false) => {
      const grounded = t.results.length > 0;
      const has = !!t.said.trim() || grounded || t.acted;
      const reply: AssistantReply | null =
        has || done
          ? {
              mode: 'ai',
              provider: `Gemini (${liveModel.current ?? 'conversation en direct'})`,
              intent: 'ai',
              text: t.said.trim() || null,
              notice: grounded ? LIVE_NOTICE : t.acted ? LIVE_ACTION : has ? LIVE_UNGROUNDED : 'L’assistant n’a rien répondu à cette phrase.',
              results: t.results,
              ungrounded: !grounded && !t.acted,
              suggestions: [],
              live: true,
            }
          : null;
      conversation.patch(t.id, { question: t.heard.trim() || '…', reply, pending: !reply });
    };
    /** Le brouillon visé par une confirmation à la voix : celui que le serveur a désigné, encore ouvert, au contenu inchangé. */
    const draftFor = (draftId: string, fingerprint: string) => {
      const turnOfDraft = [...turns.values()].find((x) => x.draftId === draftId);
      const open = turnOfDraft ? conversation.get().find((e) => e.id === turnOfDraft.id && e.draft === 'open') : undefined;
      const d = open ? draftOf(open)?.data : null;
      return open && d && d.ready && draftFingerprint(d) === fingerprint && d.animal.value && d.site.value && d.eventTime.value && d.note.value ? { open, values: { animalId: d.animal.value, locationId: d.site.value, eventTime: d.eventTime.value, note: d.note.value } } : null;
    };
    switch (m.type) {
      case 'heard': {
        const t = turnOf(m.turn);
        t.heard += m.text;
        return show(t);
      }
      case 'said': {
        const t = turnOf(m.turn);
        t.said += m.text;
        return show(t);
      }
      case 'result': {
        const t = turnOf(m.turn);
        const r = m.result;
        t.results = [...t.results, r];
        if (t.results.length === 1) {
          // Même question qu'avant, contenu différent : la réponse est signalée « mise à jour », comme pour une question écrite.
          const key = resultKey(r);
          const previous = key ? conversation.get().find((e) => e.id !== t.id && e.key === key && firstResult(e)) : undefined;
          const prev = previous ? firstResult(previous)! : null;
          conversation.patch(t.id, { key, update: prev && resultDigest(prev) !== resultDigest(r) ? { previousAsOf: prev.asOf, previousSummary: resultSummary(prev), currentSummary: resultSummary(r) } : null });
        }
        if (r.tool === 'prepare_observation') {
          // Un nouveau brouillon remplace celui qui était encore ouvert : un seul attend une confirmation.
          for (const e of conversation.get()) if (e.id !== t.id && e.draft === 'open') conversation.patch(e.id, { draft: 'discarded' });
          conversation.patch(t.id, { draft: 'open' });
          t.draftId = m.draft?.id ?? null;
        }
        if (r.tool === 'beacons') setBeaconTick((n) => n + 1);
        if (r.tool === 'animal') go(`elevage/animal/${encodeURIComponent(String(r.params.animalId))}`);
        return show(t);
      }
      case 'turn_complete': {
        const t = turns.get(m.turn);
        return t ? show(t, true) : undefined;
      }
      case 'confirm_request': {
        // La personne a dit « je confirme » (règle fixe vérifiée par le serveur) : le brouillon ouvert suit le chemin habituel
        // (vérification des champs, file d'envoi, reçu du serveur), et c'est ce reçu qui est rapporté à l'assistant.
        const target = draftFor(m.draftId, m.fingerprint);
        if (!target) return liveHandle.current?.send({ type: 'confirm_result', id: m.id, state: 'NO_DRAFT' });
        const t = lastTurn();
        t.acted = true;
        show(t);
        void confirmRef.current(target.open, target.values).then((state) => liveHandle.current?.send({ type: 'confirm_result', id: m.id, state, receivedAt: conversation.get().find((e) => e.id === target.open.id)?.receipt?.receivedAt ?? null }));
        return;
      }
      case 'draft_cancel': {
        const open = conversation.get().find((e) => e.draft === 'open');
        if (open) conversation.patch(open.id, { draft: 'discarded' });
        const t = lastTurn();
        t.acted = true;
        return show(t);
      }
      default:
        return;
    }
  }, []);

  const onSource = useCallback((ref: string) => setSourceRef(ref), []);
  const timeline = animalId ? (animal.data?.data.timeline ?? []) : (changes.data?.data.events ?? []);
  const timelineState = animalId ? animal : changes;

  return (
    <div className="v-page">
      <header className="flex flex-wrap items-end justify-between gap-3 pb-5">
        <div>
          <p className="v-kicker">
            {s?.org.name ?? session?.orgName} · {dayFmt.format(new Date())}
          </p>
          <h1 className="v-display mt-1.5 text-[34px] sm:text-[46px]">Mon élevage aujourd’hui</h1>
        </div>
        <button type="button" className="v-chip" aria-pressed={detailed} onClick={() => display.set(!detailed)} title="Affiche d’emblée les natures d’information, les sources, les dates et les limites">
          Affichage détaillé : {detailed ? 'oui' : 'non'}
        </button>
      </header>

      {(offline || situation.local) && situation.data && (
        <p role="status" className="mb-4 border-l-[3px] border-amber-line bg-amber-soft px-4 py-3 text-amber">
          <b>Hors connexion.</b> Données conservées sur cet appareil, lues sur le serveur le <span className="num">{fmtState(situation.data.asOf)}</span>. Elles peuvent être anciennes. La conversation est indisponible ; une observation peut être préparée et sera transmise au retour du réseau.
        </p>
      )}

      <BeaconAlert result={beacons.data} detailed={detailed} onSource={onSource} onAsk={() => ask('Quel animal s’est éloigné ?')} />

      {/* Registre : la situation en une seule ligne réglée */}
      {s ? (
        <div className="v-ledger" data-simple={detailed ? undefined : 'true'} role="group" aria-label="Situation enregistrée">
          <button type="button" className="v-ledger-cell" onClick={() => ask('Quelle est la situation de mon élevage ?')}>
            <span className="v-kicker">{detailed ? 'Enregistré' : s.animals.total > 1 ? 'Animaux' : 'Animal'}</span>
            <span className="v-figure text-[40px]">{s.animals.total}</span>
            {detailed && (
              <span className="v-meta">
                {s.animals.total > 1 ? 'animaux identifiés' : 'animal identifié'} · {s.sites.length} sites · {s.lots.length ? `${s.lots.length} lots` : 'aucun lot'}
              </span>
            )}
          </button>
          <button type="button" className="v-ledger-cell" onClick={() => ask(QUICK[0]!)}>
            <span className="v-kicker">{detailed ? 'Depuis hier' : 'Nouveautés depuis hier'}</span>
            <span className="v-figure text-[40px]">{s.recent.counts.total}</span>
            {detailed && (
              <span className="v-meta">
                {s.recent.counts.total > 1 ? 'enregistrements reçus' : 'enregistrement reçu'} : {s.recent.counts.added} ajout{s.recent.counts.added > 1 ? 's' : ''}, {s.recent.counts.corrected} correction{s.recent.counts.corrected > 1 ? 's' : ''}
              </span>
            )}
          </button>
          <button type="button" className="v-ledger-cell" onClick={() => ask(QUICK[1]!)}>
            <span className="v-kicker">À compléter</span>
            <span className="v-figure text-[40px]">{s.toComplete.total}</span>
            {detailed && (
              <span className="v-meta">
                {s.toComplete.total > 1 ? 'informations à compléter ou à vérifier' : 'information à compléter ou à vérifier'}
                {s.toComplete.openTasks ? ` · ${s.toComplete.openTasks} tâche${s.toComplete.openTasks > 1 ? 's' : ''}` : ''}
              </span>
            )}
          </button>
          {(detailed || pendingOutbox > 0) && (
            <button type="button" className="v-ledger-cell" onClick={() => (pendingOutbox ? go('envois') : setReloads((n) => n + 1))} title={pendingOutbox ? 'Ouvrir les déclarations à transmettre' : 'Relire les données sur le serveur'}>
              <span className="v-kicker">{detailed ? 'Synchronisation' : 'À transmettre'}</span>
              <span className="v-figure pt-2 text-[26px]">{detailed ? (s.sync.lastServerReceipt ? fmtInstant(s.sync.lastServerReceipt).replace(/\/\d{4}/, '') : 'aucune') : pendingOutbox}</span>
              {detailed && (
                <span className="v-meta">
                  dernière réception par le serveur · données lues à <span className="num">{fmtState(situation.data!.asOf).slice(11)}</span>
                  {pendingOutbox ? ` · ${pendingOutbox} à transmettre depuis cet appareil` : ''}
                </span>
              )}
            </button>
          )}
        </div>
      ) : situation.error ? (
        <div role="alert" className="border-l-[3px] border-danger bg-danger-soft px-4 py-3">
          <p className="font-semibold text-danger">La situation de l’exploitation n’a pas pu être lue.</p>
          <p>{situation.error instanceof NetworkError ? 'Serveur injoignable, et aucune lecture précédente n’est conservée sur cet appareil.' : errorMessage(situation.error)}</p>
          <button type="button" className="btn btn-sm mt-2" onClick={() => setReloads((n) => n + 1)}>
            Réessayer
          </button>
        </div>
      ) : (
        <div className="v-ledger" role="status" aria-label="Lecture de la situation">
          {[0, 1, 2].map((i) => (
            <div key={i} className="v-ledger-cell">
              <span className="v-skeleton h-3 w-24" />
              <span className="v-skeleton h-10 w-16" />
            </div>
          ))}
        </div>
      )}

      <div className="mt-7 flex flex-col-reverse gap-8 lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start lg:gap-10">
        {/* Représentation de l'exploitation */}
        <div className="min-w-0 space-y-7">
          <Zone beacons={beaconList} simulated={!!beacons.data?.data.simulated} onSource={onSource} />

          {s && <Constellation sites={s.sites} moves={s.moves} recent={changes.data?.data.events ?? s.recent.events} animal={animalId ? (animal.data?.data ?? null) : null} highlight={highlight} fresh={fresh} onSource={onSource} />}

          <BeaconsPanel session={session} result={beacons.data} error={beacons.error} defaultAnimal={animalId} detailed={detailed} onChanged={() => setBeaconTick((n) => n + 1)} onSource={onSource} />

          <section aria-labelledby="chrono-h">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b-2 border-encre pb-2">
              <div>
                {detailed && <p className="v-kicker">Chronologie</p>}
                <h2 id="chrono-h" className="v-display mt-0.5 text-[26px]">
                  {animalId ? `${animalId}, tout ce qui est enregistré` : 'Reçu depuis hier'}
                </h2>
              </div>
              {animalId && (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn btn-sm" onClick={manualDraft}>
                    Nouvelle observation
                  </button>
                  {detailed && (
                    <a className="btn btn-sm" href={`#/animal/${encodeURIComponent(animalId)}`}>
                      Fiche et QR code
                    </a>
                  )}
                  <button type="button" className="btn btn-sm" onClick={() => go('elevage')}>
                    Revenir à l’exploitation
                  </button>
                </div>
              )}
            </div>
            {animalId && animal.data && (
              <p className="border-b border-filet py-3 text-[16px]">
                {detailed ? animal.data.statements[0]?.text : plainSentence(animal.data.statements[0]?.text ?? '')}{' '}
                {detailed && (
                  <span className="v-meta">
                    Données lues à <span className="num">{fmtState(animal.data.asOf).slice(11)}</span>.
                  </span>
                )}
              </p>
            )}
            {timelineState.error !== null && !timelineState.data ? (
              <p role="alert" className="mt-3 border-l-[3px] border-danger pl-3">
                {timelineState.error instanceof ApiFailure && timelineState.error.status === 404 ? `Aucun animal « ${animalId} » n’est enregistré dans votre périmètre.` : `La chronologie n’a pas pu être lue. ${errorMessage(timelineState.error)}`}{' '}
                <button type="button" className="underline" onClick={() => (timelineState.error instanceof ApiFailure ? go('elevage') : setReloads((n) => n + 1))}>
                  {timelineState.error instanceof ApiFailure ? 'Revenir à l’exploitation' : 'Réessayer'}
                </button>
              </p>
            ) : !timelineState.data ? (
              <div className="space-y-3 py-4" role="status" aria-label="Lecture de la chronologie">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="v-skeleton h-16" />
                ))}
              </div>
            ) : (
              <>
                {timelineState.error !== null && (
                  <p role="alert" className="mt-3 border-l-[3px] border-amber-line pl-3 text-amber">
                    Actualisation impossible : la chronologie affichée date du <span className="num">{fmtState(timelineState.data.asOf)}</span>.
                  </p>
                )}
                <Timeline events={timeline} highlight={highlight} fresh={fresh} onSource={onSource} simple={!detailed} empty={animalId ? 'Aucun enregistrement pour cet animal.' : 'Aucun enregistrement reçu depuis hier.'} />
                {detailed && !animalId && changes.data && (
                  <p className="v-meta mt-3">
                    Période : réception par le serveur depuis le <span className="num">{fmtInstant(changes.data.period!.from)}</span>. Un événement plus ancien saisi récemment y figure, avec sa propre date d’événement.
                  </p>
                )}
              </>
            )}
          </section>
        </div>

        {/* Conversation */}
        <aside className="min-w-0 lg:sticky lg:top-4" aria-labelledby="talk-h">
          <h2 id="talk-h" className="v-display text-[26px]">
            Parler à mon élevage
          </h2>
          {detailed ? (
            <p className="v-meta mt-1">
              {assistant?.configured ? (
                <>
                  Assistant IA connecté : {assistant.provider} ({assistant.model}). Il lit vos données par des fonctions contrôlées et n’enregistre rien sans votre confirmation.
                </>
              ) : (
                <>
                  <b className="text-encre">Assistant IA non configuré.</b> Les questions ci-dessous sont reconnues par des règles fixes et lisent directement vos données, sans IA. La saisie manuelle reste complète.
                </>
              )}
            </p>
          ) : (
            !assistant?.configured && <p className="v-meta mt-1">Sans assistant vocal sur ce serveur : écrivez votre question, ou touchez une proposition.</p>
          )}

          {/* Parler en direct : l'assistant répond à la voix dès que la personne a fini. Sinon, dictée d'une phrase à la fois. */}
          {liveMode && (
            <div className="mt-4">
              <LiveTalk session={session} animalId={animalId} offline={offline} maxSeconds={liveInfo!.maxSeconds} quiet={!detailed} handle={liveHandle} onMessage={onLive} onActive={onLiveActive} onFailedToOpen={setLiveBroken} />
              {detailed && (
                <p className="mt-2 flex flex-wrap items-center gap-2">
                  <button type="button" className="v-chip" aria-pressed={true} onClick={() => setLivePref(false)}>
                    Conversation en direct : oui
                  </button>
                  <span className="v-meta">
                    Modèle {liveInfo!.model}. La voix répond sans attendre : ses phrases ne peuvent pas être contrôlées avant d’être dites. Les lectures de données faites pendant l’échange s’affichent avec la réponse.
                  </span>
                </p>
              )}
            </div>
          )}
          {!liveMode && liveInfo?.available && !offline && (
            <p className="mt-4 flex flex-wrap items-center gap-2" role="status">
              <button
                type="button"
                className="v-chip"
                aria-pressed={false}
                onClick={() => {
                  setLiveBroken(null);
                  setLivePref(true);
                }}
              >
                Conversation en direct : non
              </button>
              {liveBroken && <span className="text-[14px] text-danger">{liveBroken} Le bouton ci-dessous dicte une phrase à la fois.</span>}
            </p>
          )}
          {!liveMode && (canDictate || detailed) && (
            <div className="mt-4">
              <Dictation
                key={micKey}
                session={session}
                available={canDictate}
                maxSeconds={assistant?.voice?.maxSeconds ?? 30}
                offline={offline}
                unavailableReason="Dictée indisponible : la transcription passe par l’assistant IA, qui n’est pas configuré sur ce serveur. Le texte permet tout le parcours."
                onText={(t) => submit(t, true)}
                big
                quiet={!detailed}
                startSignal={startSignal}
                onPhase={setMicPhase}
                onEnd={(why) => discussion && endDiscussion(why === 'silence' ? 'Discussion terminée : je n’ai plus rien entendu. Le micro est fermé.' : why === 'cancel' ? 'Discussion arrêtée. Le micro est fermé.' : 'Discussion interrompue. Le micro est fermé.')}
              />
              {canDictate && (
                <p className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="v-chip"
                    aria-pressed={discussion}
                    onClick={() => {
                      if (discussion) return endDiscussion('Discussion arrêtée. Le micro est fermé.');
                      talk.current = { since: Date.now(), turns: 0 };
                      setTalkNote(null);
                      setDiscussion(true);
                    }}
                  >
                    Discussion : {discussion ? 'oui' : 'non'}
                  </button>
                  {discussion ? (
                    <span className="text-[14px] font-semibold text-laterite" role="status">
                      Discussion en cours : le micro se rouvre après chaque réponse. Taisez-vous ou touchez le bouton pour arrêter.
                    </span>
                  ) : talkNote ? (
                    <span className="text-[14px] text-encre-2" role="status">
                      {talkNote}
                    </span>
                  ) : (
                    detailed && <span className="v-meta">En discussion, le micro se rouvre après chaque réponse, 3 minutes au plus.</span>
                  )}
                </p>
              )}
            </div>
          )}

          <form
            className="v-ask mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit(text);
            }}
          >
            <label htmlFor="ask" className="sr-only">
              Votre question ou votre observation
            </label>
            <textarea
              id="ask"
              ref={inputRef}
              rows={detailed ? 2 : 1}
              value={text}
              maxLength={600}
              placeholder={detailed ? 'Qu’est-ce qui a changé depuis hier ?' : 'Ou écrivez ici'}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit(text);
                }
              }}
            />
            <button className="v-btn-go" disabled={!text.trim() || exchanges.some((e) => e.pending)}>
              Demander
            </button>
          </form>
          {canHear && (
            <p className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="v-chip"
                aria-pressed={voiceReplies}
                onClick={() => {
                  const on = !voiceReplies;
                  setVoiceReplies(on);
                  voiceRepliesPref.set(on);
                  if (!on) {
                    stopSpeech();
                    setSpeakingId(null);
                    setVoiceState(null);
                  }
                }}
              >
                {voiceReplies ? 'Réponses à voix haute : oui' : 'Réponses à voix haute : non'}
              </button>
              {detailed && <span className="v-meta">{voiceReplies ? (serverVoice ? 'Chaque réponse est aussi dite par une voix de synthèse (Gemini).' : 'Chaque réponse est aussi dite par la voix de synthèse de cet appareil.') : 'Les réponses restent écoutables une à une avec « Écouter la réponse ».'}</span>}
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap gap-2">
            {QUICK.map((q) => (
              <button key={q} type="button" className="v-chip" onClick={() => ask(q)}>
                {q}
              </button>
            ))}
            <button type="button" className="v-chip" onClick={manualDraft}>
              Ajouter une observation
            </button>
            {exchanges.some((e) => e.update) && (
              <button type="button" className="v-chip" onClick={() => ask('Pourquoi ta réponse a changé ?')}>
                Pourquoi ta réponse a changé ?
              </button>
            )}
          </div>

          <div ref={answerRef} tabIndex={-1} aria-live="polite" className="mt-5 outline-none">
            {exchanges.length === 0 && detailed && (
              <div className="border-t border-filet pt-5">
                <p className="max-w-[46ch] text-[15.5px] text-encre-2">Chaque réponse cite ses sources : un clic ouvre l’enregistrement exact. Une observation ajoutée ici passe par un brouillon, puis par votre confirmation.</p>
              </div>
            )}
            {exchanges.map((ex) => (
              <ExchangeView
                key={ex.id}
                ex={ex}
                detailed={detailed}
                sites={sites}
                canHear={canHear}
                speaking={speakingId === ex.id}
                voiceState={voiceState}
                draftErrors={draftErrors[ex.id] ?? {}}
                onListen={() => listen(ex)}
                onAsk={(q) => ask(q)}
                onSource={onSource}
                onManual={manualDraft}
                onConfirm={(v) => void confirmDraft(ex, v).then((state) => liveOn.current && state !== 'INVALID' && liveHandle.current?.send({ type: 'screen', event: state }))}
                onDiscard={() => {
                  conversation.patch(ex.id, { draft: 'discarded' });
                  if (liveOn.current) liveHandle.current?.send({ type: 'screen', event: 'DISCARDED' });
                }}
              />
            ))}
          </div>
        </aside>
      </div>

      <EvidenceDialog sourceRef={sourceRef} onClose={() => setSourceRef(null)} />
    </div>
  );
}
