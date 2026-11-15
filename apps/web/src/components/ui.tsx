import type { ReactNode } from 'react';
import type { ResultStatus } from '@sentinelle/domain';
import type { TemporalValueDto } from '@sentinelle/contracts';
import { ApiFailure, NetworkError } from '../api';

/** Statuts : icône + libellé texte, jamais la couleur seule. */
export const STATUS_STYLE: Record<ResultStatus, { label: string; short: string; icon: string; cls: string; stroke: string; dash?: string }> = {
  MOVEMENT_RECORDED: { label: 'Mouvement enregistré', short: 'Mouvement enregistré', icon: '→', cls: 'bg-petrol-soft text-petrol', stroke: '#0F5F5C' },
  POTENTIAL_LINK: { label: 'Lien potentiel selon les paramètres', short: 'Lien potentiel', icon: '≈', cls: 'bg-info-soft text-info', stroke: '#1D4F91' },
  INSUFFICIENT_INFO: { label: 'Information insuffisante', short: 'Information insuffisante', icon: '?', cls: 'bg-amber-soft text-amber', stroke: '#B07A10', dash: '2 5' },
  PATH_EXCLUDED: { label: 'Chemin exclu par cette recherche', short: 'Chemin exclu', icon: '∅', cls: 'bg-excluded-soft text-excluded', stroke: '#8C96A1', dash: '8 6' },
  DATA_ANOMALY: { label: 'Anomalie de données', short: 'Anomalie de données', icon: '!', cls: 'bg-danger-soft text-danger', stroke: '#A61B1B', dash: '3 3' },
};

export function StatusBadge({ status, long = false }: { status: ResultStatus; long?: boolean }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`status ${s.cls}`}>
      <span className="status-icon" aria-hidden="true">
        {s.icon}
      </span>
      {long ? s.label : s.short}
    </span>
  );
}

export function Loading({ label = 'Chargement…' }: { label?: string }) {
  return (
    <p role="status" className="p-6 text-ink-2">
      {label}
    </p>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="p-6 text-center">
      <p className="font-semibold">{title}</p>
      {children && <div className="hint mt-1">{children}</div>}
    </div>
  );
}

export function ErrorView({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  let title = 'Une erreur est survenue';
  let detail = 'Réessayez dans un instant.';
  if (error instanceof NetworkError) {
    title = 'Serveur injoignable';
    detail = `${error.message}. Les données affichées peuvent être périmées.`;
  } else if (error instanceof ApiFailure) {
    if (error.status === 403) {
      title = 'Accès refusé';
      detail = 'Votre rôle ne permet pas de consulter cette page.';
    } else if (error.status === 404) {
      title = 'Introuvable';
      detail = error.message;
    } else detail = error.message;
  }
  return (
    <div role="alert" className="m-4 rounded-lg border border-danger/30 bg-danger-soft p-4">
      <p className="font-semibold text-danger">{title}</p>
      <p className="text-ink-2">{detail}</p>
      {onRetry && (
        <button className="btn btn-sm mt-3" onClick={onRetry}>
          Réessayer
        </button>
      )}
    </div>
  );
}

export function Banner({ tone, children }: { tone: 'info' | 'warn' | 'ok' | 'error'; children: ReactNode }) {
  const cls = {
    info: 'border-info/30 bg-info-soft text-info',
    warn: 'border-amber-line bg-amber-soft text-amber',
    ok: 'border-petrol/30 bg-petrol-soft text-petrol',
    error: 'border-danger/30 bg-danger-soft text-danger',
  }[tone];
  return <div className={`rounded-lg border px-4 py-3 ${cls}`}>{children}</div>;
}

// ---------- Saisie temporelle avec précision explicite ----------

export interface TemporalDraft {
  precision: TemporalValueDto['precision'];
  date: string;
  time: string;
}

export function toTemporal(d: TemporalDraft): { value: TemporalValueDto | null; error: string | null } {
  if (d.precision === 'UNKNOWN') return { value: { precision: 'UNKNOWN' }, error: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return { value: null, error: 'Indiquez la date' };
  if (d.precision === 'DAY') return { value: { precision: 'DAY', date: d.date }, error: null };
  if (!/^\d{2}:\d{2}$/.test(d.time)) return { value: null, error: 'Indiquez l’heure, ou choisissez « jour seulement »' };
  // Africa/Abidjan = UTC+0 : l'heure saisie est l'heure UTC.
  return { value: { precision: 'INSTANT', at: new Date(`${d.date}T${d.time}:00Z`).toISOString() }, error: null };
}

export function TemporalFields({
  id,
  legend,
  value,
  onChange,
  error,
  allowUnknown = true,
}: {
  id: string;
  legend: string;
  value: TemporalDraft;
  onChange: (v: TemporalDraft) => void;
  error?: string | null;
  allowUnknown?: boolean;
}) {
  const errId = `${id}-err`;
  const options: [TemporalDraft['precision'], string][] = [
    ['INSTANT', 'Date et heure'],
    ['DAY', 'Jour seulement'],
    ...(allowUnknown ? ([['UNKNOWN', 'Inconnue']] as [TemporalDraft['precision'], string][]) : []),
  ];
  return (
    <fieldset className="field" aria-describedby={error ? errId : undefined}>
      <legend className="mb-1">{legend}</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={`Précision — ${legend}`}>
        {options.map(([p, label]) => (
          <label key={p} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 ${value.precision === p ? 'border-petrol bg-petrol-soft' : 'border-line bg-surface'}`}>
            <input type="radio" name={`${id}-precision`} checked={value.precision === p} onChange={() => onChange({ ...value, precision: p })} />
            {label}
          </label>
        ))}
      </div>
      {value.precision !== 'UNKNOWN' && (
        <div className="mt-2 flex flex-wrap gap-3">
          <div className="field">
            <label htmlFor={`${id}-date`}>Date</label>
            <input id={`${id}-date`} type="date" className="input" value={value.date} aria-invalid={!!error && !value.date} onChange={(e) => onChange({ ...value, date: e.target.value })} />
          </div>
          {value.precision === 'INSTANT' && (
            <div className="field">
              <label htmlFor={`${id}-time`}>Heure (Abidjan)</label>
              <input id={`${id}-time`} type="time" className="input" value={value.time} aria-invalid={!!error && !value.time} onChange={(e) => onChange({ ...value, time: e.target.value })} />
            </div>
          )}
        </div>
      )}
      {value.precision === 'DAY' && <p className="hint">Aucune heure ne sera supposée.</p>}
      {error && (
        <p id={errId} className="field-error">
          {error}
        </p>
      )}
    </fieldset>
  );
}
