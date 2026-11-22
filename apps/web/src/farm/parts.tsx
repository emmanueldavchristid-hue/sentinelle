import { useEffect, useRef, useState } from 'react';
import { formatInstant, formatTemporal, type TemporalValue } from '@sentinelle/domain';
import {
  CHANGE_LABELS,
  INFO_NATURE_LABELS,
  type DraftFieldStatus,
  type FarmEvent,
  type FindAnimalData,
  type InfoNature,
  type MissingData,
  type ObservationDraftData,
  type SiteSummary,
  type SourceData,
  type Statement,
  type TemporalValueDto,
  type ToolResult,
} from '@sentinelle/contracts';
import { api, errorMessage, NetworkError } from '../api';
import { go, useApp } from '../state';
import { TemporalFields, toTemporal, type TemporalDraft } from '../components/ui';

// ---------- Formats ----------

const stateFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Abidjan', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
/** Instant d'un état des données, à la seconde (deux lectures proches doivent rester distinguables). */
export const fmtState = (iso: string) => stateFmt.format(new Date(iso)).replace(',', '');
export const fmtInstant = (iso: string) => formatInstant(Date.parse(iso));

/** Date d'événement courte, sans jamais supposer d'heure. */
export function shortTemporal(v: TemporalValueDto | null): { main: string; sub: string | null } {
  if (!v || v.precision === 'UNKNOWN') return { main: 'Date inconnue', sub: null };
  if (v.precision === 'INSTANT') {
    const s = fmtInstant(v.at);
    return { main: s.slice(0, 5), sub: s.slice(11) };
  }
  if (v.precision === 'DAY') return { main: `${v.date.slice(8, 10)}/${v.date.slice(5, 7)}`, sub: 'heure inconnue' };
  return { main: fmtInstant(v.from).slice(0, 5), sub: 'intervalle' };
}

/** Libellé court d'une référence de source ; la référence complète reste en infobulle. */
export function refShort(ref: string): string {
  const [kind, rest = ''] = ref.split(/:(.*)/s);
  if (kind === 'OBS') return `Observation …${rest.slice(-6)}`;
  if (kind === 'REC') return rest.replace('@', ' rév. ');
  if (kind === 'TASK') return `Tâche …${rest.slice(-6)}`;
  if (kind === 'ANIMAL') return rest;
  if (kind === 'SITE') return `Site ${rest}`;
  if (kind === 'DEVICE') return `Balise ${rest}`;
  if (kind === 'INCIDENT') return `Incident ${rest}`;
  return ref;
}

// ---------- Natures d'information : libellé + signe + style de filet, jamais la couleur seule ----------

const NATURE: Record<InfoNature, { glyph: string; cls: string }> = {
  FACT: { glyph: '■', cls: 'text-paturage' },
  COMPUTED: { glyph: '∑', cls: 'text-info' },
  DOCUMENT: { glyph: '¶', cls: 'text-excluded' },
  MISSING: { glyph: '∅', cls: 'text-amber' },
  SUGGESTION: { glyph: '→', cls: 'text-encre-2' },
};

export function NatureLabel({ nature }: { nature: InfoNature }) {
  return (
    <span className={`v-nature ${NATURE[nature].cls}`}>
      <span className="v-nature-glyph" aria-hidden="true">
        {NATURE[nature].glyph}
      </span>
      {INFO_NATURE_LABELS[nature]}
    </span>
  );
}

export function SourceChip({ sourceRef, onSource }: { sourceRef: string; onSource: (ref: string) => void }) {
  return (
    <button type="button" className="v-src" title={`Ouvrir la source ${sourceRef}`} onClick={() => onSource(sourceRef)}>
      {refShort(sourceRef)}
    </button>
  );
}

