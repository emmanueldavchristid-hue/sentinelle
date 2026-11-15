import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AnalysisDiff,
  type AnalysisOutput,
  type AnalysisResult,
  type Movement,
  type Presence,
  formatInstant,
  formatTemporal,
  precisionLabel,
  STATUS_LABELS,
} from '@sentinelle/domain';
import { TASK_STATUS_LABELS } from '@sentinelle/contracts';
import { api, errorMessage } from '../api';
import { useApp, useResource } from '../state';
import { Banner, ErrorView, Loading, STATUS_STYLE, StatusBadge } from '../components/ui';
import type { LocationDto } from './agent';
import type { ObservationDto } from './vet';

interface RunSummary {
  seq: number;
  engineVersion: string;
  snapshotHash: string;
  createdAt: string;
  params: AnalysisOutput['params'];
  counts: Record<string, number>;
}
interface InvestigationDto {
  investigation: { id: string; status: string; createdAt: string };
  observation: ObservationDto;
  runs: RunSummary[];
  tasks: { id: string; recordId: string; kind: string; label: string; status: keyof typeof TASK_STATUS_LABELS; doneRev: number | null }[];
  locations: LocationDto[];
}
interface RunDto {
  seq: number;
  engineVersion: string;
  snapshotHash: string;
  createdAt: string;
  params: AnalysisOutput['params'];
  output: AnalysisOutput;
  evidenceRecords: Record<string, Presence | Movement>;
}
type CompareDto = AnalysisDiff & { a: number; b: number };

const VERIF = { DECLARED: 'déclaré, non vérifié', VERIFIED: 'vérifié', TO_VERIFY: 'à vérifier' } as const;

// ---------------- Schéma SVG (sans carte externe) ----------------

const W = 860;
const H = 300;
const NW = 124;
const NH = 56;
function pos(l: LocationDto, i: number) {
  const x = l.x ?? 10 + ((i * 23) % 80);
  const y = l.y ?? 50;
  return { x: 70 + (x / 100) * (W - 140), y: 40 + (y / 100) * (H - 90) };
}
function clip(from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const t = Math.min(dx ? NW / 2 / Math.abs(dx) : Infinity, dy ? NH / 2 / Math.abs(dy) : Infinity);
  return { x: from.x + dx * t, y: from.y + dy * t };
}

interface Edge {
  id: string;
  resultKey: string;
  movementId: string | null;
  from: string;
  to: string;
  status: AnalysisResult['status'];
  label?: string;
  legend: string;
}

function buildEdges(results: AnalysisResult[]): Edge[] {
  const edges: Edge[] = [];
  for (const r of results) {
    if (r.status === 'MOVEMENT_RECORDED' && r.fromLocationId && r.toLocationId) {
      edges.push({ id: r.key, resultKey: r.key, movementId: r.evidence[0]?.recordId ?? null, from: r.fromLocationId, to: r.toLocationId, status: r.status, label: `${r.animalTag} · ${r.when.replace(/\d{2}\/\d{2}\/\d{4} /g, '').replace(/\s/g, '')}`, legend: r.title });
    } else if (r.depth === 1 && r.locationId) {
      for (const o of r.onward ?? []) {
        edges.push({ id: `${r.key}|${o.movementId}`, resultKey: r.key, movementId: o.movementId, from: r.locationId, to: o.toLocationId, status: r.status, legend: `${r.animalTag} — ${STATUS_STYLE[r.status].short.toLowerCase()}` });
      }
    }
  }
  return edges;
}

