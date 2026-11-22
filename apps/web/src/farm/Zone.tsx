import { beaconName, bearingOf, BEACON_STATUS_LABELS, type Beacon } from '@sentinelle/contracts';

/**
 * Zone autour du repère : la vue « déplacement » des balises de démonstration.
 * Le repère (le point fixé depuis le téléphone, par exemple près de l'ordinateur) est au centre. Chaque balise est placée à
 * la DISTANCE que son téléphone calcule à partir de son GPS : ce n'est pas une mesure radio de proximité.
 * La direction n'est pas mesurée : chaque balise garde un rayon fixe, choisi seulement pour la lisibilité.
 * Les points plus pâles sur le même rayon sont ses mesures précédentes : on voit si elle s'éloigne ou revient.
 * Un trait le long du rayon montre la précision annoncée de la dernière mesure.
 */
const W = 720;
const H = 500;
const CX = 318;
const CY = 252;
const RMAX = 196; // rayon, en unités du dessin, de la distance la plus grande représentée

export function Zone({ beacons, simulated, onSource }: { beacons: Beacon[]; simulated: boolean; onSource: (ref: string) => void }) {
  const active = beacons.filter((b) => b.status !== 'STOPPED');
  if (!active.length) return null;
  const radius = Math.max(...active.map((b) => b.radiusM));
  // Échelle : le seuil le plus grand occupe 45 % du rayon ; au-delà de 2,2 fois le seuil, la balise est dessinée au bord.
  // Suivi GPS : l'échelle s'élargit pour que toute la trajectoire soit dessinée à sa vraie distance (rien n'est écrasé sur le bord).
  const reach = Math.max(0, ...active.flatMap((b) => [...(b.track ?? []).map((t) => Math.hypot(t.eastM, t.northM)), b.latest?.eastM != null && b.latest.northM != null ? Math.hypot(b.latest.eastM, b.latest.northM) : 0]));
  const far = Math.max(radius * 2.2, reach * 1.18);
  // L'échelle se lit sur la diagonale nord-ouest : les libellés des balises s'écrivent vers la droite, ils ne s'y croisent pas.
  const tick = (m: number, gap: number) => ({ x: CX - scale(m) * 0.7071 - gap, y: CY - scale(m) * 0.7071 - gap });
  const scale = (m: number) => (Math.min(m, far) / far) * RMAX;
  const rings = [...new Set(active.map((b) => b.radiusM))];
  /** Au moins une balise transmet sa position relative : la carte montre alors de vraies directions (le nord est en haut). */
  const tracked = active.some((b) => b.latest?.eastM !== null && b.latest?.eastM !== undefined);
  const gps = active.some((b) => b.latest?.source === 'PHONE_GPS' && b.latest.eastM !== null && b.latest.eastM !== undefined);
  /** Place un point d'après sa position relative au repère : la direction est la vraie, la distance suit l'échelle de la carte. */
  const place = (east: number, north: number) => {
    const d = Math.hypot(east, north);
    const r = scale(d);
    return d < 0.01 ? { x: CX, y: CY } : { x: CX + (east / d) * r, y: CY - (north / d) * r };
  };

  return (
    <section className="v-sky" aria-labelledby="zone-h">
      <div className="relative px-5 pt-4">
        <h2 id="zone-h" className="v-display text-[22px]">
          {/* « GPS » n'est écrit que si une position vient réellement du GPS d'un téléphone : une position réglée à la main n'en est pas une. */}
          {gps ? 'Suivi GPS autour du repère' : tracked ? 'Suivi autour du repère' : 'Zone autour du repère'}
        </h2>
        <p className="text-[13.5px] text-[#b9c8c0]">
          {tracked
            ? `Chaque balise est placée à sa position par rapport au repère (distance et direction)${gps ? ', calculée par son téléphone à partir de son GPS' : ', réglée à la main sur le téléphone'}. Le nord est en haut. Aucune coordonnée géographique n’est transmise.`
            : 'Chaque balise est placée à la distance que son téléphone calcule depuis le repère. La direction n’est pas mesurée.'}
        </p>
        {simulated && <p className="mt-1 inline-block bg-[#f2b24a] px-2 py-0.5 text-[13.5px] font-bold text-[#0e2b27]">DONNÉES SIMULÉES</p>}
      </div>
      {/* Petit écran : les mêmes mesures, en liste. */}
      <ul className="v-zone-list relative sm:hidden">
        {active.map((b) => {
          const l = b.latest;
          return (
            <li key={b.id} data-out={b.status === 'OUTSIDE' ? 'true' : undefined}>
              <span className="v-figure">{l?.distanceM != null ? `${Math.round(l.distanceM)} m` : '?'}</span>
              <span>
                <b className="block text-[17px]">{beaconName(b)}</b>
                <span className="block text-[14.5px] text-[#b9c8c0]">
                  {bearingOf(l?.eastM, l?.northM, l?.accuracyM) ? `au ${bearingOf(l?.eastM, l?.northM, l?.accuracyM)} du repère · ` : ''}
                  {BEACON_STATUS_LABELS[b.status].toLowerCase()} · seuil {b.radiusM} m
                  {l ? ` · ${l.source === 'SIMULATED' ? 'distance simulée' : `GPS du téléphone${l.accuracyM ? `, ± ${Math.round(l.accuracyM)} m` : ''}`}` : ''}
                  {b.silentSeconds !== null && b.silentSeconds >= 8 ? ` · il y a ${b.silentSeconds < 90 ? `${b.silentSeconds} s` : `${Math.round(b.silentSeconds / 60)} min`}` : ''}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      <svg viewBox={`0 0 ${W} ${H}`} className="relative hidden h-auto w-full sm:block" role="group" aria-label="Schéma de la zone : distance de chaque balise au repère. Les mêmes informations figurent dans la liste des balises.">
        {/* Graduations : la moitié et le double du seuil le plus grand, pour lire une distance d'un coup d'œil. */}
        {[0.5, 2].map((k) => (
          <g key={k}>
            <circle cx={CX} cy={CY} r={scale(radius * k)} fill="none" stroke="#8fa69c" strokeWidth="1" strokeDasharray="1 7" opacity="0.75" />
            {/* L'échelle se lit en haut, à la verticale du repère : aucun rayon de balise ne passe par là. */}
            <text x={tick(radius * k, 5).x} y={tick(radius * k, 5).y} textAnchor="end" fontSize="13.5" className="v-halo v-sky-sub">
              {Math.round(radius * k)} m
            </text>
          </g>
        ))}
        {/* Seuil(s) de la zone */}
        {rings.map((r) => (
          <g key={r}>
            <circle cx={CX} cy={CY} r={scale(r)} fill="rgb(243 239 226 / 0.05)" stroke="#f3efe2" strokeWidth="1.6" strokeDasharray="6 6" />
            <text x={tick(r, 6).x} y={tick(r, 6).y} textAnchor="end" fontSize="15.5" fontWeight="650" className="v-halo">
              seuil {r} m
            </text>
          </g>
        ))}
        {/* Nord : affiché seulement quand la direction est réellement mesurée. */}
        {tracked && (
          <g aria-hidden="true">
            <path d={`M ${W - 46} 62 l 9 22 l -9 -6 l -9 6 z`} fill="#f3efe2" />
            <text x={W - 46} y={48} textAnchor="middle" fontSize="15" fontWeight="700" className="v-halo">
              N
            </text>
          </g>
        )}
        {/* Repère */}
        <rect x={CX - 9} y={CY - 9} width="18" height="18" fill="#f3efe2" />
        <text x={CX} y={CY + 30} textAnchor="middle" fontSize="15.5" fontWeight="650" className="v-halo">
          Repère
        </text>

        {active.map((b, i) => {
          // Rayon fixe par balise, réparti autour du repère (aucune signification géographique).
          const ang = ((-35 + (i * 360) / Math.max(active.length, 3)) * Math.PI) / 180;
          const ux = Math.cos(ang);
          const uy = Math.sin(ang);
          const l = b.latest;
          const at = (m: number) => ({ x: CX + ux * scale(m), y: CY + uy * scale(m) });
          const name = beaconName(b);
          const label = `Balise ${name} : ${BEACON_STATUS_LABELS[b.status].toLowerCase()}${l?.distanceM != null ? `, ${Math.round(l.distanceM)} m du repère` : ''}`;
          if (!l || l.distanceM === null) {
            const p = { x: CX + ux * (RMAX + 26), y: CY + uy * (RMAX + 26) };
            return (
              <g key={b.id} className="v-sky-mark" role="button" tabIndex={0} aria-label={`${label}. Ouvrir la source.`} onClick={() => onSource(`DEVICE:${b.id}`)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSource(`DEVICE:${b.id}`)}>
                <title>{label}</title>
                <text x={p.x} y={p.y} textAnchor={ux < -0.2 ? 'end' : ux > 0.2 ? 'start' : 'middle'} fontSize="15.5" className="v-halo v-sky-sub">
                  {name} : {BEACON_STATUS_LABELS[b.status].toLowerCase()}
                </text>
              </g>
            );
          }
          // Suivi GPS : la balise est à sa vraie direction ; sinon elle garde un rayon fixe, sans signification géographique.
          const real = l.eastM !== null && l.eastM !== undefined && l.northM !== null && l.northM !== undefined;
          const p = real ? place(l.eastM as number, l.northM as number) : at(l.distanceM);
          const path = real ? (b.track ?? []).map((t) => place(t.eastM, t.northM)) : [];
          const dir = bearingOf(l.eastM, l.northM, l.accuracyM);
          const beyond = l.distanceM > far;
          const out = b.status === 'OUTSIDE';
          const stale = b.status === 'SILENT';
          const color = out ? '#f2b24a' : '#f3efe2';
          const acc = l.accuracyM ?? 0;
          const a0 = at(Math.max(0, l.distanceM - acc));
          const a1 = at(l.distanceM + acc);
          const trail = b.recent.slice(1).filter((r) => r.distanceM !== null);
          const side = (real ? p.x < CX - 40 : ux < -0.2) ? 'end' : 'start';
          const tx = p.x + (side === 'end' ? -18 : 18);
          return (
            <g key={b.id} className="v-sky-mark" opacity={stale ? 0.55 : 1} role="button" tabIndex={0} aria-label={`${label}. Ouvrir la source.`} onClick={() => onSource(`DEVICE:${b.id}`)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSource(`DEVICE:${b.id}`)}>
              <title>{label}</title>
              {real ? (
                <>
                  {/* Trajectoire enregistrée : les positions reçues, reliées dans l'ordre. Rien n'est interpolé au-delà. */}
                  {path.length > 1 && <polyline points={path.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ')} fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" opacity="0.7" />}
                  {path.slice(0, -1).map((q, k) => (
                    <circle key={k} cx={q.x} cy={q.y} r="2.6" fill={color} opacity="0.55" />
                  ))}
                  {/* Précision annoncée : un disque autour de la dernière position. */}
                  {acc > 0 && <circle cx={p.x} cy={p.y} r={Math.max(6, scale(acc))} fill={color} opacity="0.14" />}
                </>
              ) : (
                <>
                  <line x1={CX} y1={CY} x2={CX + ux * RMAX} y2={CY + uy * RMAX} stroke="#8fa69c" strokeWidth="1" strokeDasharray="2 6" />
                  {/* Mesures précédentes, de plus en plus pâles */}
                  {trail.map((r, k) => {
                    const q = at(r.distanceM as number);
                    return <circle key={k} cx={q.x} cy={q.y} r={4.5 - k * 0.6} fill={color} opacity={0.5 - k * 0.1} />;
                  })}
                  {acc > 0 && <line x1={a0.x} y1={a0.y} x2={a1.x} y2={a1.y} stroke={color} strokeWidth="5" strokeLinecap="round" opacity="0.4" />}
                </>
              )}
              {out && <circle className="v-pulse" cx={p.x} cy={p.y} r="12" fill="none" stroke="#f2b24a" strokeWidth="2" />}
              <circle className="v-sky-ring" cx={p.x} cy={p.y} r="11" fill={color} stroke="#0e2b27" strokeWidth="2" />
              <text x={tx} y={p.y - 3} textAnchor={side} fontSize="17.5" fontWeight="700" className="v-halo" style={{ fill: color }}>
                {name}
              </text>
              <text x={tx} y={p.y + 16} textAnchor={side} fontSize="15" className="v-halo v-sky-sub">
                {beyond ? 'plus de ' : ''}
                {Math.round(l.distanceM)} m{dir ? ` au ${dir}` : ''} · {BEACON_STATUS_LABELS[b.status].toLowerCase()}
              </text>
              {/* D'où vient la mesure, sa précision, et son ancienneté si la balise ne transmet plus. */}
              <text x={tx} y={p.y + 34} textAnchor={side} fontSize="13.5" className="v-halo v-sky-sub">
                {l.source === 'SIMULATED' ? 'distance simulée' : `GPS du téléphone${acc > 0 ? `, ± ${Math.round(acc)} m` : ''}`}
                {b.silentSeconds !== null && (stale || b.silentSeconds >= 8) ? ` · ${stale ? 'dernière mesure ' : ''}il y a ${b.silentSeconds < 90 ? `${b.silentSeconds} s` : `${Math.round(b.silentSeconds / 60)} min`}` : ''}
              </text>
            </g>
          );
        })}
      </svg>
      {/* Légende : ce que chaque signe veut dire, sans avoir à ouvrir une preuve. */}
      <ul className="relative hidden flex-wrap gap-x-5 gap-y-1 px-5 pb-4 text-[13.5px] text-[#b9c8c0] sm:flex">
        <li>
          <span aria-hidden="true">■</span> repère fixé depuis le téléphone
        </li>
        <li>
          <span aria-hidden="true">┄</span> seuil de la zone
        </li>
        <li>
          <span aria-hidden="true">●</span> dernière position, <span aria-hidden="true">•</span> {tracked ? 'trajectoire enregistrée' : 'mesures précédentes'}
        </li>
        <li>
          <span aria-hidden="true">▬</span> précision annoncée
        </li>
        <li className="text-[#f2b24a]">
          <span aria-hidden="true">●</span> hors de la zone
        </li>
      </ul>
    </section>
  );
}
