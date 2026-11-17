import { describe, expect, it } from 'vitest';
import {
  type AnalysisResult,
  type DataSnapshot,
  analyze,
  diffAnalyses,
  evaluateOverlap,
  presenceBounds,
  REFERENCE_CORRECTION,
  REFERENCE_PARAMS,
  REFERENCE_SCENARIO,
  stableStringify,
} from '../src/index.js';

const snap = (): DataSnapshot => structuredClone(REFERENCE_SCENARIO);
const run = (s = snap(), p = REFERENCE_PARAMS) => analyze(s, p);
const byKey = (rs: AnalysisResult[], key: string) => rs.find((r) => r.key === key);
const corrected = (): DataSnapshot => {
  const s = snap();
  const p6 = s.presences.find((p) => p.id === 'P6')!;
  Object.assign(p6, REFERENCE_CORRECTION, { rev: 2 });
  return s;
};
const H = (h: string) => Date.parse(`2026-03-01T${h}:00Z`);

describe('Scénario B-017 — analyse n° 1 (DOMAIN.md §5.3)', () => {
  const out = run();

  it('ENG-01 parcours enregistré A → M → C dans l’ordre chronologique', () => {
    const a = out.results.filter((r) => r.status === 'MOVEMENT_RECORDED');
    expect(a.map((r) => r.key)).toEqual(['A|MV1', 'A|MV2']);
    expect(a.map((r) => [r.fromLocationId, r.toLocationId])).toEqual([['A', 'M'], ['M', 'C']]);
    expect(out.results[0]!.key).toBe('A|MV1');
  });

  it('ENG-02 B-031 lien potentiel au Marché M, chevauchement 10:00–14:00, preuves P2 + P4', () => {
    const r = byKey(out.results, 'B|P2|P4')!;
    expect(r.status).toBe('POTENTIAL_LINK');
    expect(r.overlap).toEqual({ from: '2026-03-01T10:00:00.000Z', to: '2026-03-01T14:00:00.000Z' });
    expect(r.evidence.map((e) => e.recordId)).toEqual(['P2', 'P4']);
    expect(r.rulesApplied).toEqual(['R-B1']);
  });

  it('ENG-03 Élevage D à profondeur 2 via B-031 (preuve MV3)', () => {
    const r = byKey(out.results, 'B2|P4|MV3')!;
    expect(r).toMatchObject({ status: 'POTENTIAL_LINK', depth: 2, toLocationId: 'D', viaAnimalId: 'B-031' });
    expect(r.evidence.map((e) => e.recordId)).toContain('MV3');
  });

  it('ENG-04 B-044 exclu par cette recherche, avec la mention « ne signifie pas sans risque »', () => {
    const r = byKey(out.results, 'B|P2|P5')!;
    expect(r.status).toBe('PATH_EXCLUDED');
    expect(r.explanation).toMatch(/ne signifie pas « sans risque sanitaire »/);
    expect(out.results.some((x) => x.key.startsWith('B2|P5'))).toBe(false);
  });

  it('ENG-05 B-052 information insuffisante + tâche de vérification sur P6', () => {
    const r = byKey(out.results, 'B|P2|P6')!;
    expect(r.status).toBe('INSUFFICIENT_INFO');
    expect(r.task).toMatchObject({ kind: 'COMPLETE_PRESENCE', recordId: 'P6' });
    expect(out.results.some((x) => x.key.startsWith('B2|P6'))).toBe(false);
  });

  it('ENG-06 B-060 anomalie de données, utilisée nulle part ailleurs', () => {
    const r = byKey(out.results, 'C|anomaly|MV6')!;
    expect(r.status).toBe('DATA_ANOMALY');
    expect(r.task?.kind).toBe('CHECK_RECORD');
    const others = out.results.filter((x) => x.key !== r.key);
    expect(others.flatMap((x) => x.evidence.map((e) => e.recordId))).not.toContain('MV6');
  });

  it('ENG-07 aucun résultat sur l’Élevage E, signalé comme non évalué', () => {
    const touchesE = out.results.some((r) => [r.locationId, r.fromLocationId, r.toLocationId].includes('E'));
    expect(touchesE).toBe(false);
    expect(out.nonEvaluatedLocationIds).toEqual(['E']);
  });

  it('exactement 7 résultats, dans l’ordre des statuts', () => {
    expect(out.results.map((r) => r.key)).toEqual(['A|MV1', 'A|MV2', 'B|P2|P4', 'B2|P4|MV3', 'B|P2|P6', 'B|P2|P5', 'C|anomaly|MV6']);
  });

  it('limites : provenance de B-017 avant A, aucun autre animal à C', () => {
    expect(out.limits.join('\n')).toMatch(/Provenance de B-017 avant Élevage A non enregistrée/);
    expect(out.limits.join('\n')).toMatch(/Aucun autre animal enregistré à Élevage C/);
  });
});

