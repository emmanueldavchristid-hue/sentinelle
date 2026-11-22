import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatInstant, formatTemporal, precisionLabel, type Movement, type Presence } from '@sentinelle/domain';
import type { DraftField, ObservationAssistReply, ObservationDraftData, TemporalValueDto } from '@sentinelle/contracts';
import { api, ApiFailure, errorMessage, NetworkError } from '../api';
import { enqueueObservation, OUTBOX_LABELS, type ObservationDraft, type OutboxItem } from '../local';
import { go, useApp } from '../state';
import { Banner, Empty, ErrorView, Loading, TemporalFields, toTemporal, type TemporalDraft } from '../components/ui';
import { FicheQr } from './qr';
import { canSpeak, Dictation, playSpeech, stopSpeech } from '../farm/Voice';

export interface LocationDto {
  id: string;
  code: string;
  name: string;
  kind: string;
  x: number | null;
  y: number | null;
}
interface CardDto {
  animal: { id: string; tag: string; species: string };
  currentLocationId: string | null;
  presences: Presence[];
  movements: Movement[];
  observations: { id: string; eventTime: TemporalValueDto; note: string; status: string; receivedAt: string }[];
}
interface Preload {
  generatedAt: string;
  locations: LocationDto[];
  cards: CardDto[];
}

/** Données préchargées pour la consultation hors connexion (limitées aux fiches autorisées). */
function usePreload() {
  const { db, session, connection } = useApp();
  const [preload, setPreload] = useState<Preload | null>(null);
  const [error, setError] = useState<unknown>(null);
  const refresh = useCallback(async () => {
    if (!db) return;
    try {
      const p = await api<Preload>('/api/preload', { session });
      await db.cache.put({ key: 'preload', value: p, savedAt: p.generatedAt });
      setPreload(p);
      setError(null);
    } catch (e) {
      setError(e);
      const c = await db.cache.get('preload');
      if (c) setPreload(c.value as Preload);
    }
  }, [db, session]);
  useEffect(() => {
    if (!db) return;
    db.cache.get('preload').then((c) => c && setPreload(c.value as Preload));
  }, [db]);
  useEffect(() => {
    if (connection === 'online') refresh();
  }, [connection, refresh]);
  return { preload, error, refresh };
}

function Freshness({ preload, error }: { preload: Preload | null; error: unknown }) {
  if (!preload) return null;
  const stale = !!error;
  return (
    <p className={`text-xs ${stale ? 'text-amber' : 'text-ink-2'}`}>
      {stale ? 'Données locales, peut-être périmées — ' : 'Fiches préchargées — '}
      mises à jour le <span className="num">{formatInstant(Date.parse(preload.generatedAt))}</span>
    </p>
  );
}

const locName = (locs: LocationDto[] | undefined, id: string | null) => (id ? (locs?.find((l) => l.id === id)?.name ?? id) : '—');

