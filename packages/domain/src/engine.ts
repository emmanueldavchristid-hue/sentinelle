import {
  type PresenceBounds,
  type TemporalValue,
  bounds,
  clipToWindow,
  evaluateOverlap,
  formatDay,
  formatInstant,
  POS_INF,
  presenceBounds,
} from './temporal.js';

export const ENGINE_VERSION = '0.1.0';
export const RULE_RB1 = 'R-B1';

export type VerificationStatus = 'DECLARED' | 'VERIFIED' | 'TO_VERIFY';

export interface Location {
  id: string;
  code: string;
  name: string;
  kind: 'FARM' | 'MARKET';
  /** Coordonnées fictives, pour l'affichage uniquement. Le moteur ne les utilise pas. */
  position?: { x: number; y: number };
}
export interface Animal {
  id: string;
  tag: string;
}
interface RecordBase {
  id: string;
  rev: number;
  verification: VerificationStatus;
  source: string;
  revisionNote?: string;
}
export interface Presence extends RecordBase {
  kind: 'presence';
  animalId: string;
  locationId: string;
  start: TemporalValue;
  /** null = toujours présent (fin ouverte). */
  end: TemporalValue | null;
}
export interface Movement extends RecordBase {
  kind: 'movement';
  animalId: string;
  fromLocationId: string;
  toLocationId: string;
  departure: TemporalValue;
  arrival: TemporalValue;
}
export interface DataSnapshot {
  animals: Animal[];
  locations: Location[];
  presences: Presence[];
  movements: Movement[];
}

export interface AnalysisParams {
  subjectAnimalId: string;
  window: { from: string; to: string };
  rules: [typeof RULE_RB1];
  maxDepth: number;
  maxResults: number;
  minOverlapMinutes: number;
}

export type ResultStatus = 'MOVEMENT_RECORDED' | 'POTENTIAL_LINK' | 'INSUFFICIENT_INFO' | 'PATH_EXCLUDED' | 'DATA_ANOMALY';

export const STATUS_LABELS: Record<ResultStatus, string> = {
  MOVEMENT_RECORDED: 'Mouvement enregistré',
  POTENTIAL_LINK: 'Lien potentiel selon les paramètres',
  INSUFFICIENT_INFO: 'Information insuffisante',
  PATH_EXCLUDED: 'Chemin exclu par cette recherche',
  DATA_ANOMALY: 'Anomalie de données',
};

export interface Evidence {
  recordId: string;
  kind: 'presence' | 'movement';
  rev: number;
}

export interface SuggestedTask {
  kind: 'COMPLETE_PRESENCE' | 'CHECK_RECORD';
  recordId: string;
  label: string;
}

export interface AnalysisResult {
  /** Identité stable, indépendante du statut : sert à comparer deux analyses. */
  key: string;
  status: ResultStatus;
  level: 'A' | 'B' | 'C';
  depth: number;
  animalId: string;
  animalTag: string;
  locationId: string | null;
  fromLocationId?: string;
  toLocationId?: string;
  /** Pour la profondeur 2 : animal par lequel le lieu est atteint. */
  viaAnimalId?: string;
  /** Pour la profondeur 2 : lieu de la présence chevauchante d'origine. */
  originLocationId?: string;
  title: string;
  when: string;
  overlap?: { from: string; to: string };
  evidence: Evidence[];
  rulesApplied: string[];
  explanation: string;
  calculation?: string[];
  limits: string[];
  /** Mouvements suivants de l'animal, non explorés par ce chemin (affichage). */
  onward?: { movementId: string; toLocationId: string }[];
  task?: SuggestedTask;
  sortTime: number;
}

export interface AnalysisOutput {
  engineVersion: string;
  params: AnalysisParams;
  results: AnalysisResult[];
  limits: string[];
  truncated: boolean;
  nonEvaluatedLocationIds: string[];
}

