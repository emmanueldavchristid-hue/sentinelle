import { useState } from 'react';
import { formatTemporal, type TemporalValue } from '@sentinelle/domain';
import { api, ApiFailure, errorMessage } from '../api';
import { useApp } from '../state';
import { Banner } from '../components/ui';

interface PreviewRow {
  line: number;
  status: 'ok' | 'warning' | 'error';
  messages: string[];
  recordId: string;
  kind: 'presence' | 'movement' | null;
  data: Record<string, unknown> | null;
  newAnimal: string | null;
}
interface Preview {
  fileHash: string;
  rows: PreviewRow[];
  counts: { total: number; ok: number; warning: number; error: number };
  canCommit: boolean;
}

const ROW_STYLE = {
  ok: { label: 'Valide', icon: '✓', cls: 'bg-petrol-soft text-petrol' },
  warning: { label: 'À vérifier', icon: '!', cls: 'bg-amber-soft text-amber' },
  error: { label: 'Erreur', icon: '×', cls: 'bg-danger-soft text-danger' },
} as const;

function summary(r: PreviewRow): string {
  const d = r.data;
  if (!d) return '—';
  const t = (v: unknown) => formatTemporal((v ?? null) as TemporalValue | null);
  return d.kind === 'presence'
    ? `${d.animalId} à ${d.locationId} : ${t(d.start)} → ${t(d.end)}`
    : `${d.animalId} : ${d.fromLocationId} → ${d.toLocationId}, départ ${t(d.departure)}, arrivée ${t(d.arrival)}`;
}