export function StatementList({ statements, onSource, max = 7 }: { statements: Statement[]; onSource: (ref: string) => void; max?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? statements : statements.slice(0, max);
  return (
    <div className="space-y-1.5">
      {shown.map((s, i) => (
        <div key={i} className="v-statement" data-nature={s.nature}>
          <NatureLabel nature={s.nature} />
          <p className="max-w-[64ch] text-[15.5px] leading-[1.45]">{typo(s.text)}</p>
          {s.sources.length > 0 && (
            <div>
              {s.sources.slice(0, 6).map((r) => (
                <SourceChip key={r} sourceRef={r} onSource={onSource} />
              ))}
              {s.sources.length > 6 && <span className="v-meta">et {s.sources.length - 6} autres</span>}
            </div>
          )}
        </div>
      ))}
      {statements.length > max && !all && (
        <button type="button" className="v-chip" onClick={() => setAll(true)}>
          Afficher les {statements.length - max} autres lignes
        </button>
      )}
    </div>
  );
}

/** Une lecture de données : phrases étiquetées, sources, limites, état. */
export function ResultView({ result, onSource }: { result: ToolResult; onSource: (ref: string) => void }) {
  const matches = result.tool === 'find_animal' ? (result as ToolResult<FindAnimalData>).data.matches : [];
  const missingAnimals = result.tool === 'missing' ? [...new Set((result as ToolResult<MissingData>).data.items.map((i) => i.animalId).filter((x): x is string => !!x))].slice(0, 8) : [];
  return (
    <div className="space-y-2.5">
      <StatementList statements={result.statements} onSource={onSource} />
      {matches.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {matches.map((m) => (
            <button key={m.id} type="button" className="v-chip" onClick={() => go(`elevage/animal/${encodeURIComponent(m.id)}`)}>
              Ouvrir {m.tag}
            </button>
          ))}
        </div>
      )}
      {missingAnimals.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="v-meta">Voir un animal concerné :</span>
          {missingAnimals.map((id) => (
            <button key={id} type="button" className="v-chip num" onClick={() => go(`elevage/animal/${encodeURIComponent(id)}`)}>
              {id}
            </button>
          ))}
        </div>
      )}
      <details className="v-meta">
        <summary className="cursor-pointer">
          Limites de cette lecture ({result.limits.length}) · état des données : <span className="num">{fmtState(result.asOf)}</span>
        </summary>
        <ul className="mt-1.5 list-disc space-y-1 pl-5">
          {result.limits.map((l) => (
            <li key={l}>{l}</li>
          ))}
          {result.period && (
            <li>
              Période couverte : du <span className="num">{fmtInstant(result.period.from)}</span> au <span className="num">{fmtState(result.period.to)}</span> (réception par le serveur).
            </li>
          )}
        </ul>
      </details>
    </div>
  );
}

// ---------- Chronologie ----------

const EVENT_GLYPH: Record<FarmEvent['type'], string> = { OBSERVATION: '■', PRESENCE: '●', MOVEMENT: '→', CORRECTION: '✎', TASK_CREATED: '☐', TASK_REQUESTED: '☐', TASK_DONE: '☑' };