export function AnimalSearch() {
  const { preload, error } = usePreload();
  const [q, setQ] = useState('');
  const list = useMemo(() => (preload?.cards ?? []).filter((c) => c.animal.tag.toUpperCase().includes(q.trim().toUpperCase())), [preload, q]);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="card p-4">
        <label htmlFor="search" className="mb-1 block font-semibold">
          Rechercher un animal
        </label>
        <input id="search" className="input w-full" placeholder="Identifiant, ex. B-017" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <a href="#/scan" className="btn btn-sm">
            Scanner un QR code
          </a>
          <p className="hint flex-1">Le QR code n’est qu’un raccourci vers une fiche : il ne prouve pas l’identité physique de l’animal. La recherche manuelle reste toujours possible.</p>
        </div>
        <div className="mt-2">
          <Freshness preload={preload} error={error} />
        </div>
      </div>
      {!preload && error ? <ErrorView error={error} /> : null}
      {!preload && !error ? <Loading label="Chargement des fiches autorisées…" /> : null}
      {preload && (
        <ul className="card divide-y divide-line" aria-label="Résultats de recherche">
          {list.length === 0 && (
            <li>
              <Empty title="Aucun animal ne correspond">Vérifiez l’identifiant saisi.</Empty>
            </li>
          )}
          {list.map((c) => (
            <li key={c.animal.id}>
              <a href={`#/animal/${encodeURIComponent(c.animal.id)}`} className="flex min-h-14 items-center justify-between gap-3 px-4 py-2 hover:bg-surface-2">
                <span>
                  <span className="num text-base font-semibold">{c.animal.tag}</span> <span className="text-ink-2">· {c.animal.species}</span>
                </span>
                <span className="text-sm text-ink-2">{c.currentLocationId ? `Actuellement : ${locName(preload.locations, c.currentLocationId)}` : 'Lieu actuel non enregistré'}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AnimalCard({ id }: { id: string }) {
  const { session, connection } = useApp();
  const { preload, error: preloadError } = usePreload();
  const [live, setLive] = useState<CardDto | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (connection !== 'online') return;
    api<CardDto>(`/api/animals/${encodeURIComponent(id)}`, { session })
      .then((c) => (setLive(c), setError(null)))
      .catch(setError);
  }, [id, session, connection]);
  const cached = preload?.cards.find((c) => c.animal.id === id) ?? null;
  const card = live ?? cached;
  const locs = preload?.locations;
  if (!card) return error ? <ErrorView error={error} /> : preload ? <ErrorView error={new ApiFailure(404, { error: 'NOT_FOUND', message: 'Fiche non préchargée sur cet appareil' })} /> : <Loading />;
  const entries = [
    ...card.presences.map((p) => ({ k: p.id, sort: Date.parse((p.start as { at?: string }).at ?? (p.start as { date?: string }).date ?? '1970-01-01'), p })),
  ];
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <a href="#/animaux" className="text-sm">
        ← Recherche
      </a>
      <section className="card" aria-labelledby="fiche-h">
        <div className="flex flex-wrap items-start justify-between gap-3 p-4">
          <div>
            <h1 id="fiche-h" className="text-xl font-bold">
              Fiche <span className="num">{card.animal.tag}</span>
            </h1>
            <p className="text-ink-2">
              {card.animal.species} · lieu actuel enregistré : <b>{locName(locs, card.currentLocationId)}</b>
            </p>
            {!live && <Freshness preload={preload} error={preloadError ?? error ?? true} />}
          </div>
          <button className="btn btn-primary" onClick={() => go(`declarer/${encodeURIComponent(card.animal.id)}`)}>
            Nouvelle observation
          </button>
        </div>
        <div className="border-t border-line px-4 py-3">
          <FicheQr animalId={card.animal.id} />
        </div>
      </section>
      <section className="card" aria-labelledby="parcours-h">
        <h2 id="parcours-h" className="card-h">
          Présences enregistrées
        </h2>
        <ol className="divide-y divide-line">
          {entries
            .sort((a, b) => a.sort - b.sort)
            .map(({ k, p }) => (
              <li key={k} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
                <span className="font-medium">{locName(locs, p.locationId)}</span>
                <span className="text-sm">
                  <span className="num">{formatTemporal(p.start)}</span> → <span className="num">{formatTemporal(p.end)}</span>
                  <span className="hint ml-2">
                    ({p.id}, rév. {p.rev})
                  </span>
                </span>
              </li>
            ))}
        </ol>
      </section>
      <section className="card" aria-labelledby="obs-h">
        <h2 id="obs-h" className="card-h">
          Observations transmises
        </h2>
        {card.observations.length === 0 ? (
          <Empty title="Aucune observation transmise">Les déclarations en attente sont dans « Déclarations ».</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {card.observations.map((o) => (
              <li key={o.id} className="px-4 py-3">
                <p>{o.note}</p>
                <p className="hint">
                  Événement : {formatTemporal(o.eventTime)} · reçu le <span className="num">{formatInstant(Date.parse(o.receivedAt))}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const emptyDraft = (animalId: string): ObservationDraft => ({ id: 'observation', animalId, locationId: '', precision: 'INSTANT', date: '', time: '', note: '', updatedAt: '' });

export function ObservationForm({ animalId }: { animalId: string }) {
  const { db, bumpOutbox } = useApp();
  const { preload } = usePreload();
  const [draft, setDraft] = useState<ObservationDraft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [restored, setRestored] = useState(false);
  /** Champs remplis par l'aide à la saisie, avec leur statut : signalés tant que l'utilisateur ne les a pas repris à la main. */
  const [assisted, setAssisted] = useState<Partial<Record<'locationId' | 'eventTime' | 'note', DraftField<unknown>['status']>>>({});

  useEffect(() => {
    if (!db) return;
    db.drafts.get('observation').then((d) => {
      if (d && d.animalId === animalId) {
        setDraft(d);
        setRestored(!!d.updatedAt);
      } else {
        const card = preload?.cards.find((c) => c.animal.id === animalId);
        setDraft({ ...emptyDraft(animalId), locationId: card?.currentLocationId ?? '' });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, animalId]);

  // Les fiches préchargées peuvent arriver après le brouillon : préremplir le lieu actuel si rien n'est choisi.
  useEffect(() => {
    if (!draft || draft.locationId || restored || draft.animalId !== animalId) return;
    const current = preload?.cards.find((c) => c.animal.id === animalId)?.currentLocationId;
    if (current) setDraft((d) => (d && !d.locationId ? { ...d, locationId: current } : d));
  }, [preload, draft, animalId, restored]);

  /** Brouillon local enregistré à chaque modification : survit à la fermeture de l'onglet. */
  const update = (patch: Partial<ObservationDraft>) => {
    setDraft((d) => {
      const next = { ...(d ?? emptyDraft(animalId)), ...patch, updatedAt: new Date().toISOString() };
      db?.drafts.put(next);
      return next;
    });
  };

  if (!draft || !db) return <Loading />;
  const temporal: TemporalDraft = { precision: draft.precision, date: draft.date, time: draft.time };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const t = toTemporal(temporal);
    if (t.error) errs.eventTime = t.error;
    if (!draft.locationId) errs.locationId = 'Choisissez le lieu de l’observation';
    if (draft.note.trim().length < 3) errs.note = 'Décrivez l’observation (3 caractères minimum)';
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(Object.keys(errs)[0] === 'eventTime' ? 'obs-time-date' : `obs-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    await enqueueObservation(db, { animalId, locationId: draft.locationId, eventTime: t.value!, note: draft.note.trim() });
    bumpOutbox();
    go('envois');
  };

  return (
    <form className="mx-auto max-w-2xl space-y-4" onSubmit={submit} noValidate>
      <a href={`#/animal/${encodeURIComponent(animalId)}`} className="text-sm">
        ← Fiche {animalId}
      </a>
      <div className="card space-y-4 p-4">
        <h1 className="text-xl font-bold">
          Nouvelle observation · <span className="num">{animalId}</span>
        </h1>
        {restored && <Banner tone="info">Brouillon local restauré sur cet appareil.</Banner>}
        <p className="hint">La saisie est conservée sur cet appareil, même sans connexion. Elle sera transmise depuis « Déclarations ».</p>
        <AssistPanel
          animalId={animalId}
          locations={preload?.locations ?? []}
          onApply={(d) => {
            // Les champs proposés sont reportés tout de suite dans le formulaire. Rien n'est enregistré : l'utilisateur vérifie, puis valide.
            const t = d.eventTime.value;
            update({
              ...(d.site.value ? { locationId: d.site.value } : {}),
              ...(d.note.value ? { note: d.note.value } : {}),
              ...(t?.precision === 'INSTANT' ? { precision: 'INSTANT' as const, date: t.at.slice(0, 10), time: t.at.slice(11, 16) } : {}),
              ...(t?.precision === 'DAY' ? { precision: 'DAY' as const, date: t.date, time: '' } : {}),
              ...(t?.precision === 'UNKNOWN' ? { precision: 'UNKNOWN' as const, date: '', time: '' } : {}),
            });
            setAssisted({ ...(d.site.value ? { locationId: d.site.status } : {}), ...(t ? { eventTime: d.eventTime.status } : {}), ...(d.note.value ? { note: d.note.status } : {}) });
            setErrors({});
          }}
        />
        <div className="field">
          <label htmlFor="obs-locationId">Lieu</label>
          <select id="obs-locationId" className="input" value={draft.locationId} aria-invalid={!!errors.locationId} aria-describedby={errors.locationId ? 'err-loc' : undefined} onChange={(e) => {
              update({ locationId: e.target.value });
              setAssisted((a) => ({ ...a, locationId: undefined }));
            }}
          >
            <option value="">— Choisir —</option>
            {(preload?.locations ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {assisted.locationId && <p className="hint text-info">Rempli par l’aide à la saisie{assisted.locationId === 'DEDUCED' ? ' : lieu proposé, à vérifier.' : '.'}</p>}
          {errors.locationId && (
            <p id="err-loc" className="field-error">
              {errors.locationId}
            </p>
          )}
        </div>
        <TemporalFields
          id="obs-time"
          legend="Moment de l’observation"
          value={temporal}
          onChange={(v) => {
            update(v);
            setAssisted((a) => ({ ...a, eventTime: undefined }));
          }}
          error={errors.eventTime}
        />
        {assisted.eventTime && <p className="hint text-info">Rempli par l’aide à la saisie{assisted.eventTime === 'TO_CONFIRM' ? ' : à confirmer.' : '.'} Aucune heure n’est supposée si vous ne l’avez pas dite.</p>}
        <div className="field">
          <label htmlFor="obs-note">Observation</label>
          <textarea id="obs-note" className="input" value={draft.note} aria-invalid={!!errors.note} aria-describedby={errors.note ? 'err-note' : 'note-hint'} onChange={(e) => {
              update({ note: e.target.value });
              setAssisted((a) => ({ ...a, note: undefined }));
            }}
            maxLength={1000}
          />
          {assisted.note && <p className="hint text-info">Rempli par l’aide à la saisie. Relisez : c’est votre observation qui sera enregistrée.</p>}
          <p id="note-hint" className="hint">
            Décrivez ce qui est constaté, sans conclusion diagnostique.
          </p>
          {errors.note && (
            <p id="err-note" className="field-error">
              {errors.note}
            </p>
          )}
        </div>
        <p className="hint">L’heure de saisie sera enregistrée automatiquement, séparément du moment de l’observation.</p>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary">
            Enregistrer sur l’appareil
          </button>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              await db.drafts.delete('observation');
              go(`animal/${encodeURIComponent(animalId)}`);
            }}
          >
            Abandonner le brouillon
          </button>
        </div>
      </div>
    </form>
  );
}

const STATE_STYLE: Record<OutboxItem['state'], string> = {
  PENDING: 'bg-amber-soft text-amber',
  SENDING: 'bg-info-soft text-info',
  RECEIVED: 'bg-petrol-soft text-petrol',
  FAILED: 'bg-danger-soft text-danger',
};
const STATE_ICON: Record<OutboxItem['state'], string> = { PENDING: '↑', SENDING: '…', RECEIVED: '✓', FAILED: '!' };

export function Outbox() {
  const { db, outboxVersion, syncNow, syncing, connection } = useApp();
  const [items, setItems] = useState<OutboxItem[] | null>(null);
  const [draft, setDraft] = useState<ObservationDraft | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  useEffect(() => {
    if (!db) return;
    db.outbox.orderBy('createdAt').reverse().toArray().then(setItems);
    db.drafts.get('observation').then((d) => setDraft(d ?? null));
  }, [db, outboxVersion]);
  const pending = items?.filter((i) => i.state === 'PENDING' || (i.state === 'FAILED' && !i.permanent)).length ?? 0;

  const run = async (includeFailed: boolean) => {
    setMessage(null);
    const r = await syncNow(includeFailed);
    if (!r) return;
    if (r.failed) setMessage({ tone: 'error', text: `${r.sent} transmise(s), ${r.failed} en échec. Vérifiez la connexion puis réessayez.` });
    else if (r.sent) setMessage({ tone: 'ok', text: `${r.sent} déclaration(s) reçue(s) par le serveur.` });
    else setMessage({ tone: 'warn', text: 'Rien à transmettre.' });
  };

  if (!items) return <Loading />;
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <h1 className="text-xl font-bold">Déclarations</h1>
          <p className="hint">Le retour du réseau ne déclenche pas d’envoi automatique : transmettez explicitement.</p>
        </div>
        <button className="btn btn-primary" disabled={syncing || pending === 0} onClick={() => run(true)}>
          {syncing ? 'Transmission…' : `Transmettre (${pending})`}
        </button>
      </div>
      <div aria-live="polite">{message && <Banner tone={message.tone}>{message.text}</Banner>}</div>
      {connection === 'offline' && pending > 0 && <Banner tone="warn">Hors connexion : les déclarations restent sur cet appareil jusqu’à la transmission.</Banner>}
      {draft?.updatedAt && (
        <div className="card flex flex-wrap items-center justify-between gap-2 p-4">
          <span>
            <span className="status bg-surface-2 text-ink-2">✎ Brouillon local</span> <span className="num ml-2">{draft.animalId}</span> — non finalisé
          </span>
          <button className="btn btn-sm" onClick={() => go(`declarer/${encodeURIComponent(draft.animalId)}`)}>
            Reprendre
          </button>
        </div>
      )}
      <ul className="card divide-y divide-line" aria-label="File de transmission">
        {items.length === 0 && (
          <li>
            <Empty title="Aucune déclaration sur cet appareil">Ouvrez une fiche animale pour enregistrer une observation.</Empty>
          </li>
        )}
        {items.map((i) => (
          <li key={i.id} className="space-y-1 px-4 py-3" data-testid="outbox-item">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`status ${STATE_STYLE[i.state]}`}>
                <span className="status-icon" aria-hidden="true">
                  {STATE_ICON[i.state]}
                </span>
                {OUTBOX_LABELS[i.state]}
              </span>
              <span className="num">{i.payload.animalId}</span>
            </div>
            <p>{i.payload.note}</p>
            <p className="hint">
              Observation : {formatTemporal(i.payload.eventTime)} · saisie : <span className="num">{formatInstant(Date.parse(i.createdAt))}</span>
              {i.receivedAt && (
                <>
                  {' '}
                  · reçue : <span className="num">{formatInstant(Date.parse(i.receivedAt))}</span>
                </>
              )}
              {i.attempts > 0 && ` · ${i.attempts} tentative(s)`}
            </p>
            {i.state === 'FAILED' && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="field-error">{i.permanent ? `Refusée par le serveur : ${i.lastError}` : `Dernière erreur : ${i.lastError}`}</p>
                {!i.permanent && (
                  <button className="btn btn-sm" onClick={() => run(true)} disabled={syncing}>
                    Réessayer
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface TaskDto {
  id: string;
  recordId: string;
  kind: string;
  label: string;
  status: 'OPEN' | 'REQUESTED' | 'DONE';
  doneRev: number | null;
  record: Presence | Movement | null;
}

export function AgentTasks() {
  const { session } = useApp();
  const [tasks, setTasks] = useState<TaskDto[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    api<TaskDto[]>('/api/tasks', { session })
      .then((t) => (setTasks(t), setError(null)))
      .catch(setError);
  }, [session]);
  useEffect(load, [load]);
  if (error && !tasks) return <ErrorView error={error} onRetry={load} />;
  if (!tasks) return <Loading />;
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="card p-4">
        <h1 className="text-xl font-bold">Vérifications demandées</h1>
        <p className="hint">Priorité administrative, pas une urgence clinique. Une correction crée une nouvelle révision ; l’ancienne est conservée.</p>
      </div>
      <ul className="card divide-y divide-line">
        {tasks.length === 0 && (
          <li>
            <Empty title="Aucune vérification demandée" />
          </li>
        )}
        {tasks.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div>
              <p className="font-medium">{t.label}</p>
              <p className="hint">
                {t.recordId} · {t.status === 'DONE' ? `complétée (révision ${t.doneRev})` : 'à compléter'}
              </p>
            </div>
            {t.status === 'REQUESTED' && t.record && (
              <button className="btn btn-primary btn-sm" onClick={() => go(`tache/${t.id}`)}>
                Compléter
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function draftFrom(v: TemporalValueDto | null): TemporalDraft {
  if (!v) return { precision: 'INSTANT', date: '', time: '' };
  if (v.precision === 'INSTANT') return { precision: 'INSTANT', date: v.at.slice(0, 10), time: v.at.slice(11, 16) };
  if (v.precision === 'DAY') return { precision: 'INSTANT', date: v.date, time: '' };
  return { precision: 'INSTANT', date: '', time: '' };
}

export function TaskCorrection({ taskId }: { taskId: string }) {
  const { session, connection } = useApp();
  const [task, setTask] = useState<TaskDto | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [first, setFirst] = useState<TemporalDraft>({ precision: 'INSTANT', date: '', time: '' });
  const [second, setSecond] = useState<TemporalDraft>({ precision: 'INSTANT', date: '', time: '' });
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const idemKey = useMemo(() => crypto.randomUUID(), [taskId]);
  const [savedRev, setSavedRev] = useState<number | null>(null);

  useEffect(() => {
    setResult(null);
    setSavedRev(null);
    setReason('');
    setErrors({});
    api<TaskDto[]>('/api/tasks', { session })
      .then((ts) => {
        const t = ts.find((x) => x.id === taskId) ?? null;
        setTask(t);
        if (t?.record?.kind === 'presence') {
          setFirst(draftFrom(t.record.start));
          setSecond(draftFrom(t.record.end));
        } else if (t?.record?.kind === 'movement') {
          setFirst(draftFrom(t.record.departure));
          setSecond(draftFrom(t.record.arrival));
        }
      })
      .catch(setError);
  }, [taskId, session]);

  if (error) return <ErrorView error={error} />;
  if (!task) return <Loading />;
  const rec = task.record;
  if (!rec) return <ErrorView error={new ApiFailure(404, { error: 'NOT_FOUND', message: 'Enregistrement introuvable' })} />;
  const isPresence = rec.kind === 'presence';
  const labels = isPresence ? ['Arrivée au lieu', 'Départ du lieu'] : ['Départ', 'Arrivée'];
  const keys = isPresence ? ['start', 'end'] : ['departure', 'arrival'];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const a = toTemporal(first);
    const b = toTemporal(second);
    const errs: Record<string, string> = {};
    if (a.error) errs[keys[0]!] = a.error;
    if (b.error) errs[keys[1]!] = b.error;
    if (reason.trim().length < 3) errs.reason = 'Indiquez la source de la correction';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setResult(null);
    try {
      const body = isPresence
        ? { kind: 'presence', idempotencyKey: idemKey, baseRev: rec.rev, start: a.value, end: b.value, reason: reason.trim() }
        : { kind: 'movement', idempotencyKey: idemKey, baseRev: rec.rev, departure: a.value, arrival: b.value, reason: reason.trim() };
      const r = await api<{ rev: number }>(`/api/records/${encodeURIComponent(rec.id)}/revisions`, { method: 'POST', session, body });
      setResult({ tone: 'ok', text: `Révision ${r.rev} enregistrée. La révision ${rec.rev} reste consultable. L’enquêteur peut relancer l’analyse.` });
      setSavedRev(r.rev);
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 400 && err.body.fields) setErrors(err.body.fields as Record<string, string>);
      setResult({ tone: 'error', text: err instanceof NetworkError ? `${err.message}. La correction n’a pas été enregistrée : réessayez une fois connecté.` : errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  if (savedRev !== null)
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <a href="#/taches" className="text-sm">
          ← Vérifications
        </a>
        <div className="card space-y-4 p-4">
          <h1 className="text-xl font-bold">{task.label}</h1>
          <Banner tone="ok">
            Révision {savedRev} enregistrée pour {rec.id}. La révision {rec.rev} reste consultable. L’enquêteur peut relancer l’analyse.
          </Banner>
          <a className="btn btn-primary" href="#/taches">
            Retour aux vérifications
          </a>
        </div>
      </div>
    );

  return (
    <form className="mx-auto max-w-2xl space-y-4" onSubmit={submit} noValidate>
      <a href="#/taches" className="text-sm">
        ← Vérifications
      </a>
      <div className="card space-y-4 p-4">
        <h1 className="text-xl font-bold">{task.label}</h1>
        <div className="rounded-lg bg-surface-2 p-3 text-sm">
          <p className="font-semibold">
            Valeur actuelle — {rec.id}, révision {rec.rev}
          </p>
          {rec.kind === 'presence' ? (
            <p>
              Début : <span className="num">{formatTemporal(rec.start)}</span> ({precisionLabel(rec.start)}) · Fin : <span className="num">{formatTemporal(rec.end)}</span> ({precisionLabel(rec.end)})
            </p>
          ) : (
            <p>
              Départ : <span className="num">{formatTemporal(rec.departure)}</span> · Arrivée : <span className="num">{formatTemporal(rec.arrival)}</span>
            </p>
          )}
          <p className="hint">Source : {rec.source}</p>
        </div>
        {connection === 'offline' && <Banner tone="warn">Hors connexion : la correction nécessite le serveur (elle n’est pas mise en file dans ce démonstrateur).</Banner>}
        <TemporalFields id="fix-start" legend={labels[0]!} value={first} onChange={setFirst} error={errors[keys[0]!]} allowUnknown={false} />
        <TemporalFields id="fix-end" legend={labels[1]!} value={second} onChange={setSecond} error={errors[keys[1]!]} allowUnknown={false} />
        <div className="field">
          <label htmlFor="fix-reason">Source de l’information</label>
          <input id="fix-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={!!errors.reason} aria-describedby={errors.reason ? 'err-reason' : undefined} placeholder="ex. registre du marché consulté sur place" />
          {errors.reason && (
            <p id="err-reason" className="field-error">
              {errors.reason}
            </p>
          )}
        </div>
        <p className="hint">La correction sera enregistrée comme « déclarée par un agent, non vérifiée ».</p>
        <div aria-live="polite">{result && <Banner tone={result.tone}>{result.text}</Banner>}</div>
        {result?.tone !== 'ok' && (
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Enregistrement…' : 'Enregistrer la correction'}
          </button>
        )}
      </div>
    </form>
  );
}

const FIELD_STATUS: Record<DraftField<unknown>['status'], string> = { OK: 'dit dans la phrase', DEDUCED: 'proposé, à vérifier', TO_CONFIRM: 'à confirmer', MISSING: 'à indiquer', AMBIGUOUS: 'à choisir' };

/**
 * Aide à la saisie : l'utilisateur dit ou écrit son observation, le formulaire se remplit tout seul, et l'assistant répond ici
 * (ce qu'il a rempli, ce qui reste à indiquer). Avec un assistant IA configuré sur le serveur, c'est lui qui lit la phrase ;
 * sinon elle est lue par des règles fixes, et le volet le dit. Rien n'est enregistré sans la validation du formulaire.
 */
function AssistPanel({ animalId, locations, onApply }: { animalId: string; locations: LocationDto[]; onApply: (d: ObservationDraftData) => void }) {
  const { health, connection, session } = useApp();
  const [text, setText] = useState('');
  const [res, setRes] = useState<ObservationAssistReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const assistant = health?.assistant;
  const online = connection === 'online';
  const serverVoice = !!assistant?.voice?.speech;
  useEffect(() => () => stopSpeech(), []);

  const say = (reply: string) => {
    setSpeaking(true);
    void playSpeech(reply, { session, server: serverVoice, onState: (st) => st === null && setSpeaking(false) });
  };
  /** Lit la phrase, remplit le formulaire, affiche la réponse. Une phrase dictée reçoit aussi une réponse dite. */
  const fill = async (sentence: string, spoken = false) => {
    const t = sentence.trim();
    if (t.length < 3 || busy) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api<ObservationAssistReply>('/api/assistant/observation', { method: 'POST', session, body: { text: t, animalId }, timeoutMs: 30_000 });
      setRes(r);
      onApply(r.result.data);
      if (spoken) say(r.reply);
    } catch (e) {
      setRes(null);
      setError(e instanceof NetworkError ? 'Serveur injoignable : l’aide à la saisie est indisponible. Remplissez le formulaire à la main.' : e instanceof ApiFailure && e.body.fields ? Object.values(e.body.fields as Record<string, string>).join(' ') : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const d = res?.result.data;
  const siteName = d?.site.value ? (locations.find((l) => l.id === d.site.value)?.name ?? d.site.value) : null;

  return (
    <details className="rounded-lg border border-line bg-surface-2 p-3" open>
      <summary className="cursor-pointer font-semibold">Aide à la saisie : dites ou écrivez, le formulaire se remplit</summary>
      {!online ? (
        <p className="hint mt-2">Aide à la saisie indisponible hors connexion. La saisie manuelle ci-dessous est complète.</p>
      ) : (
        <div className="mt-2 space-y-2">
          <p className="hint">
            {assistant?.configured ? `Assistant IA connecté : ${assistant.provider} (${assistant.model}). ` : 'Sans assistant IA sur ce serveur : la phrase est lue par des règles fixes. '}
            Les champs ci-dessous sont remplis automatiquement à partir de votre phrase. Vous vérifiez, puis vous enregistrez.
          </p>
          <label htmlFor="assist-text" className="block text-sm font-semibold">
            Votre observation, en une phrase
          </label>
          <textarea
            id="assist-text"
            className="input w-full"
            maxLength={1000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void fill(text);
              }
            }}
            placeholder="ex. Elle mange moins depuis ce matin, à Élevage A."
          />
          <div className="flex flex-wrap items-start gap-3">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => fill(text)} disabled={busy || text.trim().length < 3}>
              {busy ? 'Lecture de la phrase…' : 'Remplir le formulaire'}
            </button>
            {(assistant?.voice?.available || assistant?.configured) && (
              <Dictation
                session={session}
                available={!!assistant?.voice?.available}
                maxSeconds={assistant?.voice?.maxSeconds ?? 30}
                offline={!online}
                unavailableReason="Dictée indisponible sur ce serveur. Écrivez la phrase."
                quiet
                onText={(t) => {
                  setText(t);
                  void fill(t, true);
                }}
              />
            )}
          </div>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          {res && d && (
            <div className="space-y-2 rounded-lg border border-info/30 bg-surface p-3 text-sm" role="status" aria-live="polite" aria-label="Réponse de l’aide à la saisie">
              <p className="text-[15px] font-semibold">{res.reply}</p>
              <dl className="grid grid-cols-[110px_1fr] gap-1">
                <dt>Animal</dt>
                <dd>
                  <span className="num">{animalId}</span> <span className="hint">(celui de ce formulaire)</span>
                </dd>
                <dt>Lieu</dt>
                <dd>
                  {siteName ?? '—'} <span className="hint">({FIELD_STATUS[d.site.status]})</span>
                  {d.site.status === 'DEDUCED' && d.site.message && <span className="hint block">{d.site.message}</span>}
                </dd>
                <dt>Moment</dt>
                <dd>
                  {d.eventTime.value ? formatTemporal(d.eventTime.value) : '—'} <span className="hint">({FIELD_STATUS[d.eventTime.status]})</span>
                </dd>
                <dt>Observation</dt>
                <dd>
                  {d.note.value ?? '—'} <span className="hint">({FIELD_STATUS[d.note.status]})</span>
                </dd>
              </dl>
              {res.otherAnimal && <p className="field-error">Votre phrase nomme {res.otherAnimal} : ce formulaire reste celui de {animalId}.</p>}
              <p className="hint">{res.notice}</p>
              {(serverVoice || canSpeak()) && (
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-pressed={speaking}
                  onClick={() => {
                    if (speaking) {
                      stopSpeech();
                      setSpeaking(false);
                    } else say(res.reply);
                  }}
                >
                  {speaking ? '■ Arrêter la lecture' : '▶ Écouter la réponse'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </details>
  );
}