describe('Règles temporelles', () => {
  const p2 = presenceBounds({ precision: 'INSTANT', at: '2026-03-01T08:00:00Z' }, { precision: 'INSTANT', at: '2026-03-01T16:00:00Z' });

  it('ENG-08 précision DAY : aucune heure fixée à minuit → indéterminé', () => {
    const day = presenceBounds({ precision: 'DAY', date: '2026-03-01' }, { precision: 'DAY', date: '2026-03-01' });
    expect(day.startMin).toBe(H('00:00'));
    expect(day.startMax).toBe(Date.parse('2026-03-02T00:00:00Z'));
    expect(evaluateOverlap(p2, day).kind).toBe('UNDETERMINED');
  });

  it('ENG-09 journée entière postérieure → exclusion certaine', () => {
    const next = presenceBounds({ precision: 'DAY', date: '2026-03-02' }, { precision: 'DAY', date: '2026-03-02' });
    expect(evaluateOverlap(p2, next).kind).toBe('EXCLUDED');
  });

  it('ENG-10 intervalles contigus (fin = début) → pas de chevauchement', () => {
    const q = presenceBounds({ precision: 'INSTANT', at: '2026-03-01T16:00:00Z' }, { precision: 'INSTANT', at: '2026-03-01T17:00:00Z' });
    expect(evaluateOverlap(p2, q).kind).toBe('EXCLUDED');
  });

  it('ENG-11 borne inconnue → jamais exclu, indéterminé', () => {
    const q = presenceBounds({ precision: 'UNKNOWN' }, { precision: 'UNKNOWN' });
    expect(evaluateOverlap(p2, q).kind).toBe('UNDETERMINED');
    const s = snap();
    s.presences.find((p) => p.id === 'P5')!.start = { precision: 'UNKNOWN' };
    s.presences.find((p) => p.id === 'P5')!.end = { precision: 'UNKNOWN' };
    expect(byKey(run(s).results, 'B|P2|P5')!.status).toBe('INSUFFICIENT_INFO');
  });
});

describe('Parcours amont / aval, cycles, doublons, plafonds', () => {
  it('ENG-12 amont : B-017 vient de M, puis de A ; provenance antérieure non enregistrée', () => {
    const out = run();
    const a = out.results.filter((r) => r.level === 'A');
    expect(a.at(-1)!.toLocationId).toBe('C');
    expect(a.at(-1)!.fromLocationId).toBe('M');
    expect(a[0]!.fromLocationId).toBe('A');
  });

  it('ENG-13 aval depuis M : D atteint via B-031', () => {
    expect(run().results.filter((r) => r.depth === 2).map((r) => [r.toLocationId, r.viaAnimalId])).toEqual([['D', 'B-031']]);
  });

  it('ENG-14 cycle C → M → C : le calcul se termine, chaque présence explorée une fois', () => {
    const s = snap();
    s.animals.push({ id: 'X-1', tag: 'X-1' });
    s.presences.push(
      { kind: 'presence', id: 'PX1', rev: 1, animalId: 'X-1', locationId: 'M', start: { precision: 'INSTANT', at: '2026-03-01T09:00:00Z' }, end: { precision: 'INSTANT', at: '2026-03-01T12:00:00Z' }, verification: 'DECLARED', source: 'test' },
      { kind: 'presence', id: 'PX2', rev: 1, animalId: 'X-1', locationId: 'C', start: { precision: 'INSTANT', at: '2026-03-01T13:00:00Z' }, end: { precision: 'INSTANT', at: '2026-03-01T15:00:00Z' }, verification: 'DECLARED', source: 'test' },
      { kind: 'presence', id: 'PX3', rev: 1, animalId: 'X-1', locationId: 'M', start: { precision: 'INSTANT', at: '2026-03-01T15:30:00Z' }, end: { precision: 'INSTANT', at: '2026-03-01T15:45:00Z' }, verification: 'DECLARED', source: 'test' },
    );
    s.movements.push(
      { kind: 'movement', id: 'MX1', rev: 1, animalId: 'X-1', fromLocationId: 'M', toLocationId: 'C', departure: { precision: 'INSTANT', at: '2026-03-01T12:00:00Z' }, arrival: { precision: 'INSTANT', at: '2026-03-01T13:00:00Z' }, verification: 'DECLARED', source: 'test' },
      { kind: 'movement', id: 'MX2', rev: 1, animalId: 'X-1', fromLocationId: 'C', toLocationId: 'M', departure: { precision: 'INSTANT', at: '2026-03-01T15:00:00Z' }, arrival: { precision: 'INSTANT', at: '2026-03-01T15:30:00Z' }, verification: 'DECLARED', source: 'test' },
    );
    const out = analyze(s, { ...REFERENCE_PARAMS, maxDepth: 6 });
    const keys = out.results.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('B|P2|PX1');
  });

  it('ENG-15 mouvement enregistré deux fois → un seul résultat, doublon signalé', () => {
    const s = snap();
    s.movements.push({ ...s.movements.find((m) => m.id === 'MV2')!, id: 'MV2bis' });
    const out = run(s);
    expect(out.results.filter((r) => r.status === 'MOVEMENT_RECORDED')).toHaveLength(2);
    expect(byKey(out.results, 'C|anomaly|MV2bis')?.when).toMatch(/doublon du mouvement MV2/);
  });

  it('ENG-16 maxDepth = 1 : D n’apparaît pas et la limite est indiquée', () => {
    const out = run(snap(), { ...REFERENCE_PARAMS, maxDepth: 1 });
    expect(out.results.some((r) => r.depth === 2)).toBe(false);
    expect(out.limits.join('\n')).toMatch(/Profondeur maximale \(1\)/);
  });

  it('ENG-17 maxResults = 3 : 3 résultats et indicateur de troncature', () => {
    const out = run(snap(), { ...REFERENCE_PARAMS, maxResults: 3 });
    expect(out.results).toHaveLength(3);
    expect(out.truncated).toBe(true);
    expect(out.limits.join('\n')).toMatch(/Plafond de 3 résultats/);
  });
});