export function Timeline({ events, highlight, fresh, onSource, empty, simple = false }: { events: FarmEvent[]; highlight: ReadonlySet<string>; fresh: ReadonlySet<string>; onSource: (ref: string) => void; empty: string; simple?: boolean }) {
  if (events.length === 0) {
    return (
      <div className="border border-dashed border-filet px-5 py-8">
        <p className="v-display text-[21px]">{empty}</p>
        {!simple && <p className="v-meta mt-1.5 max-w-[52ch]">Sans saisie, rien n’est observé : une chronologie vide ne dit rien de l’état des animaux.</p>}
      </div>
    );
  }
  return (
    <ol className="v-timeline">
      {events.map((e) => {
        const d = shortTemporal(e.eventTime);
        const isFresh = fresh.has(e.ref);
        const base = e.ref.replace(/#.*$/, '');
        return (
          <li key={e.ref} className={`v-event ${isFresh ? 'v-appear' : ''}`} data-highlight={isFresh || highlight.has(base) ? 'true' : undefined}>
            <div className="v-event-date">
              <span className="sr-only">Date de l’événement : </span>
              {e.eventTime ? d.main : <span className="text-[15px] font-normal text-encre-2">sans date d’événement</span>}
              {e.eventTime && d.sub && <span className="num block text-[13.5px] font-normal text-encre-2">{d.sub}</span>}
            </div>
            <div className="v-event-glyph" aria-hidden="true">
              {EVENT_GLYPH[e.type]}
            </div>
            <div className="min-w-0">
              <p className="font-semibold leading-snug">{e.title}</p>
              {e.detail && <p className="max-w-[62ch] leading-snug">{e.detail}</p>}
              {simple && (
                <p className="mt-1 flex flex-wrap items-center gap-x-3">
                  {isFresh && <span className="v-field-flag text-laterite">nouveau</span>}
                  <button type="button" className="text-[14px] text-encre-2 underline underline-offset-4" onClick={() => onSource(base)}>
                    Voir le détail
                  </button>
                </p>
              )}
              <p className="v-meta mt-1" hidden={simple}>
                {e.deviceRecordedAt && (
                  <>
                    Saisie sur l’appareil : <span className="num">{fmtInstant(e.deviceRecordedAt)}</span> ·{' '}
                  </>
                )}
                Reçu par le serveur : <span className="num">{fmtInstant(e.recordedAt)}</span>
                {e.author ? ` · ${e.author}` : ''}
              </p>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2" hidden={simple}>
                <span className="v-field-flag text-encre-2">{CHANGE_LABELS[e.change]}</span>
                {isFresh && <span className="v-field-flag text-laterite">· nouveau, confirmé pendant cette session</span>}
                <SourceChip sourceRef={base} onSource={onSource} />
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- Affichage simple : la réponse en phrases courtes, les preuves à un clic ----------

/** Retire d'une phrase les précisions techniques entre parenthèses (dates de réception, révisions, précision, source). */
/** Typographie française à l'affichage : espaces insécables dans les guillemets et avant « : ; ? ! ». Le texte n'est pas modifié. */
export const typo = (text: string): string => text.replace(/« /g, '«\u00a0').replace(/ »/g, '\u00a0»').replace(/ ([:;?!])/g, '\u00a0$1');

export function plainSentence(text: string): string {
  const plain = text
    .replace(/\s*\((?:[^()]*(?:reçu|révision|précision|source :|\d{2}\/\d{2}\/\d{4})[^()]*)\)/g, '')
    // Après le retrait d'une parenthèse : pas d'espace avant un point ou une virgule, pas de point doublé.
    // L'espace avant « : » et « ; » est voulue en français : elle est conservée.
    .replace(/\s+([.,])/g, '$1')
    .replace(/\.{2,}/g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return typo(plain);
}

/** Réponse en mode simple : quelques phrases lisibles, sans libellés ni identifiants. Rien n'est ajouté au texte du serveur. */
export function PlainAnswer({ result, max = 5 }: { result: ToolResult; max?: number }) {
  const lines = result.statements.slice(0, max).map((st) => plainSentence(st.text)).filter(Boolean);
  return (
    <div className="space-y-2">
      {lines.map((l, i) => (
        <p key={i} className={`max-w-[60ch] leading-[1.45] ${i === 0 ? 'text-[19px] font-semibold' : 'text-[17px]'}`}>
          {l}
        </p>
      ))}
      {result.statements.length > max && <p className="v-meta">Et {result.statements.length - max} autres lignes dans les détails.</p>}
    </div>
  );
}

const CheckIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 12.5l5 5L20 6.5" />
  </svg>
);
const CrossIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

/**
 * Brouillon en mode simple : ce qui va être enregistré, en clair, et deux gros boutons à icône.
 * « Modifier » ouvre le formulaire complet. Si un champ manque, le formulaire est ouvert d'office.
 */
export function SimpleDraft({ draft, sites, busy, onConfirm, onDiscard, onEdit }: { draft: ObservationDraftData; sites: SiteSummary[]; busy: boolean; onConfirm: (v: DraftValues) => void; onDiscard: () => void; onEdit: () => void }) {
  const site = sites.find((x) => x.id === draft.site.value)?.name ?? draft.site.value ?? '';
  const values: DraftValues | null = draft.ready && draft.animal.value && draft.site.value && draft.eventTime.value && draft.note.value ? { animalId: draft.animal.value, locationId: draft.site.value, eventTime: draft.eventTime.value, note: draft.note.value } : null;
  if (!values) return null;
  return (
    <div className="v-draft space-y-3" role="group" aria-label="Observation à confirmer">
      <p className="v-kicker">À confirmer · rien n’est encore enregistré</p>
      <p className="v-display text-[24px] leading-[1.2]">« {values.note} »</p>
      <p className="text-[17px]">
        <b className="num">{values.animalId}</b> · {site} · {formatTemporal(values.eventTime as TemporalValue)}
      </p>
      {draft.possibleDuplicate && <p className="border-l-[3px] border-amber-line pl-3 text-amber">Une observation identique a déjà été enregistrée aujourd’hui.</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" className="v-big-ok" disabled={busy} onClick={() => onConfirm(values)}>
          <CheckIcon />
          {busy ? 'Enregistrement…' : 'Confirmer'}
        </button>
        <button type="button" className="v-big-no" disabled={busy} onClick={onDiscard}>
          <CrossIcon />
          Annuler
        </button>
      </div>
      <p className="v-meta">
        Vous pouvez aussi dire ou écrire « je confirme ».{' '}
        <button type="button" className="underline underline-offset-4" onClick={onEdit}>
          Modifier
        </button>
      </p>
    </div>
  );
}

// ---------- Preuve : l'enregistrement exact derrière une source ----------

export function EvidenceDialog({ sourceRef, onClose }: { sourceRef: string | null; onClose: () => void }) {
  const { session } = useApp();
  const ref = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<{ data: ToolResult<SourceData> | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: false });
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (sourceRef && !d.open) d.showModal();
    if (!sourceRef && d.open) d.close();
  }, [sourceRef]);
  useEffect(() => {
    if (!sourceRef) return;
    let alive = true;
    setState({ data: null, error: null, loading: true });
    api<ToolResult<SourceData>>(`/api/farm/sources?ref=${encodeURIComponent(sourceRef)}`, { session })
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((error) => alive && setState({ data: null, error, loading: false }));
    return () => {
      alive = false;
    };
  }, [sourceRef, session]);
  const d = state.data?.data;
  const animalId = d?.fields.find((f) => f.label === 'Animal' || f.label === 'Identifiant')?.value;
  return (
    <dialog ref={ref} className="v-dialog" aria-labelledby="ev-h" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="max-h-[calc(100vh-48px)] overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="v-kicker">Source · enregistrement exact</p>
            <h2 id="ev-h" className="v-display mt-1 text-[24px]">
              {d ? d.title : state.loading ? 'Lecture de la source…' : 'Source'}
            </h2>
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Fermer
          </button>
        </div>
        {sourceRef && <p className="num mt-1 text-[13px] break-all text-encre-2">{d?.ref ?? sourceRef}</p>}
        {state.loading && <div className="v-skeleton mt-4 h-40" role="status" aria-label="Chargement de la source" />}
        {state.error !== null && (
          <p role="alert" className="mt-4 border-l-[3px] border-danger pl-3">
            {state.error instanceof NetworkError ? 'Serveur injoignable : la source ne peut pas être lue pour l’instant. ' : ''}
            {errorMessage(state.error)}
          </p>
        )}
        {d && (
          <>
            <dl className="mt-4 border-t border-filet">
              {d.fields.map((f) => (
                <div key={f.label} className="grid grid-cols-[minmax(0,11rem)_1fr] gap-3 border-b border-filet py-2">
                  <dt className="v-meta">{f.label}</dt>
                  <dd className="font-medium">{f.value}</dd>
                </div>
              ))}
            </dl>
            {d.revisions.length > 0 && (
              <div className="mt-4">
                <h3 className="v-kicker">Révisions conservées ({d.revisions.length})</h3>
                <ol className="mt-1.5 space-y-2">
                  {d.revisions.map((r) => (
                    <li key={r.rev} className="border-l-[3px] border-filet pl-3">
                      <p className="font-medium">
                        Révision {r.rev} : {r.summary}
                      </p>
                      <p className="v-meta">
                        Reçue le <span className="num">{fmtInstant(r.recordedAt)}</span>
                        {r.author ? ` · ${r.author}` : ''}
                        {r.reason ? ` · ${r.reason}` : ''}
                      </p>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            <p className="v-meta mt-4">{state.data!.limits[0]}</p>
            {animalId && d.kind !== 'site' && (
              <button
                type="button"
                className="btn btn-sm mt-3"
                onClick={() => {
                  onClose();
                  go(`elevage/animal/${encodeURIComponent(animalId)}`);
                }}
              >
                Voir {animalId} dans la constellation
              </button>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}

// ---------- Brouillon d'observation : rien n'est écrit avant la confirmation ----------

const FLAG: Record<DraftFieldStatus, { text: string; cls: string } | null> = {
  OK: null,
  DEDUCED: { text: 'Proposé, à vérifier', cls: 'text-info' },
  TO_CONFIRM: { text: 'À confirmer', cls: 'text-laterite' },
  MISSING: { text: 'À compléter', cls: 'text-danger' },
  AMBIGUOUS: { text: 'À préciser', cls: 'text-danger' },
};

function temporalDraft(v: TemporalValueDto | null): TemporalDraft {
  if (!v) return { precision: 'INSTANT', date: '', time: '' };
  if (v.precision === 'INSTANT') return { precision: 'INSTANT', date: v.at.slice(0, 10), time: v.at.slice(11, 16) };
  if (v.precision === 'DAY') return { precision: 'DAY', date: v.date, time: '' };
  if (v.precision === 'UNKNOWN') return { precision: 'UNKNOWN', date: '', time: '' };
  return { precision: 'INSTANT', date: v.from.slice(0, 10), time: v.from.slice(11, 16) };
}

function FieldFlag({ status, message }: { status: DraftFieldStatus; message: string | null }) {
  const f = FLAG[status];
  if (!f && !message) return null;
  return (
    <p className="mt-1 text-[14px]">
      {f && <span className={`v-field-flag ${f.cls}`}>{f.text}. </span>}
      {message}
    </p>
  );
}

export interface DraftValues {
  animalId: string;
  locationId: string;
  eventTime: TemporalValueDto;
  note: string;
}

export function DraftCard({
  id,
  draft,
  sites,
  busy,
  serverErrors,
  onConfirm,
  onDiscard,
  onSource,
}: {
  id: string;
  draft: ObservationDraftData;
  sites: SiteSummary[];
  busy: boolean;
  /** Messages renvoyés par la validation du serveur au moment de confirmer. */
  serverErrors: Partial<Record<'animal' | 'site' | 'eventTime' | 'note', string>>;
  onConfirm: (v: DraftValues) => void;
  onDiscard: () => void;
  onSource: (ref: string) => void;
}) {
  const [animalId, setAnimalId] = useState(draft.animal.value ?? '');
  const [locationId, setLocationId] = useState(draft.site.value ?? '');
  const [temporal, setTemporal] = useState<TemporalDraft>(() => temporalDraft(draft.eventTime.value));
  const [note, setNote] = useState(draft.note.value ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const touched = { animal: animalId !== (draft.animal.value ?? ''), site: locationId !== (draft.site.value ?? ''), note: note !== (draft.note.value ?? '') };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const t = toTemporal(temporal);
    if (!animalId.trim()) errs.animal = 'Indiquez l’animal concerné';
    if (!locationId) errs.site = 'Choisissez le lieu de l’observation';
    if (t.error) errs.eventTime = t.error;
    if (note.trim().length < 3) errs.note = 'Décrivez ce qui est constaté (3 caractères minimum)';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    onConfirm({ animalId: animalId.trim(), locationId, eventTime: t.value!, note: note.trim() });
  };
  const err = (k: 'animal' | 'site' | 'eventTime' | 'note') => errors[k] ?? serverErrors[k] ?? null;

  return (
    <form className="v-draft space-y-4" onSubmit={submit} noValidate aria-labelledby={`${id}-h`}>
      <div>
        <p className="v-kicker">Brouillon · non enregistré</p>
        <h3 id={`${id}-h`} className="v-display mt-1 text-[22px]">
          Vérifiez, puis confirmez
        </h3>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="field">
          <label htmlFor={`${id}-animal`}>Animal</label>
          {draft.animal.candidates?.length ? (
            <select id={`${id}-animal`} className="input" value={animalId} onChange={(e) => setAnimalId(e.target.value)} aria-invalid={!!err('animal')}>
              <option value="">Choisir</option>
              {draft.animal.candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : (
            <input id={`${id}-animal`} className="input num" value={animalId} onChange={(e) => setAnimalId(e.target.value)} placeholder="ex. B-017" autoComplete="off" aria-invalid={!!err('animal')} />
          )}
          {!touched.animal && <FieldFlag status={draft.animal.status} message={draft.animal.message} />}
          {err('animal') && <p className="field-error">{err('animal')}</p>}
        </div>
        <div className="field">
          <label htmlFor={`${id}-site`}>Lieu de l’observation</label>
          <select id={`${id}-site`} className="input" value={locationId} onChange={(e) => setLocationId(e.target.value)} aria-invalid={!!err('site')}>
            <option value="">Choisir</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {!touched.site && <FieldFlag status={draft.site.status} message={draft.site.message} />}
          {err('site') && <p className="field-error">{err('site')}</p>}
        </div>
      </div>
      <div>
        <TemporalFields id={`${id}-time`} legend="Date de l’événement" value={temporal} onChange={setTemporal} error={err('eventTime')} />
        <FieldFlag status={draft.eventTime.status} message={draft.eventTime.message} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-note`}>Ce qui est constaté</label>
        <textarea id={`${id}-note`} className="input" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} aria-invalid={!!err('note')} aria-describedby={`${id}-note-hint`} />
        <p id={`${id}-note-hint`} className="hint">
          Décrivez ce que vous voyez, sans conclusion diagnostique.
        </p>
        {!touched.note && <FieldFlag status={draft.note.status} message={draft.note.message} />}
        {err('note') && <p className="field-error">{err('note')}</p>}
      </div>
      {draft.possibleDuplicate && (
        <p className="border-l-[3px] border-amber-line pl-3 text-[15px]">
          <span className="v-field-flag text-amber">Doublon possible. </span>
          {draft.possibleDuplicate.label}. <SourceChip sourceRef={draft.possibleDuplicate.ref} onSource={onSource} />
        </p>
      )}
      <p className="v-meta">La date de saisie et la date de réception par le serveur sont enregistrées automatiquement, séparément de la date de l’événement.</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="v-btn-go" disabled={busy}>
          {busy ? 'Enregistrement…' : 'Confirmer et enregistrer'}
        </button>
        <button type="button" className="btn" style={{ minHeight: 56 }} onClick={onDiscard} disabled={busy}>
          Abandonner le brouillon
        </button>
      </div>
    </form>
  );
}

export const describeDraft = (v: DraftValues, sites: SiteSummary[]) =>
  `${v.animalId} · ${sites.find((s) => s.id === v.locationId)?.name ?? v.locationId} · ${formatTemporal(v.eventTime as TemporalValue)} · « ${v.note} »`;
