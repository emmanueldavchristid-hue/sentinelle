import { useMemo, useState, type KeyboardEvent } from 'react';
import { bounds, formatTemporal, type TemporalValue } from '@sentinelle/domain';
import type { AnimalData, FarmEvent, MoveEdge, SiteSummary } from '@sentinelle/contracts';

/**
 * Constellation vivante : sites, déplacements enregistrés et événements de l'exploitation.
 * - Vue par défaut : les sites et le nombre d'animaux qui y ont une présence ouverte (jamais chaque individu).
 * - Animal sélectionné : son parcours enregistré, numéroté, et ses observations ; le reste passe au second plan.
 * - Chaque trait a une signification écrite. Les coordonnées sont fictives : c'est un schéma, pas une carte.
 * - Aucune animation ne suggère un capteur : la seule pulsation signale un enregistrement que vous venez de confirmer.
 * La vue « Liste » donne exactement les mêmes informations en texte ; elle remplace le schéma sur téléphone.
 */
const W = 820;
const H = 470;
const PX = 104;
const PY = 92;

interface Pt {
  x: number;
  y: number;
}
type Props = {
  sites: SiteSummary[];
  moves: MoveEdge[];
  /** Enregistrements reçus depuis hier (pour les marqueurs par site). */
  recent: FarmEvent[];
  animal: AnimalData | null;
  /** Références mises en évidence par la dernière réponse. */
  highlight: ReadonlySet<string>;
  /** Références d'enregistrements confirmés pendant cette session (« nouveau »). */
  fresh: ReadonlySet<string>;
  onSource: (ref: string) => void;
};

function layout(sites: SiteSummary[]): Map<string, Pt> {
  const placed = sites.filter((s) => s.x !== null && s.y !== null);
  const xs = placed.map((s) => s.x as number);
  const ys = placed.map((s) => s.y as number);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const out = new Map<string, Pt>();
  for (const s of placed) {
    out.set(s.id, {
      x: maxX > minX ? PX + (((s.x as number) - minX) / (maxX - minX)) * (W - 2 * PX) : W / 2,
      y: maxY > minY ? PY + (((s.y as number) - minY) / (maxY - minY)) * (H - 2 * PY - 20) : H / 2,
    });
  }
  // Sites sans coordonnées : répartis sur un cercle, sans leur prêter de position géographique.
  const rest = sites.filter((s) => !out.has(s.id));
  rest.forEach((s, i) => {
    const a = (i / Math.max(rest.length, 1)) * Math.PI * 2 - Math.PI / 2;
    out.set(s.id, { x: W / 2 + Math.cos(a) * (W / 2 - PX), y: H / 2 + Math.sin(a) * (H / 2 - PY) });
  });
  return out;
}

const radius = (n: number) => Math.min(13 + 5.5 * Math.sqrt(n), 36);

/** Courbe entre deux sites, décalée d'un côté : un aller et un retour ne se superposent jamais. */
function curve(a: Pt, b: Pt, ra: number, rb: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Plus le trajet est long, plus la courbe est ample : elle contourne les sites et leurs libellés situés entre les deux.
  const bend = Math.max(30, len * (len > 420 ? 0.38 : 0.3));
  const p0 = { x: a.x + ux * (ra + 7), y: a.y + uy * (ra + 7) };
  const p1 = { x: b.x - ux * (rb + 13), y: b.y - uy * (rb + 13) };
  // Normale (uy, -ux) : un trajet de gauche à droite passe au-dessus, son retour passe en dessous.
  const c = { x: (p0.x + p1.x) / 2 + uy * bend, y: (p0.y + p1.y) / 2 - ux * bend };
  const mid = { x: 0.25 * p0.x + 0.5 * c.x + 0.25 * p1.x, y: 0.25 * p0.y + 0.5 * c.y + 0.25 * p1.y };
  return { d: `M${p0.x.toFixed(1)},${p0.y.toFixed(1)} Q${c.x.toFixed(1)},${c.y.toFixed(1)} ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`, mid, out: { x: uy, y: -ux } };
}

const eventKey = (e: FarmEvent) => {
  try {
    if (e.eventTime && e.eventTime.precision !== 'UNKNOWN') return bounds(e.eventTime as TemporalValue).min;
  } catch {
    /* repli sur la réception */
  }
  return Date.parse(e.recordedAt);
};
const activate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fn();
  }
};
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