function Schema({
  locations,
  output,
  selected,
  onSelect,
  signalLocationId,
}: {
  locations: LocationDto[];
  output: AnalysisOutput;
  selected: AnalysisResult | null;
  onSelect: (key: string) => void;
  signalLocationId: string;
}) {
  const P = new Map(locations.map((l, i) => [l.id, pos(l, i)]));
  const edges = buildEdges(output.results);
  const toVerify = new Set(output.results.filter((r) => r.depth === 2 && r.status === 'POTENTIAL_LINK').map((r) => r.toLocationId));
  const nonEval = new Set(output.nonEvaluatedLocationIds);
  const groups = new Map<string, Edge[]>();
  for (const e of edges) {
    const k = [e.from, e.to].sort().join('|');
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const isSel = (e: Edge) =>
    !!selected && (selected.key === e.resultKey || (selected.depth === 2 && selected.evidence.some((ev) => ev.recordId === e.movementId)));
  const anySel = !!selected && edges.some(isSel);
  const markers = Object.entries(STATUS_STYLE).map(([k, s]) => (
    <marker key={k} id={`m-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0L10,5L0,10z" fill={s.stroke} />
    </marker>
  ));
  const legendEdges = edges.filter((e) => e.status !== 'MOVEMENT_RECORDED');

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="schema-title schema-desc" className="mx-auto block h-auto w-full max-w-[1000px]">
        <title id="schema-title">Schéma des lieux et des chemins de l’analyse</title>
        <desc id="schema-desc">Représentation visuelle des résultats. Toutes les informations figurent aussi dans la liste des résultats.</desc>
        <defs>{markers}</defs>
        {edges.map((e) => {
          const a = P.get(e.from);
          const b = P.get(e.to);
          if (!a || !b) return null;
          const group = groups.get([e.from, e.to].sort().join('|'))!;
          const idx = group.indexOf(e);
          const off = (idx - (group.length - 1) / 2) * 30 * (e.from < e.to ? 1 : -1);
          const s = clip(a, b);
          const t = clip(b, a);
          const mx = (s.x + t.x) / 2;
          const my = (s.y + t.y) / 2;
          const len = Math.hypot(t.x - s.x, t.y - s.y) || 1;
          const cx = mx + (-(t.y - s.y) / len) * off * 1.2;
          const cy = my + ((t.x - s.x) / len) * off * 1.2;
          const [tagPart, timePart] = (e.label ?? '').split(' · ');
          const st = STATUS_STYLE[e.status];
          const sel = isSel(e);
          return (
            <g key={e.id} className="edge cursor-pointer" onClick={() => onSelect(e.resultKey)}>
              <path d={`M${s.x},${s.y} Q${cx},${cy} ${t.x},${t.y}`} fill="none" stroke="transparent" strokeWidth={16} />
              <path
                d={`M${s.x},${s.y} Q${cx},${cy} ${t.x},${t.y}`}
                fill="none"
                stroke={st.stroke}
                strokeWidth={sel ? 5 : e.status === 'MOVEMENT_RECORDED' ? 3 : 2.5}
                opacity={anySel && !sel ? 0.35 : 1}
                strokeDasharray={st.dash}
                strokeLinecap="round"
                markerEnd={`url(#m-${e.status})`}
              />
              {e.label && (
                <>
                  <text x={mx} y={my - 9} textAnchor="middle" fontSize="12" fontWeight="600" fill={st.stroke}>
                    {tagPart}
                  </text>
                  <text x={mx} y={my + 17} textAnchor="middle" fontSize="11" fill="#52606D">
                    {timePart}
                  </text>
                </>
              )}
            </g>
          );
        })}
        {locations.map((l) => {
          const p = P.get(l.id)!;
          const isSignal = l.id === signalLocationId;
          const ne = nonEval.has(l.id);
          const tv = toVerify.has(l.id);
          const sub = isSignal ? 'signalement' : ne ? 'non évalué' : tv ? 'à vérifier' : l.kind === 'MARKET' ? 'marché' : '';
          return (
            <g key={l.id}>
              <rect
                x={p.x - NW / 2}
                y={p.y - NH / 2}
                width={NW}
                height={NH}
                rx={10}
                fill={isSignal ? '#E3F0EE' : '#fff'}
                stroke={isSignal ? '#0F5F5C' : tv ? '#1D4F91' : ne ? '#B9B2A4' : '#CFC8BA'}
                strokeWidth={isSignal || tv ? 1.6 : 1}
                strokeDasharray={ne ? '4 3' : undefined}
              />
              <text x={p.x} y={p.y - 3} textAnchor="middle" fontSize="13.5" fontWeight="600" fill={ne ? '#52606D' : '#1F2933'}>
                {l.name}
              </text>
              <text x={p.x} y={p.y + 15} textAnchor="middle" fontSize="11" fill={isSignal ? '#0F5F5C' : tv ? '#1D4F91' : '#6B7682'}>
                {sub}
              </text>
            </g>
          );
        })}
      </svg>
      {legendEdges.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3 text-sm">
          <span className="text-ink-2">Chemins depuis les lieux partagés :</span>
          {legendEdges.map((e) => (
            <button key={e.id} className={`status ${STATUS_STYLE[e.status].cls} min-h-9 cursor-pointer ${isSel(e) ? 'ring-2 ring-info' : ''}`} onClick={() => onSelect(e.resultKey)}>
              <span className="status-icon" aria-hidden="true">
                {STATUS_STYLE[e.status].icon}
              </span>
              {e.legend} → {locations.find((l) => l.id === e.to)?.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------- Liste des résultats ----------------

const GROUPS: { level: AnalysisResult['level']; title: string }[] = [
  { level: 'A', title: 'Parcours enregistré de l’animal signalé' },
  { level: 'B', title: 'Liens potentiels selon la règle R-B1 (à valider)' },
  { level: 'C', title: 'Ce que les données ne permettent pas de conclure' },
];

function ResultList({ output, selectedKey, onSelect, flashKeys }: { output: AnalysisOutput; selectedKey: string | null; onSelect: (k: string) => void; flashKeys: Set<string> }) {
  return (
    <div>
      {GROUPS.map((g) => {
        const rs = output.results.filter((r) => r.level === g.level);
        return (
          <section key={g.level} aria-label={g.title}>
            <h3 className="border-y border-line bg-surface-2 px-4 py-1.5 text-[11.5px] font-semibold tracking-wide text-muted uppercase">{g.title}</h3>
            {rs.length === 0 ? (
              <p className="hint px-4 py-3">Aucun résultat dans cette catégorie.</p>
            ) : (
              <ul>
                {rs.map((r) => {
                  const sel = r.key === selectedKey;
                  return (
                    <li key={r.key} className="border-b border-line last:border-b-0">
                      <button
                        aria-pressed={sel}
                        data-key={r.key}
                        onClick={() => onSelect(r.key)}
                        className={`grid w-full gap-x-3 gap-y-1 px-4 py-2.5 text-left sm:grid-cols-[minmax(170px,auto)_1fr_auto] ${sel ? 'bg-[#FFF8E8] shadow-[inset_3px_0_0_#D89B2B]' : 'hover:bg-surface-2'} ${flashKeys.has(r.key) ? 'flash' : ''}`}
                      >
                        <span>
                          <StatusBadge status={r.status} />
                        </span>
                        <span className="min-w-0">
                          <span className="font-medium">{r.title}</span>
                          {r.depth === 2 && <span className="hint"> · profondeur 2</span>}
                          <span className="num block text-ink-2">{r.when}</span>
                        </span>
                        <span className="num text-ink-2">{r.evidence.map((e) => e.recordId).join(', ')}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ---------------- Panneau « Pourquoi ce résultat ? » ----------------

function WhyPanel({ result, run }: { result: AnalysisResult | null; run: RunDto }) {
  if (!result)
    return (
      <div className="p-4">
        <p className="hint">Sélectionnez un résultat pour voir les preuves, la règle appliquée et les limites.</p>
      </div>
    );
  return (
    <div className="space-y-3 p-4" aria-live="polite">
      <p>
        <StatusBadge status={result.status} long />
      </p>
      <p className="font-semibold">{result.title}</p>
      <p>{result.explanation}</p>
      {result.calculation && (
        <pre className="num overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 text-xs leading-relaxed whitespace-pre-wrap" aria-label="Calcul">
          {result.calculation.join('\n')}
        </pre>
      )}
      <div>
        <h4 className="text-[11.5px] font-semibold tracking-wide text-muted uppercase">Preuves (état des données lors de cette analyse)</h4>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {result.evidence.map((e) => {
            const rec = run.evidenceRecords[e.recordId];
            return (
              <li key={e.recordId}>
                <span className="num font-semibold">{e.recordId}</span> · révision {e.rev}
                {rec && rec.kind === 'presence' && (
                  <span className="block text-ink-2">
                    présence {rec.animalId} : {formatTemporal(rec.start)} → {formatTemporal(rec.end)} (précision : {precisionLabel(rec.start)}) · {VERIF[rec.verification]} · {rec.source}
                    {rec.revisionNote ? ` · ${rec.revisionNote}` : ''}
                  </span>
                )}
                {rec && rec.kind === 'movement' && (
                  <span className="block text-ink-2">
                    mouvement {rec.animalId} : départ {formatTemporal(rec.departure)}, arrivée {formatTemporal(rec.arrival)} · {VERIF[rec.verification]} · {rec.source}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {result.rulesApplied.length > 0 && (
        <p>
          Règle : <b>{result.rulesApplied.join(', ')}</b> — intervalles [début, fin), durée minimale {run.params.minOverlapMinutes} min <span className="tag-validate">à valider</span>
        </p>
      )}
      {result.limits.length > 0 && (
        <ul className="space-y-1 rounded-r-md border-l-[3px] border-amber-line bg-amber-soft px-3 py-2 text-sm">
          {result.limits.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {result.task && (
        <p className="hint">
          Vérification proposée : {result.task.label} (voir « Informations à vérifier »).
        </p>
      )}
    </div>
  );
}

// ---------------- Comparaison ----------------

function ComparePanel({ cmp, onSelect, onClose }: { cmp: CompareDto; onSelect: (k: string) => void; onClose: () => void }) {
  return (
    <section className="card" aria-labelledby="cmp-h">
      <div className="card-h">
        <h2 id="cmp-h" className="flex-1">
          Ce qui a changé — analyse n° {cmp.a} → n° {cmp.b}
        </h2>
        <button className="btn btn-sm" onClick={onClose}>
          Masquer
        </button>
      </div>
      <div className="space-y-3 p-4">
        <p className="font-semibold">{cmp.summary}</p>
        <div>
          <h3 className="text-[11.5px] font-semibold tracking-wide text-muted uppercase">Cause</h3>
          <ul className="list-disc pl-5">
            {cmp.causes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
        <ul className="space-y-2">
          {cmp.changed.map((c) => (
            <li key={c.after.key}>
              <button className="flex flex-wrap items-center gap-2 text-left" onClick={() => onSelect(c.after.key)}>
                <span className="font-medium">{c.after.title}</span> : <StatusBadge status={c.before.status} /> <span aria-hidden="true">→</span>
                <span className="sr-only">devient</span> <StatusBadge status={c.after.status} />
              </button>
            </li>
          ))}
          {cmp.added.map((r) => (
            <li key={r.key}>
              <button className="flex flex-wrap items-center gap-2 text-left" onClick={() => onSelect(r.key)}>
                <span className="status bg-petrol-soft text-petrol">+ Ajouté</span> <span className="font-medium">{r.title}</span> <StatusBadge status={r.status} />
              </button>
            </li>
          ))}
          {cmp.removed.map((r) => (
            <li key={r.key} className="flex flex-wrap items-center gap-2">
              <span className="status bg-excluded-soft text-excluded">− Retiré</span> <span className="font-medium">{r.title}</span> <StatusBadge status={r.status} />
            </li>
          ))}
        </ul>
        <p className="hint">Chaque analyse reste consultable telle qu’elle a été calculée, à partir de son propre instantané de données.</p>
      </div>
    </section>
  );
}

// ---------------- Paramètres d'analyse ----------------

function ParamsEditor({ params, busy, onRun }: { params: AnalysisOutput['params']; busy: boolean; onRun: (p: { window: { from: string; to: string }; maxDepth: number }) => void }) {
  const [from, setFrom] = useState(params.window.from.slice(0, 10));
  const [to, setTo] = useState(params.window.to.slice(0, 10));
  const [depth, setDepth] = useState(params.maxDepth);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setFrom(params.window.from.slice(0, 10));
    setTo(params.window.to.slice(0, 10));
    setDepth(params.maxDepth);
  }, [params]);
  return (
    <details className="card no-print">
      <summary className="card-h cursor-pointer">Modifier les paramètres et relancer</summary>
      <div className="flex flex-wrap items-end gap-3 p-4">
        <div className="field">
          <label htmlFor="p-from">Début de la fenêtre</label>
          <input id="p-from" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="p-to">Fin de la fenêtre (exclue)</label>
          <input id="p-to" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="p-depth">Profondeur</label>
          <select id="p-depth" className="input" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
            {[1, 2, 3, 4].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => {
            if (!(from && to && from < to)) return setErr('La fin de la fenêtre doit suivre le début.');
            setErr(null);
            onRun({ window: { from: `${from}T00:00:00.000Z`, to: `${to}T00:00:00.000Z` }, maxDepth: depth });
          }}
        >
          Lancer avec ces paramètres
        </button>
        {err && <p className="field-error w-full">{err}</p>}
        <p className="hint w-full">Une nouvelle analyse est créée ; les précédentes restent consultables. La fenêtre est un paramètre de recherche, pas une durée d’incubation.</p>
      </div>
    </details>
  );
}

// ---------------- Historique du dossier ----------------

const ACTION_LABELS: Record<string, string> = {
  INVESTIGATION_OPENED: 'Enquête ouverte',
  ANALYSIS_RUN: 'Analyse calculée',
  TASK_REQUESTED: 'Vérification demandée à un agent',
  RECORD_REVISED: 'Enregistrement corrigé (nouvelle révision)',
  OBSERVATION_RECEIVED: 'Signalement reçu',
  OBSERVATION_CLOSED: 'Signalement classé',
};

function History({ id, version }: { id: string; version: number }) {
  const h = useResource<{ at: string; action: string; entity: string; entityId: string; actor: string | null; detail: Record<string, unknown> }[]>(`/api/investigations/${id}/history`, [version]);
  return (
    <details className="card">
      <summary className="card-h cursor-pointer">Historique du dossier</summary>
      {h.error ? <ErrorView error={h.error} onRetry={h.reload} /> : null}
      {h.data && (
        <ol className="divide-y divide-line">
          {h.data.map((e, i) => (
            <li key={i} className="flex flex-wrap gap-x-4 px-4 py-2 text-sm">
              <span className="num text-ink-2">{formatInstant(Date.parse(e.at))}</span>
              <span className="font-medium">{ACTION_LABELS[e.action] ?? e.action}</span>
              <span className="text-ink-2">
                {e.entity === 'record' ? `${e.entityId}, révision ${String(e.detail.rev ?? '')}` : ''}
                {e.action === 'ANALYSIS_RUN' ? `n° ${String(e.detail.seq ?? '')} · instantané #${String(e.detail.snapshotHash ?? '').slice(0, 8)}` : ''}
              </span>
              <span className="flex-1 text-right text-ink-2">{e.actor ?? 'système'}</span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

// ---------------- Console ----------------

export function InvestigationConsole({ id }: { id: string }) {
  const { session } = useApp();
  const inv = useResource<InvestigationDto>(`/api/investigations/${id}`);
  const [seq, setSeq] = useState<number | null>(null);
  const [run, setRun] = useState<RunDto | null>(null);
  const [runError, setRunError] = useState<unknown>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [cmp, setCmp] = useState<CompareDto | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const whyRef = useRef<HTMLDivElement>(null);

  const latest = inv.data?.runs.at(-1)?.seq ?? null;
  const currentSeq = seq ?? latest;

  useEffect(() => {
    if (!currentSeq) return;
    setRunError(null);
    api<RunDto>(`/api/investigations/${id}/runs/${currentSeq}`, { session })
      .then((r) => {
        setRun(r);
        setSelectedKey((k) => (k && r.output.results.some((x) => x.key === k) ? k : (r.output.results.find((x) => x.status === 'INSUFFICIENT_INFO')?.key ?? r.output.results[0]?.key ?? null)));
      })
      .catch(setRunError);
  }, [id, currentSeq, session]);

  const loadCompare = useCallback(
    async (a: number, b: number) => {
      const c = await api<CompareDto>(`/api/investigations/${id}/compare?a=${a}&b=${b}`, { session });
      setCmp(c);
      return c;
    },
    [id, session],
  );

  const select = (k: string) => {
    setSelectedKey(k);
    if (window.matchMedia('(max-width: 1279px)').matches) whyRef.current?.scrollIntoView({ block: 'nearest' });
  };

  const rerun = async (override?: { window: { from: string; to: string }; maxDepth: number }) => {
    if (!run) return;
    setBusy(true);
    setMsg(null);
    try {
      const params = override ?? { window: run.params.window, maxDepth: run.params.maxDepth };
      const r = await api<{ seq: number }>(`/api/investigations/${id}/runs`, { method: 'POST', session, body: params });
      await inv.reload();
      setSeq(r.seq);
      const c = await loadCompare(r.seq - 1, r.seq);
      const keys = [...c.changed.map((x) => x.after.key), ...c.added.map((x) => x.key)];
      setFlash(new Set(keys));
      if (keys[0]) setSelectedKey(keys[0]);
      setMsg({ tone: 'ok', text: `Analyse n° ${r.seq} calculée sur les données actuelles. ${c.summary}` });
    } catch (e) {
      setMsg({ tone: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const requestTask = async (taskId: string) => {
    try {
      await api(`/api/tasks/${taskId}/request`, { method: 'POST', session });
      await inv.reload();
    } catch (e) {
      setMsg({ tone: 'error', text: errorMessage(e) });
    }
  };

  const selected = useMemo(() => run?.output.results.find((r) => r.key === selectedKey) ?? null, [run, selectedKey]);

  if (inv.error && !inv.data) return <ErrorView error={inv.error} onRetry={inv.reload} />;
  if (!inv.data) return <Loading />;
  const d = inv.data;
  const loc = (lid: string) => d.locations.find((l) => l.id === lid)?.name ?? lid;
  const p = run?.params;

  return (
    <div className="space-y-4">
      <section className="card flex flex-wrap items-center gap-x-6 gap-y-3 p-4" aria-labelledby="inv-h">
        <div className="min-w-0 flex-1">
          <h1 id="inv-h" className="text-lg font-bold">
            Enquête · signalement sur <span className="num">{d.observation.animalId}</span>
          </h1>
          <p className="text-ink-2">
            {loc(d.observation.locationId)} · « {d.observation.note} » · événement <span className="num">{formatTemporal(d.observation.eventTime)}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <span className="pill">Dossier : enquête ouverte</span>
          {run && (
            <span className="pill">
              Données de l’analyse : <span className="num">{formatInstant(Date.parse(run.createdAt))}</span>
            </span>
          )}
        </div>
        <div className="no-print flex flex-wrap gap-2">
          {d.runs.length > 1 && (
            <button className="btn" onClick={() => loadCompare(d.runs.at(-2)!.seq, d.runs.at(-1)!.seq).catch((e) => setMsg({ tone: 'error', text: errorMessage(e) }))}>
              Comparer les analyses
            </button>
          )}
          <button className="btn" onClick={() => window.print()}>
            Imprimer
          </button>
          <button className="btn btn-primary" onClick={() => rerun()} disabled={busy || !run}>
            {busy ? 'Calcul…' : 'Relancer l’analyse'}
          </button>
        </div>
      </section>

      <div aria-live="polite">{msg && <Banner tone={msg.tone}>{msg.text}</Banner>}</div>

      {d.runs.length > 1 && (
        <nav aria-label="Versions d’analyse" className="no-print flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink-2">Versions :</span>
          {d.runs.map((r) => (
            <button key={r.seq} className={`btn btn-sm ${r.seq === currentSeq ? 'btn-primary' : ''}`} aria-pressed={r.seq === currentSeq} onClick={() => setSeq(r.seq)}>
              Analyse n° {r.seq} · <span className="num">{formatInstant(Date.parse(r.createdAt)).slice(11)}</span>
            </button>
          ))}
        </nav>
      )}

      {run && <ParamsEditor params={run.params} busy={busy} onRun={(p) => rerun(p)} />}

      {cmp && <ComparePanel cmp={cmp} onSelect={(k) => (setSeq(cmp.b), select(k))} onClose={() => setCmp(null)} />}

      {runError ? <ErrorView error={runError} /> : null}
      {!run && !runError ? <Loading label="Chargement de l’analyse…" /> : null}

      {run && p && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className="min-w-0 space-y-4">
            <section className="card" aria-labelledby="schema-h">
              <h2 id="schema-h" className="card-h flex-wrap">
                Parcours et liens
                <span className="text-xs font-normal text-muted">
                  — analyse n° {run.seq} · moteur v{run.engineVersion} · instantané <span className="num">#{run.snapshotHash.slice(0, 8)}</span>
                </span>
              </h2>
              <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-line px-4 py-2 text-[12.5px] text-ink-2">
                <span>
                  Fenêtre : <b className="num text-ink">{formatInstant(Date.parse(p.window.from)).slice(0, 10)} → {formatInstant(Date.parse(p.window.to)).slice(0, 10)}</b> (fin exclue, choisie par l’enquêteur)
                </span>
                <span>
                  Règle : <b className="text-ink">R-B1 chevauchement de présence</b> <span className="tag-validate">règle de démonstration à valider</span>
                </span>
                <span>
                  Profondeur max : <b className="num text-ink">{p.maxDepth}</b>
                </span>
              </div>
              <div className="hidden sm:block">
                <Schema locations={d.locations} output={run.output} selected={selected} onSelect={select} signalLocationId={d.observation.locationId} />
              </div>
              <p className="hint px-4 py-3 sm:hidden">Schéma affiché sur grand écran. La liste ci-dessous contient les mêmes informations.</p>
              <div className="flex flex-wrap gap-2 border-t border-line px-4 py-2" aria-label="Légende des statuts">
                {(Object.keys(STATUS_LABELS) as AnalysisResult['status'][]).map((s) => (
                  <StatusBadge key={s} status={s} />
                ))}
              </div>
            </section>

            <section className="card" aria-labelledby="res-h">
              <h2 id="res-h" className="card-h">
                Résultats <span className="text-xs font-normal text-muted">— vue liste, équivalente au schéma</span>
              </h2>
              <ResultList output={run.output} selectedKey={selectedKey} onSelect={select} flashKeys={flash} />
              {run.output.truncated && <p className="field-error px-4 py-2">Liste tronquée au plafond de résultats.</p>}
              <div className="space-y-1 border-t border-line px-4 py-3 text-[12.5px] text-ink-2">
                {run.output.nonEvaluatedLocationIds.map((lid) => (
                  <p key={lid}>
                    <b>{loc(lid)}</b> : aucun mouvement enregistré ne le relie à cette recherche. La proximité géographique n’est pas évaluée : ni lien, ni exclusion.
                  </p>
                ))}
                {run.output.limits.map((l) => (
                  <p key={l}>{l}</p>
                ))}
              </div>
            </section>
          </div>

          <aside className="space-y-4">
            <section className="card xl:sticky xl:top-4" aria-labelledby="why-h" ref={whyRef}>
              <h2 id="why-h" className="card-h">
                Pourquoi ce résultat ?
              </h2>
              <WhyPanel result={selected} run={run} />
            </section>
            <section className="card" aria-labelledby="tasks-h">
              <h2 id="tasks-h" className="card-h flex-wrap">
                Informations à vérifier <span className="text-xs font-normal text-muted">— priorité administrative, pas clinique</span>
              </h2>
              {d.tasks.length === 0 ? (
                <p className="hint p-4">Aucune vérification proposée.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {d.tasks.map((t) => (
                    <li key={t.id} className="flex items-start gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{t.label}</p>
                        <p className="hint">
                          {TASK_STATUS_LABELS[t.status]}
                          {t.doneRev ? ` — révision ${t.doneRev} disponible : relancez l’analyse` : ''}
                        </p>
                      </div>
                      {t.status === 'OPEN' && (
                        <button className="btn btn-sm" onClick={() => requestTask(t.id)}>
                          Demander à un agent
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      )}
      <History id={id} version={d.runs.length + d.tasks.filter((t) => t.status !== 'OPEN').length} />
      <p className="text-xs text-muted">
        Les résultats sont des pistes de vérification calculées à partir des données enregistrées. Ils ne constituent ni un diagnostic, ni une preuve de contact, ni une preuve de transmission. « Exclu par cette recherche » ne signifie pas « sans risque sanitaire ».
      </p>
    </div>
  );
}