describe('Bornes (constats de la revue indépendante)', () => {
  it('un mouvement suivant postérieur à la fenêtre n’est pas un lieu à vérifier', () => {
    const s = snap();
    s.movements.find((m) => m.id === 'MV3')!.departure = { precision: 'INSTANT', at: '2026-06-01T08:00:00Z' };
    s.movements.find((m) => m.id === 'MV3')!.arrival = { precision: 'INSTANT', at: '2026-06-01T10:00:00Z' };
    const out = run(s);
    expect(byKey(out.results, 'B|P2|P4')!.status).toBe('POTENTIAL_LINK');
    expect(out.results.some((r) => r.key === 'B2|P4|MV3')).toBe(false);
  });

  it('un départ antérieur au chevauchement n’est pas suivi', () => {
    const s = snap();
    s.movements.push({ kind: 'movement', id: 'MV3a', rev: 1, animalId: 'B-031', fromLocationId: 'M', toLocationId: 'E', departure: { precision: 'INSTANT', at: '2026-03-01T09:00:00Z' }, arrival: { precision: 'INSTANT', at: '2026-03-01T09:30:00Z' }, verification: 'DECLARED', source: 'test' });
    expect(run(s).results.some((r) => r.key === 'B2|P4|MV3a')).toBe(false);
  });

  it('une présence qui se termine exactement au début de la fenêtre n’y entre pas', () => {
    const out = run(snap(), { ...REFERENCE_PARAMS, window: { from: '2026-03-01T16:00:00Z', to: '2026-03-13T00:00:00Z' } });
    expect(out.results.some((r) => r.key.startsWith('B|P2|'))).toBe(false);
  });

  it('la présence suivie au lieu d’arrivée est celle qui correspond à l’heure d’arrivée', () => {
    const s = snap();
    s.animals.push({ id: 'Y-1', tag: 'Y-1' });
    s.presences.push(
      { kind: 'presence', id: 'PD-old', rev: 1, animalId: 'B-031', locationId: 'D', start: { precision: 'INSTANT', at: '2026-02-26T00:00:00Z' }, end: { precision: 'INSTANT', at: '2026-02-27T00:00:00Z' }, verification: 'DECLARED', source: 'test' },
      { kind: 'presence', id: 'PD-new', rev: 1, animalId: 'B-031', locationId: 'D', start: { precision: 'INSTANT', at: '2026-03-01T17:00:00Z' }, end: null, verification: 'DECLARED', source: 'test' },
      { kind: 'presence', id: 'PY', rev: 1, animalId: 'Y-1', locationId: 'D', start: { precision: 'INSTANT', at: '2026-03-02T08:00:00Z' }, end: { precision: 'INSTANT', at: '2026-03-02T09:00:00Z' }, verification: 'DECLARED', source: 'test' },
    );
    const out = analyze(s, { ...REFERENCE_PARAMS, maxDepth: 3 });
    expect(byKey(out.results, 'B|PD-new|PY')?.status).toBe('POTENTIAL_LINK');
    expect(out.results.some((r) => r.key.startsWith('B|PD-old|'))).toBe(false);
  });
});

