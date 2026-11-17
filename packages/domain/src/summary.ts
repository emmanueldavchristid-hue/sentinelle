import type { AnalysisOutput, AnalysisResult, DataSnapshot } from './engine.js';
import { formatInstant } from './temporal.js';

/**
 * Synthèse d'enquête DÉTERMINISTE : toujours disponible, sans IA.
 * Chaque paragraphe cite les identifiants des enregistrements justificatifs.
 */
export interface SummaryParagraph {
  id: 'path' | 'links' | 'insufficient' | 'excluded' | 'anomalies' | 'not-evaluated' | 'actions';
  title: string;
  text: string;
  evidence: string[];
}
export interface AnalysisSummary {
  paragraphs: SummaryParagraph[];
  /** Identifiants autorisés pour une éventuelle reformulation (enregistrements et animaux cités). */
  allowedIds: string[];
}

const ev = (rs: AnalysisResult[]) => [...new Set(rs.flatMap((r) => r.evidence.map((e) => e.recordId)))].sort();
const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(' ; ')} et ${items.at(-1)}`);

export function summarizeAnalysis(output: AnalysisOutput, snapshot: DataSnapshot): AnalysisSummary {
  const r = output.results;
  const subject = snapshot.animals.find((a) => a.id === output.params.subjectAnimalId)?.tag ?? output.params.subjectAnimalId;
  const locName = (id: string) => snapshot.locations.find((l) => l.id === id)?.name ?? id;
  const win = `du ${formatInstant(Date.parse(output.params.window.from)).slice(0, 10)} au ${formatInstant(Date.parse(output.params.window.to)).slice(0, 10)} (fin exclue)`;
  const by = (s: AnalysisResult['status']) => r.filter((x) => x.status === s);
  const p: SummaryParagraph[] = [];

  const moves = by('MOVEMENT_RECORDED');
  p.push({
    id: 'path',
    title: 'Parcours enregistré',
    text: moves.length
      ? `Sur la fenêtre ${win}, ${subject} compte ${moves.length} mouvement${moves.length > 1 ? 's' : ''} enregistré${moves.length > 1 ? 's' : ''} : ${list(moves.map((m) => `${m.title} (${m.when})`))}.`
      : `Aucun mouvement de ${subject} n’est enregistré sur la fenêtre ${win}. Cela ne prouve pas l’absence de déplacement.`,
    evidence: ev(moves),
  });

  const links = by('POTENTIAL_LINK');
  const d1 = links.filter((x) => x.depth === 1);
  const d2 = links.filter((x) => x.depth >= 2);
  p.push({
    id: 'links',
    title: 'Liens potentiels (règle R-B1, à valider)',
    text: links.length
      ? `${d1.length} présence${d1.length > 1 ? 's' : ''} chevauchante${d1.length > 1 ? 's' : ''} selon la règle : ${list(d1.map((x) => `${x.title} (${x.when})`))}.` +
        (d2.length ? ` Lieu${d2.length > 1 ? 'x' : ''} à vérifier ensuite : ${list(d2.map((x) => `${locName(x.toLocationId ?? '')} via ${x.animalTag}`))}.` : '') +
        ' Ce sont des pistes de vérification, pas des preuves de contact ni de transmission.'
      : 'Aucun lien potentiel selon la règle et les paramètres choisis. Cela ne signifie pas une absence de risque.',
    evidence: ev(links),
  });

  const ins = by('INSUFFICIENT_INFO');
  if (ins.length)
    p.push({
      id: 'insufficient',
      title: 'Ce que les données ne permettent pas de trancher',
      text: `Information insuffisante pour ${list(ins.map((x) => x.title))} : la précision des dates ne permet ni d’établir ni d’exclure un chevauchement. Aucune heure n’a été supposée.`,
      evidence: ev(ins),
    });

  const exc = by('PATH_EXCLUDED');
  if (exc.length)
    p.push({
      id: 'excluded',
      title: 'Chemins exclus par cette recherche',
      text: `${list(exc.map((x) => x.title))} : pas de chevauchement selon la règle et les paramètres. « Exclu par cette recherche » ne signifie pas « sans risque sanitaire ».`,
      evidence: ev(exc),
    });

  const ano = by('DATA_ANOMALY');
  if (ano.length)
    p.push({
      id: 'anomalies',
      title: 'Anomalies de données',
      text: `${ano.length} enregistrement${ano.length > 1 ? 's' : ''} incohérent${ano.length > 1 ? 's' : ''}, non exploité${ano.length > 1 ? 's' : ''} : ${list(ano.map((x) => `${x.title} (${x.when})`))}. Une anomalie de données n’est pas un signal sanitaire.`,
      evidence: ev(ano),
    });

  if (output.nonEvaluatedLocationIds.length)
    p.push({
      id: 'not-evaluated',
      title: 'Lieux non évalués',
      text: `${list(output.nonEvaluatedLocationIds.map(locName))} : aucun mouvement enregistré ne relie ce lieu à la recherche. La proximité géographique n’est pas évaluée.`,
      evidence: [],
    });

  const tasks = r.filter((x) => x.task).map((x) => x.task!);
  if (tasks.length)
    p.push({
      id: 'actions',
      title: 'Vérifications proposées',
      text: `${list([...new Set(tasks.map((t) => t.label))])}.`,
      evidence: [...new Set(tasks.map((t) => t.recordId))].sort(),
    });

  const allowedIds = [...new Set([...r.flatMap((x) => x.evidence.map((e) => e.recordId)), ...r.map((x) => x.animalTag), subject])].sort();
  return { paragraphs: p, allowedIds };
}

/** Vocabulaire interdit dans une synthèse : conclusions sanitaires que les données ne permettent pas. */
export const FORBIDDEN_SUMMARY_PATTERNS: RegExp[] = [
  /infect/i,
  /contamin/i,
  /\ba transmis\b/i,
  /\bcontact (avéré|confirmé|certain|prouvé)/i,
  /\b(est|sont) (malade|atteint)/i,
  /\bdiagnostic\b(?! )/i,
  /\bfoyer\b/i,
];

/**
 * Vérifie une synthèse reformulée : chaque identifiant de type animal/enregistrement cité doit exister,
 * aucun vocabulaire de conclusion sanitaire.
 */
export function validateRewrittenSummary(paragraphs: { text: string; evidence: string[] }[], allowedIds: string[]): string[] {
  const allowed = new Set(allowedIds);
  const errors: string[] = [];
  paragraphs.forEach((para, i) => {
    for (const e of para.evidence) if (!allowed.has(e)) errors.push(`paragraphe ${i + 1} : preuve inconnue « ${e} »`);
    const cited = para.text.match(/\b(?:[A-Z]{1,3}-\d{2,4}|P\d+|MV\d+)\b/g) ?? [];
    for (const c of cited) if (!allowed.has(c)) errors.push(`paragraphe ${i + 1} : identifiant inventé « ${c} »`);
    for (const re of FORBIDDEN_SUMMARY_PATTERNS) if (re.test(para.text)) errors.push(`paragraphe ${i + 1} : formulation interdite (${re.source})`);
  });
  return errors;
}
