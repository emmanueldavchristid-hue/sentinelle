import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnimalData, AssistantReply, ChangesData, ObservationDraftData, SituationData, ToolResult } from '@sentinelle/contracts';
import { api, ApiFailure, errorMessage, NetworkError } from '../api';
import { enqueueObservation } from '../local';
import { go, useApp } from '../state';
import { Constellation } from '../farm/Constellation';
import { canSpeak, Dictation, speak, stopSpeaking } from '../farm/Voice';
import { DraftCard, describeDraft, EvidenceDialog, fmtInstant, fmtState, ResultView, SourceChip, Timeline, type DraftValues } from '../farm/parts';
import { conversation, draftOf, firstResult, refsOf, resultDigest, resultKey, resultSummary, session as farmSession, useExchanges, useFresh, useWrites, type Exchange } from '../farm/store';

/**
 * « Mon élevage aujourd'hui » : écran d'ouverture de SENTINELLE VIVANT.
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

const newExchange = (question: string): Exchange => ({ id: crypto.randomUUID(), question, askedAt: new Date().toISOString(), pending: true, error: null, offline: false, reply: null, key: null, update: null, compared: null, draft: null, receipt: null });

export function FarmHome({ animalId }: { animalId: string | null }) {
  const { session, db, connection, health, syncNow, bumpOutbox, outboxVersion } = useApp();
  const exchanges = useExchanges();
  const fresh = useFresh();
  const writes = useWrites();
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

  useEffect(() => {
    db?.outbox.where('state').anyOf(['PENDING', 'SENDING', 'FAILED']).count().then(setPendingOutbox).catch(() => {});
  }, [db, outboxVersion]);
  useEffect(() => {
    document.title = `${animalId ? `${animalId} · ` : ''}Mon élevage aujourd’hui · Sentinelle Vivant (démonstrateur)`;
  }, [animalId]);

  const latest = exchanges.find((e) => e.reply) ?? null;
  const highlight = useMemo(() => new Set(latest ? refsOf(latest.reply) : []), [latest]);
  const sites = situation.data?.data.sites ?? [];
  const s = situation.data?.data ?? null;
  const offline = connection === 'offline';
  const assistant = health?.assistant;
  const [dictated, setDictated] = useState<string | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  useEffect(() => () => void stopSpeaking(), []);
  const onDictated = useCallback((t: string) => {
    setText(t);
    setDictated(t);
    inputRef.current?.focus();
  }, []);
  /** Lecture à voix haute d'une réponse par la voix de synthèse de l'appareil (aucun service externe). */
  const listen = (ex: Exchange) => {
    if (speakingId === ex.id) {
      stopSpeaking();
      return setSpeakingId(null);
    }
    const said = (ex.reply?.text ?? ex.reply?.results[0]?.statements.slice(0, 5).map((st) => st.text).join(' ') ?? '').replace(/\[(?:OBS|REC|TASK|ANIMAL|SITE):[^\]]+\]/g, '').replace(/\s+/g, ' ');
    if (!said.trim()) return;
    setSpeakingId(ex.id);
    speak(said, () => setSpeakingId((id) => (id === ex.id ? null : id)));
  };

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q) return;
      const ex = newExchange(q);
      const all = conversation.get();
      conversation.add(ex);
      setText('');
      setDictated(null);
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
        const shown = reply.results.find((r) => r.tool === 'animal');
        if (shown) go(`elevage/animal/${encodeURIComponent(String(shown.params.animalId))}`);
      } catch (e) {
        const off = e instanceof NetworkError;
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
      const label = describeDraft(values, sites);
      if (saved?.state === 'RECEIVED') {
        conversation.patch(ex.id, { draft: 'confirmed', receipt: { state: 'RECEIVED', ref, receivedAt: saved.receivedAt, duplicate: false, message: label } });
        farmSession.markWritten(ref);
      } else if (saved?.state === 'FAILED' && saved.permanent) {
        conversation.patch(ex.id, { draft: 'open', receipt: { state: 'FAILED', ref, receivedAt: null, duplicate: false, message: saved.lastError ?? 'Refusée par le serveur' } });
      } else {
        conversation.patch(ex.id, { draft: 'confirmed', receipt: { state: 'QUEUED', ref, receivedAt: null, duplicate: false, message: label } });
      }
    },
    [db, session, syncNow, bumpOutbox, sites],
  );

  const onSource = useCallback((ref: string) => setSourceRef(ref), []);
  const timeline = animalId ? (animal.data?.data.timeline ?? []) : (changes.data?.data.events ?? []);
  const timelineState = animalId ? animal : changes;

  return (
    <div className="v-page">
      <header className="pb-5">
        <p className="v-kicker">
          {s?.org.name ?? session?.orgName} · {dayFmt.format(new Date())}
        </p>
        <h1 className="v-display mt-1.5 text-[34px] sm:text-[46px]">Mon élevage aujourd’hui</h1>
      </header>

      {(offline || situation.local) && situation.data && (
        <p role="status" className="mb-4 border-l-[3px] border-amber-line bg-amber-soft px-4 py-3 text-amber">
          <b>Hors connexion.</b> Données conservées sur cet appareil, lues sur le serveur le <span className="num">{fmtState(situation.data.asOf)}</span>. Elles peuvent être anciennes. La conversation est indisponible ; une observation peut être préparée et sera transmise au retour du réseau.
        </p>
      )}

      {/* Registre : les quatre questions de l'ouverture, en une seule ligne réglée */}
      {s ? (
        <div className="v-ledger" role="group" aria-label="Situation enregistrée">
          <button type="button" className="v-ledger-cell" onClick={() => ask('Quelle est la situation de mon élevage ?')}>
            <span className="v-kicker">Enregistré</span>
            <span className="v-figure text-[40px]">{s.animals.total}</span>
            <span className="v-meta">
              {s.animals.total > 1 ? 'animaux identifiés' : 'animal identifié'} · {s.sites.length} sites · {s.lots.length ? `${s.lots.length} lots` : 'aucun lot'}
            </span>
          </button>
          <button type="button" className="v-ledger-cell" onClick={() => ask(QUICK[0]!)}>
            <span className="v-kicker">Depuis hier</span>
            <span className="v-figure text-[40px]">{s.recent.counts.total}</span>
            <span className="v-meta">
              {s.recent.counts.total > 1 ? 'enregistrements reçus' : 'enregistrement reçu'} : {s.recent.counts.added} ajout{s.recent.counts.added > 1 ? 's' : ''}, {s.recent.counts.corrected} correction{s.recent.counts.corrected > 1 ? 's' : ''}
            </span>
          </button>
          <button type="button" className="v-ledger-cell" onClick={() => ask(QUICK[1]!)}>
            <span className="v-kicker">À compléter</span>
            <span className="v-figure text-[40px]">{s.toComplete.total}</span>
            <span className="v-meta">
              {s.toComplete.total > 1 ? 'informations à compléter ou à vérifier' : 'information à compléter ou à vérifier'}
              {s.toComplete.openTasks ? ` · ${s.toComplete.openTasks} tâche${s.toComplete.openTasks > 1 ? 's' : ''}` : ''}
            </span>
          </button>
          <button type="button" className="v-ledger-cell" onClick={() => (pendingOutbox ? go('envois') : setReloads((n) => n + 1))} title={pendingOutbox ? 'Ouvrir les déclarations à transmettre' : 'Relire les données sur le serveur'}>
            <span className="v-kicker">Synchronisation</span>
            <span className="v-figure pt-2 text-[26px]">{s.sync.lastServerReceipt ? fmtInstant(s.sync.lastServerReceipt).replace(/\/\d{4}/, '') : 'aucune'}</span>
            <span className="v-meta">
              dernière réception par le serveur · données lues à <span className="num">{fmtState(situation.data!.asOf).slice(11)}</span>
              {pendingOutbox ? ` · ${pendingOutbox} à transmettre depuis cet appareil` : ''}
            </span>
          </button>
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
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="v-ledger-cell">
              <span className="v-skeleton h-3 w-24" />
              <span className="v-skeleton h-10 w-16" />
              <span className="v-skeleton h-3 w-40" />
            </div>
          ))}
        </div>
      )}

      <div className="mt-7 flex flex-col-reverse gap-8 lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start lg:gap-10">
        {/* Représentation de l'exploitation */}
        <div className="min-w-0 space-y-7">
          {s && <Constellation sites={s.sites} moves={s.moves} recent={changes.data?.data.events ?? s.recent.events} animal={animalId ? (animal.data?.data ?? null) : null} highlight={highlight} fresh={fresh} onSource={onSource} />}

          <section aria-labelledby="chrono-h">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b-2 border-encre pb-2">
              <div>
                <p className="v-kicker">Chronologie</p>
                <h2 id="chrono-h" className="v-display mt-0.5 text-[26px]">
                  {animalId ? `${animalId}, tout ce qui est enregistré` : 'Reçu depuis hier'}
                </h2>
              </div>
              {animalId && (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn btn-sm" onClick={manualDraft}>
                    Nouvelle observation
                  </button>
                  <a className="btn btn-sm" href={`#/animal/${encodeURIComponent(animalId)}`}>
                    Fiche et QR code
                  </a>
                  <button type="button" className="btn btn-sm" onClick={() => go('elevage')}>
                    Revenir à l’exploitation
                  </button>
                </div>
              )}
            </div>
            {animalId && animal.data && (
              <p className="border-b border-filet py-3 text-[16px]">
                {animal.data.statements[0]?.text} <span className="v-meta">Données lues à <span className="num">{fmtState(animal.data.asOf).slice(11)}</span>.</span>
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
                <Timeline events={timeline} highlight={highlight} fresh={fresh} onSource={onSource} empty={animalId ? 'Aucun enregistrement pour cet animal.' : 'Aucun enregistrement reçu depuis hier.'} />
                {!animalId && changes.data && (
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
          <form
            className="v-ask mt-3"
            onSubmit={(e) => {
              e.preventDefault();
              ask(text);
            }}
          >
            <label htmlFor="ask" className="sr-only">
              Votre question ou votre observation
            </label>
            <textarea
              id="ask"
              ref={inputRef}
              rows={2}
              value={text}
              maxLength={600}
              placeholder="Qu’est-ce qui a changé depuis hier ?"
              onChange={(e) => {
                setText(e.target.value);
                if (!e.target.value) setDictated(null);
              }}
              aria-describedby={dictated ? 'dictated-hint' : undefined}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  ask(text);
                }
              }}
            />
            <button className="v-btn-go" disabled={!text.trim() || exchanges.some((e) => e.pending)}>
              Demander
            </button>
          </form>
          {dictated && text && (
            <p id="dictated-hint" className="mt-1.5 text-[14px] text-laterite">
              <b>Texte dicté, transcrit automatiquement.</b> Relisez-le, corrigez-le si besoin, puis « Demander ».
            </p>
          )}
          <div className="mt-2.5">
            <Dictation
              session={session}
              available={!!assistant?.voice?.available}
              maxSeconds={assistant?.voice?.maxSeconds ?? 30}
              offline={offline}
              unavailableReason="Dictée indisponible : la transcription passe par l’assistant IA, qui n’est pas configuré sur ce serveur. Le texte permet tout le parcours."
              onText={onDictated}
            />
          </div>
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
            {exchanges.length === 0 && (
              <div className="border-t border-filet pt-5">
                <p className="max-w-[46ch] text-[15.5px] text-encre-2">Chaque réponse cite ses sources : un clic ouvre l’enregistrement exact. Une observation ajoutée ici passe par un brouillon, puis par votre confirmation.</p>
              </div>
            )}
            {exchanges.map((ex) => {
              const draft = draftOf(ex);
              const r0 = firstResult(ex);
              return (
                <article key={ex.id} className="v-exchange v-appear" aria-label={`Question : ${ex.question}`}>
                  <p className="v-question">{ex.question}</p>
                  <p className="v-meta num mt-0.5">{fmtState(ex.askedAt).slice(11)}</p>
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
                        <button type="button" className="btn btn-sm mt-2" onClick={manualDraft}>
                          Préparer une observation (saisie manuelle)
                        </button>
                      )}
                    </div>
                  )}
                  {ex.reply && (
                    <div className="mt-3 space-y-3">
                      <p className="v-notice">{ex.reply.notice}</p>
                      {canSpeak() && (ex.reply.text || ex.reply.results.length > 0) && (
                        <button type="button" className="v-chip" aria-pressed={speakingId === ex.id} onClick={() => listen(ex)} title="Voix de synthèse de cet appareil, sans service externe">
                          {speakingId === ex.id ? '■ Arrêter la lecture' : '▶ Écouter la réponse'}
                        </button>
                      )}
                      {ex.update && (
                        <div className="v-update">
                          <p className="v-field-flag text-laterite">Réponse mise à jour</p>
                          <p className="mt-1">
                            À <span className="num">{fmtState(ex.update.previousAsOf).slice(11)}</span> : {ex.update.previousSummary}.
                            <br />
                            Maintenant : <b>{ex.update.currentSummary}</b>.
                          </p>
                          <button type="button" className="btn btn-sm mt-2" onClick={() => ask('Pourquoi ta réponse a changé ?')}>
                            Pourquoi ta réponse a changé ?
                          </button>
                        </div>
                      )}
                      {ex.compared && (
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
                      )}
                      {ex.reply.text && (
                        <div className="v-statement" data-nature={ex.reply.ungrounded ? 'SUGGESTION' : 'FACT'}>
                          <span className="v-nature text-encre-2">
                            <span className="v-nature-glyph" aria-hidden="true">
                              ✎
                            </span>
                            {ex.reply.ungrounded ? 'Suggestion formulée par l’IA' : `Formulé par l’IA · ${ex.reply.provider}`}
                          </span>
                          <p className="max-w-[64ch] text-[16px] leading-[1.5] whitespace-pre-line">
                            {/* Les identifiants cités par le modèle deviennent des sources cliquables (ils ont été contrôlés par le serveur). */}
                            {ex.reply.text.split(/\[((?:OBS|REC|TASK|ANIMAL|SITE):[A-Za-z0-9@-]+)\]/g).map((part, i) => (i % 2 ? <SourceChip key={i} sourceRef={part} onSource={onSource} /> : part))}
                          </p>
                        </div>
                      )}
                      {ex.reply.results
                        .filter((r) => r.tool !== 'prepare_observation')
                        .map((r, i) => (
                          <ResultView key={i} result={r} onSource={onSource} />
                        ))}
                      {draft && (ex.draft === 'open' || ex.draft === 'saving') && (
                        <>
                          <ResultView result={draft} onSource={onSource} />
                          <DraftCard id={`d-${ex.id}`} draft={draft.data} sites={sites} busy={ex.draft === 'saving'} serverErrors={draftErrors[ex.id] ?? {}} onConfirm={(v) => confirmDraft(ex, v)} onDiscard={() => conversation.patch(ex.id, { draft: 'discarded' })} onSource={onSource} />
                        </>
                      )}
                      {ex.draft === 'discarded' && <p className="v-notice">Brouillon abandonné. Rien n’a été enregistré.</p>}
                      {ex.receipt?.state === 'RECEIVED' && (
                        <div className="v-receipt" role="status">
                          <p className="v-field-flag text-paturage">✓ Reçu par le serveur</p>
                          <p className="mt-1">
                            Observation enregistrée, reçue le <span className="num">{ex.receipt.receivedAt ? fmtState(ex.receipt.receivedAt) : ''}</span>.
                          </p>
                          <p className="v-meta mt-0.5">{ex.receipt.message}</p>
                          <p className="mt-2">
                            <SourceChip sourceRef={ex.receipt.ref} onSource={onSource} />
                            <button type="button" className="v-chip" onClick={() => ask(QUICK[0]!)}>
                              Reposer : qu’est-ce qui a changé depuis hier ?
                            </button>
                          </p>
                        </div>
                      )}
                      {ex.receipt?.state === 'QUEUED' && (
                        <div className="v-update" role="status">
                          <p className="v-field-flag text-laterite">↑ Sur cet appareil seulement</p>
                          <p className="mt-1">Le serveur n’a pas confirmé la réception. L’observation est conservée sur cet appareil et sera transmise depuis « Déclarations » au retour du réseau. Elle n’apparaît pas encore dans la chronologie.</p>
                          <p className="v-meta mt-0.5">{ex.receipt.message}</p>
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
                      {ex.reply.intent === 'unknown' && (
                        <div className="flex flex-wrap gap-2">
                          {ex.reply.suggestions.slice(0, 3).map((q) => (
                            <button key={q} type="button" className="v-chip" onClick={() => ask(q)}>
                              {q}
                            </button>
                          ))}
                          <button type="button" className="v-chip" onClick={manualDraft}>
                            Ajouter une observation
                          </button>
                        </div>
                      )}
                      {r0 && ex.reply.results.length > 0 && !draft && (
                        <p className="v-meta">
                          {refsOf(ex.reply).length ? `${refsOf(ex.reply).length} source${refsOf(ex.reply).length > 1 ? 's' : ''} mise${refsOf(ex.reply).length > 1 ? 's' : ''} en évidence dans la constellation et la chronologie.` : 'Aucune source à mettre en évidence.'}
                        </p>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </aside>
      </div>

      <EvidenceDialog sourceRef={sourceRef} onClose={() => setSourceRef(null)} />
    </div>
  );
}
