import { useEffect, useState } from 'react';
import { formatInstant, formatTemporal } from '@sentinelle/domain';
import { TASK_STATUS_LABELS } from '@sentinelle/contracts';
import { api } from '../api';
import { useApp, useResource } from '../state';
import { ErrorView, Loading, StatusBadge } from '../components/ui';
import { GROUPS, History, type InvestigationDto, type RunDto, SummaryPanel, VERIF } from './console';

/** Rapport d'enquête imprimable : état exact d'une analyse, avec preuves, limites et historique. */
export function Report({ id, seq }: { id: string; seq: number }) {
  const { session } = useApp();
  const inv = useResource<InvestigationDto>(`/api/investigations/${id}`);
  const [run, setRun] = useState<RunDto | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api<RunDto>(`/api/investigations/${id}/runs/${seq}`, { session }).then(setRun).catch(setError);
  }, [id, seq, session]);
  if (error || inv.error) return <ErrorView error={error ?? inv.error} />;
  if (!run || !inv.data) return <Loading label="Préparation du rapport…" />;
  const d = inv.data;
  const loc = (lid: string) => d.locations.find((l) => l.id === lid)?.name ?? lid;
  const generated = formatInstant(Date.now());

  return (
    <article className="mx-auto max-w-4xl space-y-4 print:max-w-none" aria-labelledby="rep-h">
      <div className="no-print flex flex-wrap gap-2">
        <a href={`#/enquete/${id}`} className="btn btn-sm">
          ← Console d’enquête
        </a>
        <button className="btn btn-primary btn-sm" onClick={() => window.print()}>
          Imprimer / enregistrer en PDF
        </button>
      </div>

      <header className="card space-y-2 p-4">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">Sentinelle — rapport d’enquête · données synthétiques</p>
        <h1 id="rep-h" className="text-xl font-bold">
          Signalement sur <span className="num">{d.observation.animalId}</span> — analyse n° {run.seq}
        </h1>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[200px_1fr]">
          <dt className="font-semibold">Observation</dt>
          <dd>
            « {d.observation.note} » — {loc(d.observation.locationId)}, {formatTemporal(d.observation.eventTime)}
          </dd>
          <dt className="font-semibold">Fenêtre d’enquête</dt>
          <dd className="num">
            {formatInstant(Date.parse(run.params.window.from)).slice(0, 10)} → {formatInstant(Date.parse(run.params.window.to)).slice(0, 10)} (fin exclue)
          </dd>
          <dt className="font-semibold">Règle et paramètres</dt>
          <dd>
            R-B1, chevauchement de présence dans un même lieu (règle de démonstration à valider) · profondeur {run.params.maxDepth} · durée minimale {run.params.minOverlapMinutes} min
          </dd>
          <dt className="font-semibold">Analyse calculée le</dt>
          <dd className="num">{formatInstant(Date.parse(run.createdAt))}</dd>
          <dt className="font-semibold">Moteur / instantané</dt>
          <dd className="num break-all">
            v{run.engineVersion} · {run.snapshotHash}
          </dd>
          <dt className="font-semibold">Rapport généré le</dt>
          <dd className="num">{generated}</dd>
        </dl>
      </header>

      <SummaryPanel id={id} seq={run.seq} printable />

      <section className="card" aria-labelledby="rep-res">
        <h2 id="rep-res" className="card-h">
          Résultats détaillés
        </h2>
        {GROUPS.map((g) => {
          const rs = run.output.results.filter((r) => r.level === g.level);
          return (
            <div key={g.level} className="break-inside-avoid">
              <h3 className="border-y border-line bg-surface-2 px-4 py-1.5 text-[11.5px] font-semibold tracking-wide text-muted uppercase">{g.title}</h3>
              {rs.length === 0 && <p className="hint px-4 py-2">Aucun résultat.</p>}
              {rs.map((r) => (
                <div key={r.key} className="break-inside-avoid space-y-1 border-b border-line px-4 py-3 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={r.status} long /> <b>{r.title}</b> <span className="num text-ink-2">{r.when}</span>
                  </p>
                  <p>{r.explanation}</p>
                  {r.calculation && <pre className="num rounded bg-surface-2 p-2 text-xs whitespace-pre-wrap">{r.calculation.join('\n')}</pre>}
                  <ul className="list-disc pl-5 text-ink-2">
                    {r.evidence.map((e) => {
                      const rec = run.evidenceRecords[e.recordId];
                      return (
                        <li key={e.recordId}>
                          <span className="num">{e.recordId}</span> (révision {e.rev})
                          {rec?.kind === 'presence' && ` — présence ${rec.animalId} : ${formatTemporal(rec.start)} → ${formatTemporal(rec.end)} · ${VERIF[rec.verification]} · ${rec.source}`}
                          {rec?.kind === 'movement' && ` — mouvement ${rec.animalId} : ${formatTemporal(rec.departure)} → ${formatTemporal(rec.arrival)} · ${VERIF[rec.verification]} · ${rec.source}`}
                        </li>
                      );
                    })}
                  </ul>
                  {r.limits.length > 0 && <p className="text-amber">Limites : {r.limits.join(' ')}</p>}
                </div>
              ))}
            </div>
          );
        })}
      </section>

      <section className="card break-inside-avoid p-4 text-sm" aria-labelledby="rep-lim">
        <h2 id="rep-lim" className="mb-2 font-semibold">
          Limites de la recherche
        </h2>
        <ul className="list-disc space-y-1 pl-5">
          {run.output.nonEvaluatedLocationIds.map((l) => (
            <li key={l}>{loc(l)} : aucun mouvement enregistré ne le relie à cette recherche ; la proximité géographique n’est pas évaluée.</li>
          ))}
          {run.output.limits.map((l) => (
            <li key={l}>{l}</li>
          ))}
          {run.output.truncated && <li>Liste tronquée au plafond de résultats.</li>}
        </ul>
      </section>

      <section className="card break-inside-avoid" aria-labelledby="rep-tasks">
        <h2 id="rep-tasks" className="card-h">
          Vérifications
        </h2>
        <ul className="divide-y divide-line text-sm">
          {d.tasks.length === 0 && <li className="px-4 py-2 text-ink-2">Aucune.</li>}
          {d.tasks.map((t) => (
            <li key={t.id} className="flex flex-wrap justify-between gap-2 px-4 py-2">
              <span>{t.label}</span>
              <span className="text-ink-2">
                {TASK_STATUS_LABELS[t.status]}
                {t.doneRev ? ` (révision ${t.doneRev})` : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <History id={id} version={d.runs.length} open />

      <p className="text-xs text-muted">
        Ce rapport décrit des pistes de vérification calculées à partir de données enregistrées (ici synthétiques). Il ne constitue ni un diagnostic, ni une preuve de contact ou de transmission. « Exclu par cette recherche » ne signifie pas « sans risque sanitaire ».
      </p>
    </article>
  );
}
