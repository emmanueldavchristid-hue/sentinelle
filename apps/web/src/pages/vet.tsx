import { useState } from 'react';
import { defaultWindow, formatInstant, formatTemporal } from '@sentinelle/domain';
import { OBSERVATION_STATUS_LABELS, type TemporalValueDto } from '@sentinelle/contracts';
import { api, ApiFailure, errorMessage } from '../api';
import { go, useApp, useResource } from '../state';
import { Banner, Empty, ErrorView, Loading } from '../components/ui';
import type { LocationDto } from './agent';

export interface ObservationDto {
  id: string;
  animalId: string;
  locationId: string;
  eventTime: TemporalValueDto;
  note: string;
  authorId: string;
  recordedAtClient: string;
  receivedAt: string;
  status: keyof typeof OBSERVATION_STATUS_LABELS;
  investigationId: string | null;
}

const statusCls = { NEW: 'bg-amber-soft text-amber', UNDER_INVESTIGATION: 'bg-info-soft text-info', CLOSED: 'bg-excluded-soft text-excluded' };

export function Signals() {
  const obs = useResource<ObservationDto[]>('/api/observations');
  const locs = useResource<LocationDto[]>('/api/locations');
  const name = (id: string) => locs.data?.find((l) => l.id === id)?.name ?? id;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="card p-4">
        <h1 className="text-xl font-bold">Signalements</h1>
        <p className="hint">Observations transmises par les agents. Chaque signalement est examiné par un humain avant toute enquête.</p>
      </div>
      {obs.error ? <ErrorView error={obs.error} onRetry={obs.reload} /> : null}
      {obs.loading && !obs.data ? <Loading /> : null}
      {obs.data && (
        <ul className="card divide-y divide-line">
          {obs.data.length === 0 && (
            <li>
              <Empty title="Aucun signalement reçu">Les observations apparaissent ici après leur synchronisation.</Empty>
            </li>
          )}
          {obs.data.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p>
                  <span className="num font-semibold">{o.animalId}</span> · {name(o.locationId)} · <span className={`status ${statusCls[o.status]}`}>{OBSERVATION_STATUS_LABELS[o.status]}</span>
                </p>
                <p className="truncate">{o.note}</p>
                <p className="hint">
                  Événement : {formatTemporal(o.eventTime)} · reçu le <span className="num">{formatInstant(Date.parse(o.receivedAt))}</span>
                </p>
              </div>
              {o.investigationId ? (
                <button className="btn btn-sm" onClick={() => go(`enquete/${o.investigationId}`)}>
                  Voir l’enquête
                </button>
              ) : o.status === 'NEW' ? (
                <button className="btn btn-primary btn-sm" onClick={() => go(`signalement/${o.id}`)}>
                  Examiner
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const toDate = (iso: string) => iso.slice(0, 10);
const startOfDay = (d: string) => `${d}T00:00:00.000Z`;

export function Review({ id }: { id: string }) {
  const { session } = useApp();
  const obs = useResource<ObservationDto[]>('/api/observations');
  const locs = useResource<LocationDto[]>('/api/locations');
  const o = obs.data?.find((x) => x.id === id);
  const anchor = o ? (o.eventTime.precision === 'INSTANT' ? o.eventTime.at : o.eventTime.precision === 'DAY' ? startOfDay(o.eventTime.date) : o.receivedAt) : null;
  const dw = anchor ? defaultWindow(anchor) : null;
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [depth, setDepth] = useState(2);
  const [closeNote, setCloseNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (obs.error) return <ErrorView error={obs.error} onRetry={obs.reload} />;
  if (!obs.data) return <Loading />;
  if (!o || !dw) return <ErrorView error={new ApiFailure(404, { error: 'NOT_FOUND', message: 'Signalement introuvable' })} />;
  const fromV = from ?? toDate(dw.from);
  const toV = to ?? toDate(dw.to);
  const name = (lid: string) => locs.data?.find((l) => l.id === lid)?.name ?? lid;

  const open = async () => {
    setError(null);
    if (!(fromV < toV)) return setError('La fin de la fenêtre doit suivre le début.');
    setBusy(true);
    try {
      const r = await api<{ id: string }>('/api/investigations', { method: 'POST', session, body: { observationId: o.id, window: { from: startOfDay(fromV), to: startOfDay(toV) }, maxDepth: depth } });
      go(`enquete/${r.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const close = async () => {
    setError(null);
    if (closeNote.trim().length < 3) return setError('Indiquez le motif du classement.');
    try {
      await api(`/api/observations/${o.id}/close`, { method: 'POST', session, body: { note: closeNote.trim() } });
      go('signalements');
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <a href="#/signalements" className="text-sm">
        ← Signalements
      </a>
      <section className="card" aria-labelledby="rev-h">
        <h1 id="rev-h" className="card-h text-lg">
          Examen du signalement · <span className="num">{o.animalId}</span>
        </h1>
        <dl className="grid gap-x-6 gap-y-2 p-4 sm:grid-cols-[180px_1fr]">
          <dt className="font-semibold">Observation</dt>
          <dd>{o.note}</dd>
          <dt className="font-semibold">Lieu déclaré</dt>
          <dd>{name(o.locationId)}</dd>
          <dt className="font-semibold">Moment de l’événement</dt>
          <dd className="num">{formatTemporal(o.eventTime)}</dd>
          <dt className="font-semibold">Saisie sur l’appareil</dt>
          <dd className="num">{formatInstant(Date.parse(o.recordedAtClient))}</dd>
          <dt className="font-semibold">Réception serveur</dt>
          <dd className="num">{formatInstant(Date.parse(o.receivedAt))}</dd>
        </dl>
        <p className="hint px-4 pb-4">Sentinelle n’établit aucun diagnostic. Ouvrir une enquête permet d’examiner les mouvements enregistrés.</p>
      </section>
      <section className="card space-y-4 p-4" aria-labelledby="open-h">
        <h2 id="open-h" className="text-base font-semibold">
          Ouvrir une enquête
        </h2>
        <div className="flex flex-wrap gap-3">
          <div className="field">
            <label htmlFor="w-from">Début de la fenêtre</label>
            <input id="w-from" type="date" className="input" value={fromV} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="w-to">Fin de la fenêtre (exclue)</label>
            <input id="w-to" type="date" className="input" value={toV} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="w-depth">Profondeur</label>
            <select id="w-depth" className="input" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
              <option value={1}>1 — animaux en présence chevauchante</option>
              <option value={2}>2 — et lieux suivants à vérifier</option>
            </select>
          </div>
        </div>
        <p className="hint">
          Fenêtre proposée par défaut : 15 jours avant l’observation, jusqu’au lendemain. C’est un paramètre de recherche modifiable, pas une durée d’incubation. Règle appliquée : R-B1, chevauchement de présence dans un même lieu{' '}
          <span className="tag-validate">règle de démonstration à valider</span>
        </p>
        {error && (
          <div role="alert">
            <Banner tone="error">{error}</Banner>
          </div>
        )}
        <button className="btn btn-primary" onClick={open} disabled={busy}>
          {busy ? 'Analyse en cours…' : 'Ouvrir l’enquête et lancer l’analyse'}
        </button>
      </section>
      <section className="card space-y-3 p-4" aria-labelledby="close-h">
        <h2 id="close-h" className="text-base font-semibold">
          Classer sans enquête
        </h2>
        <div className="field">
          <label htmlFor="close-note">Motif</label>
          <input id="close-note" className="input" value={closeNote} onChange={(e) => setCloseNote(e.target.value)} />
        </div>
        <button className="btn" onClick={close}>
          Classer le signalement
        </button>
      </section>
    </div>
  );
}

export function InvestigationList() {
  const inv = useResource<{ id: string; status: string; createdAt: string; animalId: string; note: string }[]>('/api/investigations');
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="card p-4">
        <h1 className="text-xl font-bold">Enquêtes</h1>
      </div>
      {inv.error ? <ErrorView error={inv.error} onRetry={inv.reload} /> : null}
      {inv.loading && !inv.data ? <Loading /> : null}
      {inv.data && (
        <ul className="card divide-y divide-line">
          {inv.data.length === 0 && (
            <li>
              <Empty title="Aucune enquête ouverte">Ouvrez une enquête depuis un signalement.</Empty>
            </li>
          )}
          {inv.data.map((i) => (
            <li key={i.id}>
              <a href={`#/enquete/${i.id}`} className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-2 hover:bg-surface-2">
                <span>
                  Signalement sur <span className="num font-semibold">{i.animalId}</span> — {i.note}
                </span>
                <span className="hint">
                  ouverte le <span className="num">{formatInstant(Date.parse(i.createdAt))}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