const STATUS_ORDER: Record<ResultStatus, number> = {
  MOVEMENT_RECORDED: 0,
  POTENTIAL_LINK: 1,
  INSUFFICIENT_INFO: 2,
  PATH_EXCLUDED: 3,
  DATA_ANOMALY: 4,
};
const LEVEL: Record<ResultStatus, 'A' | 'B' | 'C'> = {
  MOVEMENT_RECORDED: 'A',
  POTENTIAL_LINK: 'B',
  INSUFFICIENT_INFO: 'C',
  PATH_EXCLUDED: 'C',
  DATA_ANOMALY: 'C',
};

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function fmtBound(min: number, max: number): string {
  if (!Number.isFinite(min) && !Number.isFinite(max)) return 'inconnu';
  if (min === max) return formatInstant(min);
  if (Number.isFinite(min) && max - min === 86_400_000) return `${formatDay(min)} (heure inconnue)`;
  return `entre ${formatInstant(min)} et ${formatInstant(max)}`;
}

function describeBounds(b: PresenceBounds): string {
  const s = fmtBound(b.startMin, b.startMax);
  const e = b.endMax === POS_INF && b.endMin === POS_INF ? 'en cours' : fmtBound(b.endMin, b.endMax);
  return `début ${s} ; fin ${e}`;
}

function isPrecise(v: TemporalValue | null): boolean {
  return v === null || v.precision === 'INSTANT';
}

/** Sérialisation stable (clés triées) : base de l'empreinte de l'instantané. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

interface Tracked {
  animalId: string;
  presence: Presence;
  bounds: PresenceBounds;
  depth: number;
}

/**
 * Moteur de traçabilité — pur et déterministe, sans I/O ni LLM.
 * Mêmes données + mêmes paramètres → mêmes résultats (ordre compris).
 */