export function Constellation({ sites, moves, recent, animal, highlight, fresh, onSource }: Props) {
  const [view, setView] = useState<'schema' | 'liste'>('schema');
  const pos = useMemo(() => layout(sites), [sites]);
  const siteById = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);
  const name = (id: string) => siteById.get(id)?.name ?? id;

  const recentBySite = useMemo(() => {
    const m = new Map<string, FarmEvent[]>();
    for (const e of recent) for (const s of new Set(e.siteIds)) m.set(s, [...(m.get(s) ?? []), e]);
    return m;
  }, [recent]);

  const path = useMemo(() => (animal ? animal.timeline.filter((e) => e.type === 'MOVEMENT' && e.siteIds.length === 2).sort((a, b) => eventKey(a) - eventKey(b)) : []), [animal]);
  const observations = useMemo(() => (animal ? animal.timeline.filter((e) => e.type === 'OBSERVATION').sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt)) : []), [animal]);
  const related = useMemo(() => new Set(animal?.siteIds ?? []), [animal]);
  const showEdgeLabels = moves.length <= 10;
  const dim = (on: boolean) => (on ? 0.28 : 1);

  return (
    <section className="v-sky" aria-labelledby="sky-h">
      <div className="relative flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
        <div>
          <h2 id="sky-h" className="v-display text-[22px]">
            {animal ? `Parcours enregistré de ${animal.animal.tag}` : 'Constellation de l’exploitation'}
          </h2>
          <p className="text-[13.5px] text-[#b9c8c0]">{animal ? 'Ses déplacements, dans l’ordre, et ses observations. Le reste passe au second plan.' : 'Sites, animaux présents et déplacements enregistrés. Schéma à coordonnées fictives, pas une carte.'}</p>
        </div>
        <div className="hidden gap-2 sm:flex" role="group" aria-label="Mode d’affichage">
          <button className="v-tab" aria-pressed={view === 'schema'} onClick={() => setView('schema')}>
            Schéma
          </button>
          <button className="v-tab" aria-pressed={view === 'liste'} onClick={() => setView('liste')}>
            Liste
          </button>
        </div>
      </div>

      {sites.length === 0 ? (
        <p className="relative px-5 py-10 text-[#b9c8c0]">Aucun site n’est enregistré pour cette exploitation.</p>
      ) : (
        <>
          <div className={`relative ${view === 'schema' ? 'hidden sm:block' : 'hidden'}`}>
            <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="group" aria-label={animal ? `Schéma du parcours de ${animal.animal.tag}. Les mêmes informations figurent dans la vue Liste.` : 'Schéma des sites et des déplacements enregistrés. Les mêmes informations figurent dans la vue Liste.'}>
              <defs>
                <marker id="v-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="#8fa69c" />
                </marker>
                <marker id="v-arrow-hot" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="#f2b24a" />
                </marker>
              </defs>

              {/* Déplacements enregistrés, regroupés par trajet */}
              <g className="v-sky-dim" opacity={dim(!!animal) * (animal ? 0.6 : 1)}>
                {moves.map((m) => {
                  const a = pos.get(m.from);
                  const b = pos.get(m.to);
                  if (!a || !b) return null;
                  const c = curve(a, b, radius(siteById.get(m.from)?.animalsPresent ?? 0), radius(siteById.get(m.to)?.animalsPresent ?? 0));
                  return (
                    <g key={`${m.from}>${m.to}`}>
                      <title>{`${plural(m.count, 'déplacement enregistré', 'déplacements enregistrés')} : ${name(m.from)} vers ${name(m.to)}`}</title>
                      <path d={c.d} fill="none" stroke="#8fa69c" strokeWidth={Math.min(1.4 + m.count * 0.7, 5)} strokeLinecap="round" markerEnd="url(#v-arrow)" />
                      {/* Un trait = un déplacement enregistré (légende). Le nombre n'est écrit que s'il y en a plusieurs sur le même trajet. */}
                      {showEdgeLabels && !animal && m.count > 1 && (
                        <text x={c.mid.x + c.out.x * 15} y={c.mid.y + c.out.y * 15 + 5} textAnchor="middle" fontSize="15.5" className="v-halo v-sky-sub">
                          {m.count} déplacements
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>

              {/* Parcours de l'animal sélectionné : chaque déplacement est numéroté dans l'ordre des dates d'événement */}
              {path.map((e, i) => {
                const a = pos.get(e.siteIds[0]!);
                const b = pos.get(e.siteIds[1]!);
                if (!a || !b) return null;
                const c = curve(a, b, radius(siteById.get(e.siteIds[0]!)?.animalsPresent ?? 0), radius(siteById.get(e.siteIds[1]!)?.animalsPresent ?? 0));
                const label = `Déplacement ${i + 1} : ${name(e.siteIds[0]!)} vers ${name(e.siteIds[1]!)}, départ ${formatTemporal(e.eventTime as TemporalValue)}`;
                return (
                  <g key={e.ref} className="v-sky-mark" role="button" tabIndex={0} aria-label={`${label}. Ouvrir la source.`} onClick={() => onSource(e.ref)} onKeyDown={activate(() => onSource(e.ref))}>
                    <title>{label}</title>
                    <path d={c.d} fill="none" stroke="#f2b24a" strokeWidth="3.2" strokeLinecap="round" markerEnd="url(#v-arrow-hot)" />
                    <circle className="v-sky-ring" cx={c.mid.x} cy={c.mid.y} r="13" fill="#0e2b27" stroke="#f2b24a" strokeWidth="1.6" />
                    <text x={c.mid.x} y={c.mid.y + 5.5} textAnchor="middle" fontSize="15.5" fontWeight="700">
                      {i + 1}
                    </text>
                    <text x={c.mid.x} y={c.mid.y - 20} textAnchor="middle" fontSize="15" className="v-halo">
                      {formatTemporal(e.eventTime as TemporalValue)}
                    </text>
                  </g>
                );
              })}

              {/* Sites */}
              {sites.map((s) => {
                const p = pos.get(s.id);
                if (!p) return null;
                const r = radius(s.animalsPresent);
                const rec = recentBySite.get(s.id) ?? [];
                const isFresh = rec.some((e) => fresh.has(e.ref));
                const hot = rec.some((e) => highlight.has(e.ref));
                const faded = !!animal && !related.has(s.id);
                const label = `${s.name}, ${s.kind === 'FARM' ? 'élevage' : 'marché'} : ${plural(s.animalsPresent, 'animal avec une présence ouverte enregistrée', 'animaux avec une présence ouverte enregistrée')}${rec.length ? `, ${plural(rec.length, 'enregistrement reçu', 'enregistrements reçus')} depuis hier` : ''}`;
                return (
                  <g key={s.id} className="v-sky-site v-sky-dim" opacity={dim(faded)} role="button" tabIndex={0} aria-label={`${label}. Ouvrir la source.`} onClick={() => onSource(`SITE:${s.id}`)} onKeyDown={activate(() => onSource(`SITE:${s.id}`))}>
                    <title>{label}</title>
                    {hot && !animal && <circle cx={p.x} cy={p.y} r={r + 9} fill="none" stroke="#f2b24a" strokeWidth="1.4" strokeDasharray="3 5" />}
                    {s.kind === 'FARM' ? (
                      <circle className="v-sky-ring" cx={p.x} cy={p.y} r={r} fill="#f3efe2" stroke="#f3efe2" strokeWidth="1.5" />
                    ) : (
                      <>
                        <circle className="v-sky-ring" cx={p.x} cy={p.y} r={r} fill="#0e2b27" stroke="#f3efe2" strokeWidth="2.2" />
                        <circle cx={p.x} cy={p.y} r={Math.max(r - 6, 3)} fill="none" stroke="#f3efe2" strokeWidth="1" strokeDasharray="2 4" />
                      </>
                    )}
                    <text x={p.x} y={p.y + 6} textAnchor="middle" fontSize="17" fontWeight="700" style={{ fill: s.kind === 'FARM' ? '#0e2b27' : '#f3efe2' }}>
                      {s.animalsPresent}
                    </text>
                    <text x={p.x} y={p.y + r + 22} textAnchor="middle" fontSize="17" fontWeight="650" className="v-halo">
                      {s.name}
                    </text>
                    <text x={p.x} y={p.y + r + 41} textAnchor="middle" fontSize="14.5" className="v-halo v-sky-sub">
                      {s.animalsPresent === 0 ? 'aucun animal présent' : plural(s.animalsPresent, 'animal présent', 'animaux présents')}
                    </text>
                    {rec.length > 0 && !animal && (
                      <g>
                        {isFresh && <circle className="v-pulse" cx={p.x + r * 0.72 + 8} cy={p.y - r * 0.72 - 8} r="12" fill="none" stroke="#f2b24a" strokeWidth="2" />}
                        <circle cx={p.x + r * 0.72 + 8} cy={p.y - r * 0.72 - 8} r="12" fill="#f2b24a" />
                        <text x={p.x + r * 0.72 + 8} y={p.y - r * 0.72 - 3} textAnchor="middle" fontSize="15" fontWeight="700" style={{ fill: '#0e2b27' }}>
                          {rec.length}
                        </text>
                        <text x={p.x + r * 0.72 + 25} y={p.y - r * 0.72 - 3} fontSize="14.5" className="v-halo" style={{ fill: '#f2b24a' }}>
                          {isFresh ? 'nouveau' : 'depuis hier'}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}

              {/* Animal sélectionné : son lieu actuel enregistré est cerclé et nommé sous le site (jamais par-dessus les trajets) */}
              {animal &&
                (() => {
                  const p = animal.currentSiteId ? pos.get(animal.currentSiteId) : null;
                  if (!p) {
                    return (
                      <text x={24} y={H - 22} fontSize="16" className="v-halo" style={{ fill: '#f2b24a' }}>
                        {animal.animal.tag} : aucun lieu actuel enregistré. Les sites liés par un enregistrement restent en clair.
                      </text>
                    );
                  }
                  const r = radius(siteById.get(animal.currentSiteId!)?.animalsPresent ?? 0);
                  const x = p.x + (r + 9) * 0.72;
                  const y = p.y - (r + 9) * 0.72;
                  return (
                    <g aria-hidden="true">
                      <circle cx={p.x} cy={p.y} r={r + 7} fill="none" stroke="#f2b24a" strokeWidth="2.4" />
                      <rect x={x - 7} y={y - 7} width="14" height="14" transform={`rotate(45 ${x} ${y})`} fill="#f2b24a" stroke="#0e2b27" strokeWidth="1.5" />
                      <text x={p.x} y={p.y + r + 61} textAnchor="middle" fontSize="15.5" fontWeight="700" className="v-halo" style={{ fill: '#f2b24a' }}>
                        {animal.animal.tag} : présence ouverte ici
                      </text>
                    </g>
                  );
                })()}
              {animal &&
                observations.slice(0, 6).map((e, i) => {
                  const p = pos.get(e.siteIds[0] ?? '');
                  if (!p) return null;
                  const r = radius(siteById.get(e.siteIds[0]!)?.animalsPresent ?? 0);
                  const ang = (150 + i * 24) * (Math.PI / 180);
                  const x = p.x + Math.cos(ang) * (r + 26);
                  const y = p.y + Math.sin(ang) * (r + 26);
                  const isFresh = fresh.has(e.ref);
                  const label = `Observation sur ${animal.animal.tag}, ${formatTemporal(e.eventTime as TemporalValue)} : ${e.detail ?? ''}`;
                  return (
                    <g key={e.ref} className="v-sky-mark" role="button" tabIndex={0} aria-label={`${label}. Ouvrir la source.`} onClick={() => onSource(e.ref)} onKeyDown={activate(() => onSource(e.ref))}>
                      <title>{label}</title>
                      {isFresh && <rect className="v-pulse" x={x - 9} y={y - 9} width="18" height="18" fill="none" stroke="#f2b24a" strokeWidth="2" />}
                      <rect className="v-sky-ring" x={x - 7} y={y - 7} width="14" height="14" fill={isFresh || highlight.has(e.ref) ? '#f2b24a' : '#0e2b27'} stroke="#f2b24a" strokeWidth="1.8" />
                      {(i === 0 || isFresh) && (
                        <text x={x - 14} y={y + 5} textAnchor="end" fontSize="14.5" className="v-halo" style={{ fill: '#f2b24a' }}>
                          {isFresh ? 'nouvelle observation' : observations.length > 1 ? `${observations.length} observations` : 'observation'}
                        </text>
                      )}
                    </g>
                  );
                })}
            </svg>
            <p className="relative flex flex-wrap gap-x-5 gap-y-1 px-5 pb-4 text-[13.5px] text-[#b9c8c0]">
              <span>
                <span aria-hidden="true">● </span>élevage
              </span>
              <span>
                <span aria-hidden="true">◎ </span>marché
              </span>
              <span>
                <span aria-hidden="true">→ </span>déplacement enregistré (un trait par trajet)
              </span>
              {animal ? (
                <>
                  <span>
                    <span aria-hidden="true">◆ </span>animal sélectionné
                  </span>
                  <span>
                    <span aria-hidden="true">■ </span>observation
                  </span>
                </>
              ) : (
                <span>
                  <span aria-hidden="true" style={{ color: '#f2b24a' }}>
                    ●{' '}
                  </span>
                  enregistrements reçus depuis hier
                </span>
              )}
              <span>Le chiffre dans un site : animaux avec une présence ouverte enregistrée.</span>
              {!showEdgeLabels && <span>Nombre de déplacements : au survol d’un trait, ou dans la vue Liste.</span>}
            </p>
          </div>

          {/* Vue liste : mêmes informations, en texte. Seule vue sur téléphone. */}
          <div className={`relative px-5 pt-3 pb-5 ${view === 'liste' ? 'block' : 'block sm:hidden'}`}>
            {animal && (
              <div className="mb-4">
                <h3 className="text-[13px] font-bold tracking-wider text-[#b9c8c0] uppercase">Parcours de {animal.animal.tag}</h3>
                {path.length === 0 ? (
                  <p className="mt-1 text-[15px]">Aucun déplacement enregistré pour cet animal.</p>
                ) : (
                  <ol className="mt-1 space-y-1 text-[15px]">
                    {path.map((e, i) => (
                      <li key={e.ref}>
                        <button className="text-left underline decoration-[#f2b24a] underline-offset-4" onClick={() => onSource(e.ref)}>
                          {i + 1}. {name(e.siteIds[0]!)} vers {name(e.siteIds[1]!)}, départ {formatTemporal(e.eventTime as TemporalValue)}
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
                <p className="mt-2 text-[15px]">
                  Lieu actuel enregistré : <b>{animal.currentSiteId ? name(animal.currentSiteId) : 'aucun'}</b>. {plural(observations.length, 'observation enregistrée', 'observations enregistrées')}.
                </p>
              </div>
            )}
            <table className="w-full text-left text-[15px]">
              <caption className="sr-only">Sites de l’exploitation</caption>
              <thead>
                <tr className="text-[12.5px] tracking-wider text-[#b9c8c0] uppercase">
                  <th className="py-1.5 pr-3 font-bold">Site</th>
                  <th className="py-1.5 pr-3 font-bold">Type</th>
                  <th className="py-1.5 pr-3 text-right font-bold">Animaux présents</th>
                  <th className="py-1.5 text-right font-bold">Reçus depuis hier</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((s) => (
                  <tr key={s.id} className="border-t border-white/15" style={{ opacity: animal && !related.has(s.id) ? 0.55 : 1 }}>
                    <td className="py-2 pr-3">
                      <button className="text-left font-semibold underline decoration-white/40 underline-offset-4" onClick={() => onSource(`SITE:${s.id}`)}>
                        {s.name}
                      </button>
                    </td>
                    <td className="py-2 pr-3">{s.kind === 'FARM' ? 'Élevage' : 'Marché'}</td>
                    <td className="num py-2 pr-3 text-right">{s.animalsPresent}</td>
                    <td className="num py-2 text-right">{recentBySite.get(s.id)?.length ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h3 className="mt-4 text-[13px] font-bold tracking-wider text-[#b9c8c0] uppercase">Déplacements enregistrés, par trajet</h3>
            {moves.length === 0 ? (
              <p className="mt-1 text-[15px]">Aucun déplacement enregistré.</p>
            ) : (
              <ul className="mt-1 space-y-1 text-[15px]">
                {moves.map((m) => (
                  <li key={`${m.from}>${m.to}`}>
                    {name(m.from)} vers {name(m.to)} : {m.count}{' '}
                    <span className="text-[#b9c8c0]">
                      (
                      {m.refs.map((ref, i) => (
                        <span key={ref}>
                          {i > 0 && ', '}
                          <button className="num underline decoration-white/40 underline-offset-4" onClick={() => onSource(ref)}>
                            {ref.replace(/^REC:/, '')}
                          </button>
                        </span>
                      ))}
                      {m.count > m.refs.length ? ', …' : ''})
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-[13.5px] text-[#b9c8c0]">« Animaux présents » : animaux dont une présence ouverte est enregistrée sur le site. Ce n’est pas une position constatée.</p>
          </div>
        </>
      )}
    </section>
  );
}
