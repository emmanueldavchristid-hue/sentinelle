import { describe, expect, it } from 'vitest';
import { analyze, REFERENCE_PARAMS, REFERENCE_SCENARIO, summarizeAnalysis, validateRewrittenSummary } from '../src/index.js';

const out = analyze(structuredClone(REFERENCE_SCENARIO), REFERENCE_PARAMS);
const sum = summarizeAnalysis(out, REFERENCE_SCENARIO);

describe('Synthèse déterministe', () => {
  it('reprend les trois catégories, avec preuves, sans conclusion sanitaire', () => {
    expect(sum.paragraphs.map((p) => p.id)).toEqual(['path', 'links', 'insufficient', 'excluded', 'anomalies', 'not-evaluated', 'actions']);
    const byId = Object.fromEntries(sum.paragraphs.map((p) => [p.id, p]));
    expect(byId.path!.text).toMatch(/B-017 compte 2 mouvements enregistrés/);
    expect(byId.path!.evidence).toEqual(['MV1', 'MV2']);
    expect(byId.links!.text).toMatch(/B-031 à Marché M/);
    expect(byId.links!.text).toMatch(/Élevage D via B-031/);
    expect(byId.insufficient!.text).toMatch(/B-052 à Marché M/);
    expect(byId.excluded!.text).toMatch(/ne signifie pas « sans risque sanitaire »/);
    expect(byId['not-evaluated']!.text).toMatch(/^Élevage E/);
    expect(validateRewrittenSummary(sum.paragraphs, sum.allowedIds)).toEqual([]);
  });

  it('identique d’un appel à l’autre', () => {
    expect(JSON.stringify(summarizeAnalysis(out, REFERENCE_SCENARIO))).toBe(JSON.stringify(sum));
  });
});

describe('Validation d’une synthèse reformulée', () => {
  it('refuse identifiants inventés, preuves inconnues et vocabulaire de conclusion', () => {
    const errors = validateRewrittenSummary(
      [
        { text: 'B-017 a été en contact avéré avec B-999 au marché.', evidence: ['P2'] },
        { text: 'L’animal est contaminé.', evidence: ['P77'] },
      ],
      sum.allowedIds,
    );
    expect(errors.join('\n')).toMatch(/identifiant inventé « B-999 »/);
    expect(errors.join('\n')).toMatch(/preuve inconnue « P77 »/);
    expect(errors.join('\n')).toMatch(/contact/);
    expect(errors.join('\n')).toMatch(/contamin/);
  });
  it('accepte une reformulation fidèle', () => {
    expect(validateRewrittenSummary([{ text: 'Deux mouvements de B-017 sont enregistrés (MV1, MV2).', evidence: ['MV1', 'MV2'] }], sum.allowedIds)).toEqual([]);
  });
});