export function analyze(snapshot: DataSnapshot, params: AnalysisParams): AnalysisOutput {
  const wFrom = Date.parse(params.window.from);
  const wTo = Date.parse(params.window.to);
  if (!(wFrom < wTo)) throw new Error('Fenêtre d’enquête invalide');
  if (params.maxDepth < 0 || params.maxResults < 1) throw new Error('Paramètres invalides');

  const animals = new Map(snapshot.animals.map((a) => [a.id, a]));
  const locations = new Map(snapshot.locations.map((l) => [l.id, l]));
  const subject = animals.get(params.subjectAnimalId);
  if (!subject) throw new Error(`Animal inconnu : ${params.subjectAnimalId}`);

  const tag = (id: string) => animals.get(id)?.tag ?? id;
  const locName = (id: string) => locations.get(id)?.name ?? id;
  const minOverlapMs = params.minOverlapMinutes * 60_000;

  const presences = [...snapshot.presences].sort((a, b) => cmpStr(a.id, b.id));
  const movements = [...snapshot.movements].sort((a, b) => cmpStr(a.id, b.id));

  const results = new Map<string, AnalysisResult>();
  const limits = new Set<string>();
  const add = (r: Omit<AnalysisResult, 'level'>) => {
    if (!results.has(r.key)) results.set(r.key, { ...r, level: LEVEL[r.status] });
  };

  // ---------- 1. Anomalies de données ----------
  const anomalies = new Map<string, { record: Presence | Movement; reason: string }>();
  const seenMov = new Map<string, string>();
  for (const m of movements) {
    if (!animals.has(m.animalId) || !locations.has(m.fromLocationId) || !locations.has(m.toLocationId)) {
      anomalies.set(m.id, { record: m, reason: 'identifiant d’animal ou de lieu inconnu' });
      continue;
    }
    const d = bounds(m.departure);
    const a = bounds(m.arrival);
    if (a.max < d.min) {
      anomalies.set(m.id, { record: m, reason: `arrivée (${fmtBound(a.min, a.max)}) antérieure au départ (${fmtBound(d.min, d.max)})` });
      continue;
    }
    const sig = stableStringify([m.animalId, m.fromLocationId, m.toLocationId, m.departure, m.arrival]);
    const first = seenMov.get(sig);
    if (first) anomalies.set(m.id, { record: m, reason: `doublon du mouvement ${first}` });
    else seenMov.set(sig, m.id);
  }
  const seenPres = new Map<string, string>();
  for (const p of presences) {
    if (!animals.has(p.animalId) || !locations.has(p.locationId)) {
      anomalies.set(p.id, { record: p, reason: 'identifiant d’animal ou de lieu inconnu' });
      continue;
    }
    const b = presenceBounds(p.start, p.end);
    if (b.endMax < b.startMin) {
      anomalies.set(p.id, { record: p, reason: 'fin de présence antérieure au début' });
      continue;
    }
    const sig = stableStringify([p.animalId, p.locationId, p.start, p.end]);
    const first = seenPres.get(sig);
    if (first) anomalies.set(p.id, { record: p, reason: `doublon de la présence ${first}` });
    else seenPres.set(sig, p.id);
  }
  const ok = (id: string) => !anomalies.has(id);

  const touchesWindow = (min: number, max: number) => min < wTo && max >= wFrom;

  // ---------- 2. Niveau A : parcours enregistré de l'animal signalé ----------
  for (const m of movements) {
    if (m.animalId !== subject.id || !ok(m.id)) continue;
    const d = bounds(m.departure);
    const a = bounds(m.arrival);
    if (!touchesWindow(d.min, a.max)) continue;
    add({
      key: `A|${m.id}`,
      status: 'MOVEMENT_RECORDED',
      depth: 0,
      animalId: subject.id,
      animalTag: subject.tag,
      locationId: m.toLocationId,
      fromLocationId: m.fromLocationId,
      toLocationId: m.toLocationId,
      title: `${locName(m.fromLocationId)} → ${locName(m.toLocationId)}`,
      when: `${fmtBound(d.min, d.max)} → ${fmtBound(a.min, a.max)}`,
      evidence: [{ recordId: m.id, kind: 'movement', rev: m.rev }],
      rulesApplied: [],
      explanation: `Mouvement de ${subject.tag} tel qu’enregistré (${m.id}, révision ${m.rev}, source : ${m.source}).`,
      limits: m.verification === 'VERIFIED' ? [] : ['Enregistrement déclaré, non vérifié.'],
      sortTime: d.min,
    });
  }

  // ---------- 3. Niveau B : liens potentiels (R-B1), parcours en largeur borné ----------
  const queue: Tracked[] = [];
  const tracked = new Set<string>();
  const subjectPresences = presences.filter((p) => p.animalId === subject.id && ok(p.id));
  const visitedLocations = new Set<string>();
  for (const p of subjectPresences) {
    const raw = presenceBounds(p.start, p.end);
    if (!touchesWindow(raw.startMin, raw.endMax)) continue;
    visitedLocations.add(p.locationId);
    if (p.start.precision === 'UNKNOWN') {
      limits.add(`Provenance de ${subject.tag} avant ${locName(p.locationId)} non enregistrée.`);
    }
    tracked.add(p.id);
    queue.push({ animalId: subject.id, presence: p, bounds: clipToWindow(raw, wFrom, wTo), depth: 0 });
  }

  while (queue.length > 0) {
    const t = queue.shift()!;
    const loc = t.presence.locationId;
    const candidates = presences.filter((q) => {
      if (q.locationId !== loc || q.animalId === t.animalId || q.animalId === subject.id || !ok(q.id)) return false;
      const qb = presenceBounds(q.start, q.end);
      return touchesWindow(qb.startMin, qb.endMax);
    });
    if (candidates.length === 0) {
      if (t.depth === 0) {
        limits.add(
          `Aucun autre animal enregistré à ${locName(loc)} pendant la présence de ${subject.tag} — l’absence d’enregistrement ne prouve pas l’absence d’autres animaux.`,
        );
      }
      continue;
    }
    if (t.depth + 1 > params.maxDepth) {
      limits.add(`Profondeur maximale (${params.maxDepth}) atteinte : des présences au-delà n’ont pas été explorées.`);
      continue;
    }
    candidates.sort((a, b) => cmpStr(tag(a.animalId), tag(b.animalId)) || cmpStr(a.id, b.id));
    for (const q of candidates) {
      const qb = clipToWindow(presenceBounds(q.start, q.end), wFrom, wTo);
      const verdict = evaluateOverlap(t.bounds, qb, minOverlapMs);
      const ta = tag(t.animalId);
      const qa = tag(q.animalId);
      const calc = [
        `${ta} : ${describeBounds(t.bounds)}`,
        `${qa} : ${describeBounds(qb)}`,
        `chevauchement certain ? ${verdict.kind === 'CERTAIN' ? 'oui' : 'non'}`,
        `absence certaine ? ${verdict.kind === 'EXCLUDED' ? 'oui' : 'non'}`,
      ];
      const evidence: Evidence[] = [
        { recordId: t.presence.id, kind: 'presence', rev: t.presence.rev },
        { recordId: q.id, kind: 'presence', rev: q.rev },
      ];
      const onwardMoves = movements.filter(
        (m) => m.animalId === q.animalId && m.fromLocationId === loc && ok(m.id) && bounds(m.departure).max >= qb.startMin,
      );
      const onward = onwardMoves.map((m) => ({ movementId: m.id, toLocationId: m.toLocationId }));
      const base = {
        key: `B|${t.presence.id}|${q.id}`,
        depth: t.depth + 1,
        animalId: q.animalId,
        animalTag: qa,
        locationId: loc,
        title: `${qa} à ${locName(loc)}`,
        evidence,
        rulesApplied: [RULE_RB1],
        onward,
      };
      const qVerif = q.verification === 'VERIFIED' ? [] : [`Présence de ${qa} déclarée, non vérifiée.`];

      if (verdict.kind === 'CERTAIN') {
        add({
          ...base,
          status: 'POTENTIAL_LINK',
          when: `chevauchement ${formatInstant(verdict.from)} → ${formatInstant(verdict.to)}`,
          overlap: { from: new Date(verdict.from).toISOString(), to: new Date(verdict.to).toISOString() },
          explanation: `Les présences enregistrées de ${ta} et ${qa} à ${locName(loc)} se chevauchent selon la règle R-B1. C’est une piste de vérification, pas une preuve de contact ni de transmission.`,
          calculation: [...calc, '→ lien potentiel selon les paramètres'],
          limits: [...qVerif, 'Règle de démonstration à valider.'],
          sortTime: verdict.from,
        });
        for (const m of onwardMoves) {
          if (t.depth + 2 > params.maxDepth) {
            limits.add(`Profondeur maximale (${params.maxDepth}) atteinte : les lieux suivants de ${qa} ne sont pas explorés.`);
            break;
          }
          const d = bounds(m.departure);
          const a = bounds(m.arrival);
          add({
            key: `B2|${q.id}|${m.id}`,
            status: 'POTENTIAL_LINK',
            depth: t.depth + 2,
            animalId: q.animalId,
            animalTag: qa,
            locationId: m.toLocationId,
            fromLocationId: m.fromLocationId,
            toLocationId: m.toLocationId,
            viaAnimalId: q.animalId,
            originLocationId: loc,
            title: `${locName(m.toLocationId)} — lieu à vérifier, via ${qa}`,
            when: `arrivée ${fmtBound(a.min, a.max)}`,
            evidence: [{ recordId: q.id, kind: 'presence', rev: q.rev }, { recordId: m.id, kind: 'movement', rev: m.rev }],
            rulesApplied: [RULE_RB1],
            explanation: `${qa} a un lien potentiel avec ${ta} à ${locName(loc)}, puis un mouvement enregistré vers ${locName(m.toLocationId)}. Ce lieu est à vérifier ; rien n’indique un contact sur place.`,
            limits: ['Conséquence d’un lien potentiel, lui-même fondé sur une règle à valider.'],
            sortTime: d.min,
          });
          const next = presences.find((p) => p.animalId === q.animalId && p.locationId === m.toLocationId && ok(p.id) && !tracked.has(p.id));
          if (next) {
            tracked.add(next.id);
            queue.push({
              animalId: q.animalId,
              presence: next,
              bounds: clipToWindow(presenceBounds(next.start, next.end), wFrom, wTo),
              depth: t.depth + 2,
            });
          }
        }
      } else if (verdict.kind === 'EXCLUDED') {
        add({
          ...base,
          status: 'PATH_EXCLUDED',
          when: describeBounds(qb),
          explanation: `Les présences enregistrées ne se chevauchent pas selon la règle R-B1 et les paramètres choisis. Ce chemin n’est pas exploré plus loin. Cela ne signifie pas « sans risque sanitaire » : par exemple, la persistance d’un agent dans le lieu après un départ n’est pas modélisée.`,
          calculation: [...calc, '→ chemin exclu par cette recherche'],
          limits: ['« Exclu par cette recherche » ne signifie pas « sans risque ».'],
          sortTime: qb.startMin,
        });
      } else {
        const target = !isPrecise(q.start) || !isPrecise(q.end) ? q : t.presence;
        const targetTag = tag(target.animalId);
        add({
          ...base,
          status: 'INSUFFICIENT_INFO',
          when: describeBounds(qb),
          explanation: `La précision des données ne permet ni d’établir ni d’exclure un chevauchement. Aucune heure n’a été supposée.`,
          calculation: [...calc, '→ indéterminé'],
          limits: [
            ...(onward.length ? [`Mouvement(s) suivant(s) de ${qa} non explorés : ${onward.map((o) => `${o.movementId} vers ${locName(o.toLocationId)}`).join(', ')}.`] : []),
          ],
          task: {
            kind: 'COMPLETE_PRESENCE',
            recordId: target.id,
            label: `Préciser les heures de présence de ${targetTag} à ${locName(target.locationId)}`,
          },
          sortTime: Number.isFinite(qb.startMin) ? qb.startMin : wFrom,
        });
      }
    }
  }

  // ---------- 4. Anomalies pertinentes pour cette enquête ----------
  for (const [id, { record, reason }] of [...anomalies.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
    const locs = record.kind === 'movement' ? [record.fromLocationId, record.toLocationId] : [record.locationId];
    const relevant = record.animalId === subject.id || locs.some((l) => visitedLocations.has(l));
    if (!relevant) continue;
    const range =
      record.kind === 'movement'
        ? { min: Math.min(bounds(record.departure).min, bounds(record.arrival).min), max: Math.max(bounds(record.departure).max, bounds(record.arrival).max) }
        : (() => {
            const b = presenceBounds(record.start, record.end);
            return { min: b.startMin, max: b.endMax };
          })();
    if (!touchesWindow(range.min, range.max)) continue;
    const at = tag(record.animalId);
    add({
      key: `C|anomaly|${id}`,
      status: 'DATA_ANOMALY',
      depth: 0,
      animalId: record.animalId,
      animalTag: at,
      locationId: record.kind === 'movement' ? record.toLocationId : record.locationId,
      ...(record.kind === 'movement' ? { fromLocationId: record.fromLocationId, toLocationId: record.toLocationId } : {}),
      title: record.kind === 'movement' ? `${at} : ${locName(record.fromLocationId)} → ${locName(record.toLocationId)}` : `${at} à ${locName(record.locationId)}`,
      when: reason,
      evidence: [{ recordId: id, kind: record.kind, rev: record.rev }],
      rulesApplied: [],
      explanation: `Enregistrement incohérent (${reason}). Il n’est utilisé ni pour établir ni pour exclure un lien. Une anomalie de données n’est pas un signal sanitaire.`,
      limits: ['À vérifier auprès de la source.'],
      task: { kind: 'CHECK_RECORD', recordId: id, label: `Vérifier l’enregistrement ${id} de ${at} (${reason})` },
      sortTime: Number.isFinite(range.min) ? range.min : wFrom,
    });
  }

  // ---------- 5. Tri déterministe, plafond, lieux non évalués ----------
  let list = [...results.values()].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      a.depth - b.depth ||
      a.sortTime - b.sortTime ||
      cmpStr(a.animalTag, b.animalTag) ||
      cmpStr(a.key, b.key),
  );
  // Le niveau A reste en tête, dans l'ordre chronologique.
  let truncated = false;
  if (list.length > params.maxResults) {
    truncated = true;
    list = list.slice(0, params.maxResults);
    limits.add(`Plafond de ${params.maxResults} résultats atteint : liste tronquée.`);
  }

  const referenced = new Set<string>(visitedLocations);
  for (const r of list) {
    for (const l of [r.locationId, r.fromLocationId, r.toLocationId, r.originLocationId]) if (l) referenced.add(l);
    for (const o of r.onward ?? []) referenced.add(o.toLocationId);
  }
  const nonEvaluatedLocationIds = snapshot.locations
    .filter((l) => !referenced.has(l.id))
    .map((l) => l.id)
    .sort(cmpStr);

  limits.add('Règle R-B1 (chevauchement de présence dans un même lieu) : règle de démonstration à valider.');
  limits.add('Les contacts pendant le transport et la persistance d’un agent dans un lieu ne sont pas modélisés.');
  limits.add('La fenêtre d’enquête est un choix de l’enquêteur, pas une durée sanitaire.');

  return { engineVersion: ENGINE_VERSION, params, results: list, limits: [...limits], truncated, nonEvaluatedLocationIds };
}