describe('Correction, reproductibilité, vocabulaire', () => {
  it('ENG-18 révision 2 de P6 : B-052 devient lien potentiel, D ajouté via B-052, rien d’autre ne change', () => {
    const s1 = snap();
    const s2 = corrected();
    const a = run(s1);
    const b = run(s2);
    expect(byKey(b.results, 'B|P2|P6')).toMatchObject({ status: 'POTENTIAL_LINK', overlap: { from: '2026-03-01T11:00:00.000Z', to: '2026-03-01T15:00:00.000Z' } });
    expect(byKey(b.results, 'B2|P6|MV5')).toMatchObject({ status: 'POTENTIAL_LINK', depth: 2, toLocationId: 'D', viaAnimalId: 'B-052' });
    const d = diffAnalyses(a, b, s1, s2);
    expect(d.changed.map((c) => c.after.key)).toEqual(['B|P2|P6']);
    expect(d.added.map((r) => r.key)).toEqual(['B2|P6|MV5']);
    expect(d.removed).toEqual([]);
    expect(d.summary).toBe('1 résultat modifié, 1 ajouté, 0 retiré.');
    expect(d.causes).toEqual(['Révision 2 de P6 (présence de B-052 à Marché M) : heures précisées par un agent — déclaré, non vérifié.']);
  });

  it('ENG-19 mêmes données et paramètres → résultats identiques, même empreinte', () => {
    expect(stableStringify(run())).toBe(stableStringify(run()));
    const shuffled = snap();
    shuffled.presences.reverse();
    shuffled.movements.reverse();
    expect(stableStringify(run(shuffled).results)).toBe(stableStringify(run().results));
  });

  it('ENG-20 aucun vocabulaire d’infection ou de contact avéré', () => {
    const text = JSON.stringify([run(), run(corrected())]).toLowerCase();
    for (const w of ['infecté', 'contaminé', 'contact avéré', 'transmis ']) expect(text).not.toContain(w);
    expect(text).toContain('pas une preuve de contact ni de transmission');
  });

  it('ENG-21 l’analyse 1 reste relisible depuis son instantané après correction', () => {
    const s1 = snap();
    const frozen = structuredClone(s1);
    const out1 = run(frozen);
    Object.assign(s1.presences.find((p) => p.id === 'P6')!, REFERENCE_CORRECTION, { rev: 2 });
    expect(byKey(run(frozen).results, 'B|P2|P6')!.status).toBe('INSUFFICIENT_INFO');
    expect(stableStringify(run(frozen))).toBe(stableStringify(out1));
  });

  it('paramètres invalides refusés', () => {
    expect(() => run(snap(), { ...REFERENCE_PARAMS, window: { from: '2026-03-13T00:00:00Z', to: '2026-02-25T00:00:00Z' } })).toThrow();
    expect(() => run(snap(), { ...REFERENCE_PARAMS, subjectAnimalId: 'B-999' })).toThrow();
  });
});

describe('Performance (jeu synthétique à graine fixe, sans réalisme épidémiologique)', () => {
  it('2 000 animaux, 20 lieux : calcul sous 2 s et plafond respecté', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    const s = snap();
    for (let i = 0; i < 20; i++) s.locations.push({ id: `L${i}`, code: `L${i}`, name: `Lieu ${i}`, kind: i % 5 === 0 ? 'MARKET' : 'FARM' });
    const locs = ['M', ...s.locations.slice(5).map((l) => l.id)];
    for (let i = 0; i < 2000; i++) {
      const id = `S-${i}`;
      s.animals.push({ id, tag: id });
      let tms = Date.parse('2026-02-26T00:00:00Z') + Math.floor(rnd() * 86_400_000 * 3);
      let loc = locs[Math.floor(rnd() * locs.length)]!;
      for (let k = 0; k < 3; k++) {
        const dur = 3_600_000 * (2 + Math.floor(rnd() * 30));
        s.presences.push({ kind: 'presence', id: `${id}-p${k}`, rev: 1, animalId: id, locationId: loc, start: { precision: 'INSTANT', at: new Date(tms).toISOString() }, end: { precision: 'INSTANT', at: new Date(tms + dur).toISOString() }, verification: 'DECLARED', source: 'perf' });
        const next = locs[Math.floor(rnd() * locs.length)]!;
        s.movements.push({ kind: 'movement', id: `${id}-m${k}`, rev: 1, animalId: id, fromLocationId: loc, toLocationId: next, departure: { precision: 'INSTANT', at: new Date(tms + dur).toISOString() }, arrival: { precision: 'INSTANT', at: new Date(tms + dur + 3_600_000).toISOString() }, verification: 'DECLARED', source: 'perf' });
        tms += dur + 3_600_000;
        loc = next;
      }
    }
    const t0 = performance.now();
    const out = analyze(s, { ...REFERENCE_PARAMS, maxDepth: 4, maxResults: 500 });
    const ms = performance.now() - t0;
    console.info(`[perf] ${s.presences.length} présences, ${s.movements.length} mouvements → ${out.results.length} résultats en ${ms.toFixed(0)} ms`);
    expect(out.results.length).toBeLessThanOrEqual(500);
    expect(ms).toBeLessThan(2000);
  });
});
