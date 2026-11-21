import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { beaconName, type AnimalData, type AssistantReply, type BeaconsData, type ChangesData, type ObservationDraftData, type SiteSummary, type SituationData, type ToolResult } from '@sentinelle/contracts';
import { api, ApiFailure, errorMessage, NetworkError } from '../api';
import { enqueueObservation } from '../local';
import { formatTemporal, type TemporalValue } from '@sentinelle/domain';
import { go, useApp } from '../state';
import { BeaconAlert, BeaconsPanel } from '../farm/Beacons';
import { Constellation } from '../farm/Constellation';
import { Zone } from '../farm/Zone';
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

/** Mots qui valent confirmation ou abandon d'un brouillon déjà lu à l'utilisateur, dits ou écrits (phrase courte uniquement). */
const normalize = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, ' ')
    .replace(/[.!?,;:«»"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const CONFIRM_WORDS = /^(oui|ouais|je confirme|confirme|confirmer|c est bon|c est exact|c est ca|exact|d accord|ok|okay|valide|je valide|enregistre)( |$)/;
const CANCEL_WORDS = /^(non|annule|annuler|j annule|abandonne|laisse tomber)( |$)/;
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
        {reply.ungrounded ? 'Suggestion formulée par l’IA' : `Formulé par l’IA · ${reply.provider}`}
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
  const autoSay = (id: string, said: string) => voice.current.on && voice.current.say(id, said);
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
    async (ex: Exchange, v: DraftValues) => {
      if (!db) return;
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
          return;
        }
        values = { animalId: d.animal.value, locationId: d.site.value, eventTime: d.eventTime.value, note: d.note.value };
      } catch (e) {
        if (!(e instanceof NetworkError)) {
          setDraftErrors((x) => ({ ...x, [ex.id]: { note: errorMessage(e) } }));
          conversation.patch(ex.id, { draft: 'open' });
          return;
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
      } else if (saved?.state === 'FAILED' && saved.permanent) {
        autoSay(ex.id, 'Le serveur a refusé l’enregistrement. Rien n’a été écrit.');
        conversation.patch(ex.id, { draft: 'open', receipt: { state: 'FAILED', ref, receivedAt: null, duplicate: false, message: saved.lastError ?? 'Refusée par le serveur' } });
      } else {
        autoSay(ex.id, 'Observation gardée sur cet appareil. Le serveur n’a pas encore confirmé la réception.');
        conversation.patch(ex.id, { draft: 'confirmed', receipt: { state: 'QUEUED', ref, receivedAt: null, duplicate: false, message: label } });
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
      const n = normalize(raw);
      if (!n) return;
      const open = conversation.get().find((e) => e.draft === 'open' && draftOf(e)?.data.ready);
      const d = open ? draftOf(open)!.data : null;
      if (open && d && n.length <= 40) {
        if (CONFIRM_WORDS.test(n) && d.animal.value && d.site.value && d.eventTime.value && d.note.value) {
          setText('');
          void confirmDraft(open, { animalId: d.animal.value, locationId: d.site.value, eventTime: d.eventTime.value, note: d.note.value });
          return;
        }
        if (CANCEL_WORDS.test(n)) {
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

          {/* Parler : un gros bouton, qui s'arrête de lui-même quand on se tait. Indisponible sans assistant : le texte reste complet. */}
          {(canDictate || detailed) && (
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
                onConfirm={(v) => confirmDraft(ex, v)}
                onDiscard={() => conversation.patch(ex.id, { draft: 'discarded' })}
              />
            ))}
          </div>
        </aside>
      </div>

      <EvidenceDialog sourceRef={sourceRef} onClose={() => setSourceRef(null)} />
    </div>
  );
}