// ---------- Comparaison de deux analyses ----------

export interface AnalysisDiff {
  added: AnalysisResult[];
  removed: AnalysisResult[];
  changed: { before: AnalysisResult; after: AnalysisResult }[];
  unchangedCount: number;
  causes: string[];
  summary: string;
}

type AnyRecord = Presence | Movement;

function describeRecord(r: AnyRecord, snap: DataSnapshot): string {
  const tag = snap.animals.find((a) => a.id === r.animalId)?.tag ?? r.animalId;
  const loc = (id: string) => snap.locations.find((l) => l.id === id)?.name ?? id;
  return r.kind === 'presence' ? `présence de ${tag} à ${loc(r.locationId)}` : `mouvement de ${tag} ${loc(r.fromLocationId)} → ${loc(r.toLocationId)}`;
}

const VERIF_LABEL: Record<VerificationStatus, string> = { DECLARED: 'déclaré, non vérifié', VERIFIED: 'vérifié', TO_VERIFY: 'à vérifier' };

export function diffAnalyses(before: AnalysisOutput, after: AnalysisOutput, snapBefore: DataSnapshot, snapAfter: DataSnapshot): AnalysisDiff {
  const a = new Map(before.results.map((r) => [r.key, r]));
  const b = new Map(after.results.map((r) => [r.key, r]));
  const added = after.results.filter((r) => !a.has(r.key));
  const removed = before.results.filter((r) => !b.has(r.key));
  const changed: AnalysisDiff['changed'] = [];
  let unchangedCount = 0;
  for (const r of after.results) {
    const prev = a.get(r.key);
    if (!prev) continue;
    if (prev.status !== r.status) changed.push({ before: prev, after: r });
    else unchangedCount++;
  }

  const causes: string[] = [];
  const recs = (s: DataSnapshot) => new Map<string, AnyRecord>([...s.presences, ...s.movements].map((r) => [r.id, r]));
  const ra = recs(snapBefore);
  const rb = recs(snapAfter);
  for (const [id, r] of [...rb.entries()].sort((x, y) => cmpStr(x[0], y[0]))) {
    const p = ra.get(id);
    if (!p) causes.push(`Nouvel enregistrement ${id} (${describeRecord(r, snapAfter)}).`);
    else if (p.rev !== r.rev)
      causes.push(
        `Révision ${r.rev} de ${id} (${describeRecord(r, snapAfter)})${r.revisionNote ? ` : ${r.revisionNote}` : ''} — ${VERIF_LABEL[r.verification]}.`,
      );
  }
  for (const id of [...ra.keys()].sort(cmpStr)) if (!rb.has(id)) causes.push(`Enregistrement ${id} absent de la seconde analyse.`);
  const pb = stableStringify(before.params);
  const pa = stableStringify(after.params);
  if (pb !== pa) causes.push('Paramètres d’analyse modifiés.');
  if (before.engineVersion !== after.engineVersion) causes.push(`Version du moteur : ${before.engineVersion} → ${after.engineVersion}.`);

  const parts = [
    `${changed.length} résultat${changed.length > 1 ? 's' : ''} modifié${changed.length > 1 ? 's' : ''}`,
    `${added.length} ajouté${added.length > 1 ? 's' : ''}`,
    `${removed.length} retiré${removed.length > 1 ? 's' : ''}`,
  ];
  const summary = changed.length + added.length + removed.length === 0 ? 'Aucun changement de résultat.' : `${parts.join(', ')}.`;
  return { added, removed, changed, unchangedCount, causes: causes.length ? causes : ['Aucune différence de données ni de paramètres.'], summary };
}