export function ImportPage() {
  const { session } = useApp();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [filter, setFilter] = useState<'all' | 'problems'>('all');

  const onFile = async (f: File | undefined) => {
    setPreview(null);
    setDone(null);
    setError(null);
    if (!f) return;
    if (f.size > 256 * 1024) return setError('Fichier trop volumineux (256 Ko maximum).');
    setFileName(f.name);
    const buf = await f.arrayBuffer();
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      // Excel (Windows, français) enregistre souvent les CSV en Windows-1252.
      text = new TextDecoder('windows-1252').decode(buf);
    }
    setCsv(text);
  };

  const doPreview = async () => {
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      const p = await api<Preview>('/api/import/preview', { method: 'POST', session, body: { csv }, timeoutMs: 20000 });
      setPreview(p);
      setKey(crypto.randomUUID());
    } catch (e) {
      setPreview(null);
      setError(e instanceof ApiFailure && e.body.fields ? `${e.message} — ${Object.values(e.body.fields as Record<string, string>).join(' ; ')}` : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ imported: number; animalsCreated: string[]; duplicate: boolean }>('/api/import/commit', { method: 'POST', session, body: { csv, idempotencyKey: key, fileHash: preview.fileHash }, timeoutMs: 20000 });
      setDone(`${r.imported} enregistrement(s) importé(s) en révision 1${r.animalsCreated.length ? ` ; animaux créés : ${r.animalsCreated.join(', ')}` : ''}.${r.duplicate ? ' (import déjà effectué : aucun doublon créé)' : ''} Relancez les analyses concernées pour en tenir compte.`);
      setPreview(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const rows = preview?.rows.filter((r) => filter === 'all' || r.status !== 'ok') ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <section className="card space-y-3 p-4" aria-labelledby="imp-h">
        <h1 id="imp-h" className="text-xl font-bold">
          Import de présences et de mouvements (CSV)
        </h1>
        <p className="hint">
          Chaque ligne est vérifiée avant import. L’import est « tout ou rien » : s’il reste une erreur, rien n’est enregistré. Un enregistrement existant ne peut pas être remplacé par import : il se corrige par une nouvelle révision.
        </p>
        <details className="rounded-lg bg-surface-2 p-3 text-sm">
          <summary className="cursor-pointer font-semibold">Format attendu</summary>
          <p className="mt-2">
            Colonnes : <code className="num">type;id;animal;lieu;lieu_arrivee;debut;fin;source</code> (séparateur « ; » ou « , »).
          </p>
          <ul className="mt-1 list-disc pl-5">
            <li>
              <code className="num">type</code> : presence ou mouvement ; <code className="num">lieu_arrivee</code> seulement pour un mouvement.
            </li>
            <li>
              Dates (heure d’Abidjan) : <code className="num">2026-03-01T08:00</code> (date et heure), <code className="num">2026-03-01</code> (jour seulement, aucune heure supposée),{' '}
              <code className="num">2026-03-01T08:00/2026-03-01T10:00</code> (intervalle), vide = inconnue, <code className="num">en cours</code> = présence non terminée.
            </li>
            <li>Un animal inconnu est créé (avertissement) ; un lieu inconnu est une erreur.</li>
          </ul>
          <a className="btn btn-sm mt-3" href="/api/import/template.csv" download>
            Télécharger le modèle
          </a>
        </details>
        <div className="flex flex-wrap items-end gap-3">
          <div className="field">
            <label htmlFor="imp-file">Fichier CSV</label>
            <input id="imp-file" type="file" accept=".csv,text/csv" className="input py-2" onChange={(e) => onFile(e.target.files?.[0])} />
          </div>
          <button className="btn btn-primary" onClick={doPreview} disabled={!csv || busy}>
            {busy && !preview ? 'Vérification…' : 'Prévisualiser'}
          </button>
        </div>
        <div className="field">
          <label htmlFor="imp-text">Ou coller le contenu {fileName ? `(chargé : ${fileName})` : ''}</label>
          <textarea
            id="imp-text"
            className="input num min-h-28 text-xs"
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              setPreview(null);
              setDone(null);
            }}
            spellCheck={false}
          />
        </div>
        <div aria-live="polite">
          {error && <Banner tone="error">{error}</Banner>}
          {done && <Banner tone="ok">{done}</Banner>}
        </div>
      </section>

      {preview && (
        <section className="card" aria-labelledby="prev-h">
          <div className="card-h flex-wrap">
            <h2 id="prev-h" className="flex-1">
              Prévisualisation — {preview.counts.total} ligne(s)
            </h2>
            <span className="status bg-petrol-soft text-petrol">✓ {preview.counts.ok} valides</span>
            <span className="status bg-amber-soft text-amber">! {preview.counts.warning} à vérifier</span>
            <span className="status bg-danger-soft text-danger">× {preview.counts.error} en erreur</span>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={filter === 'problems'} onChange={(e) => setFilter(e.target.checked ? 'problems' : 'all')} />
              Afficher seulement les lignes à vérifier ou en erreur
            </label>
            <span className="flex-1" />
            {preview.canCommit ? (
              <button className="btn btn-primary" onClick={commit} disabled={busy}>
                {busy ? 'Import…' : `Importer ${preview.counts.total} enregistrement(s)`}
              </button>
            ) : (
              <span className="field-error">Corrigez les erreurs dans le fichier puis prévisualisez à nouveau.</span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-2 text-left text-xs text-ink-2">
                  <th scope="col" className="px-3 py-2">
                    Ligne
                  </th>
                  <th scope="col" className="px-3 py-2">
                    État
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Identifiant
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Contenu interprété
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Messages
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.line} className="border-t border-line align-top">
                    <td className="num px-3 py-2">{r.line}</td>
                    <td className="px-3 py-2">
                      <span className={`status ${ROW_STYLE[r.status].cls}`}>
                        <span className="status-icon" aria-hidden="true">
                          {ROW_STYLE[r.status].icon}
                        </span>
                        {ROW_STYLE[r.status].label}
                      </span>
                    </td>
                    <td className="num px-3 py-2">{r.recordId || '—'}</td>
                    <td className="px-3 py-2">{summary(r)}</td>
                    <td className="px-3 py-2">
                      {r.messages.length ? (
                        <ul className="list-disc pl-4">
                          {r.messages.map((m) => (
                            <li key={m}>{m}</li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-4 text-center text-ink-2">
                      Aucune ligne à afficher avec ce filtre.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
