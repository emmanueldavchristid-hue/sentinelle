import { useCallback, useEffect, useRef, useState } from 'react';
import { BEACON_SOURCE_LABELS, BEACON_STATUS_LABELS, type Beacon } from '@sentinelle/contracts';
import { api, ApiFailure, NetworkError } from '../api';

/**
 * Page « balise de démonstration », ouverte sur un téléphone par le lien ou le QR code d'association.
 * Le téléphone joue le rôle d'un capteur de proximité : il mesure sa distance à un repère et la transmet au serveur.
 * - Les coordonnées GPS ne quittent jamais le téléphone. Sont envoyées : la distance au repère, sa précision, et la position
 *   RELATIVE au repère (mètres vers l'est et vers le nord), qui permet le suivi de la trajectoire sans dire où l'on est.
 * - Mode simulé : la distance est réglée à la main et transmise comme SIMULÉE, pour une démonstration en salle
 *   (en intérieur, le GPS ne distingue pas quelques mètres).
 * - L'état affiché est celui que le serveur a enregistré, pas une supposition du téléphone.
 */
interface Fix {
  lat: number;
  lon: number;
  acc: number;
  at: number;
}
const SEND_EVERY_MS = 3000;
const FIX_STALE_MS = 20_000;

function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** Position relative au repère, en mètres vers l'est et vers le nord (approximation plane, exacte à quelques centimètres sur ces distances). */
function offset(home: { lat: number; lon: number }, p: { lat: number; lon: number }): { east: number; north: number } {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  return { east: R * Math.cos(rad(home.lat)) * rad(p.lon - home.lon), north: R * rad(p.lat - home.lat) };
}
const round1 = (n: number) => Math.round(n * 10) / 10;
const DIRECTIONS: [string, number][] = [['Nord', 0], ['Nord-est', 45], ['Est', 90], ['Sud-est', 135], ['Sud', 180], ['Sud-ouest', 225], ['Ouest', 270], ['Nord-ouest', 315]];
const geoError = (code: number) =>
  code === 1 ? 'Position refusée. Autorisez la localisation pour ce site dans le navigateur, ou utilisez le mode simulé.' : code === 2 ? 'Position indisponible sur cet appareil pour l’instant.' : 'Le téléphone n’a pas obtenu de position à temps. Rapprochez-vous d’une fenêtre, ou utilisez le mode simulé.';
const clock = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { timeZone: 'Africa/Abidjan', hour12: false });

export function BeaconPage({ id, token }: { id: string; token: string }) {
  const headers = { 'x-device-token': token };
  const homeKey = `sentinelle.balise.${id}.repere`;
  const [beacon, setBeacon] = useState<Beacon | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [mode, setMode] = useState<'gps' | 'sim'>('gps');
  const [watching, setWatching] = useState(false);
  const [fix, setFix] = useState<Fix | null>(null);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const [home, setHome] = useState<Fix | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(homeKey) ?? 'null') as Fix | null;
    } catch {
      return null;
    }
  });
  const [sim, setSim] = useState(5);
  /** Direction simulée, en degrés depuis le nord (mode simulé uniquement). */
  const [simBearing, setSimBearing] = useState(45);
  const [sendMsg, setSendMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const live = useRef({ mode, fix, home, sim, simBearing });
  live.current = { mode, fix, home, sim, simBearing };
  const watchId = useRef<number | null>(null);

  useEffect(() => {
    document.title = `Balise ${id} · Sentinelle Vivant (démonstrateur)`;
  }, [id]);

  const refresh = useCallback(async () => {
    try {
      setBeacon(await api<Beacon>(`/api/devices/${encodeURIComponent(id)}`, { headers }));
      setFatal(null);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) setFatal('Cette balise est inconnue ou son lien n’est plus valable (la démonstration a peut-être été réinitialisée). Associez-en une nouvelle depuis l’écran « Mon élevage ».');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, token]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startGps = () => {
    if (!('geolocation' in navigator)) return setGeoMsg('Ce navigateur ne donne pas accès à la position. Utilisez le mode simulé.');
    if (!window.isSecureContext) return setGeoMsg('La position exige une page sécurisée (https). Ouvrez cette page par le lien https.');
    setGeoMsg(null);
    setWatching(true);
    watchId.current = navigator.geolocation.watchPosition(
      (p) => (setFix({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() }), setGeoMsg(null)),
      (e) => setGeoMsg(geoError(e.code)),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
    // Écran allumé si le navigateur le permet : un téléphone en veille n'envoie plus rien.
    void (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<unknown> } }).wakeLock?.request('screen').catch(() => {});
  };
  useEffect(
    () => () => {
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    },
    [],
  );

  const setHomeHere = () => {
    if (!fix) return;
    setHome(fix);
    try {
      localStorage.setItem(homeKey, JSON.stringify(fix));
    } catch {
      /* stockage indisponible : le repère vaut pour cette page seulement */
    }
  };

  // Envoi périodique de la mesure courante. Rien n'est envoyé en mode GPS tant que le repère n'est pas choisi.
  const stopped = beacon?.status === 'STOPPED';
  const active = !fatal && !stopped && (mode === 'sim' || (watching && !!home));
  useEffect(() => {
    if (!active) return;
    const tick = async () => {
      const s = live.current;
      const fresh = s.fix && Date.now() - s.fix.at < FIX_STALE_MS ? s.fix : null;
      let reading: Record<string, unknown>;
      // Instant observé : celui où le téléphone a obtenu sa position, pas celui de l'envoi. Une position un peu ancienne
      // renvoyée ici garde donc son heure réelle ; l'écran de l'éleveur montre l'instant observé et l'instant reçu.
      let observedAt = Date.now();
      if (s.mode === 'sim') {
        const a = (s.simBearing * Math.PI) / 180;
        reading = { source: 'SIMULATED', distanceM: s.sim, accuracyM: 0, eastM: round1(s.sim * Math.sin(a)), northM: round1(s.sim * Math.cos(a)) };
      } else if (fresh && s.home) {
        // Suivi GPS : la distance et la position relative viennent du même calcul, pour rester cohérentes entre elles.
        const o = offset(s.home, fresh);
        observedAt = fresh.at;
        reading = { source: 'PHONE_GPS', distanceM: round1(Math.hypot(o.east, o.north)), accuracyM: round1(Math.hypot(fresh.acc, s.home.acc)), eastM: round1(o.east), northM: round1(o.north) };
      } else reading = { source: 'PHONE_GPS', distanceM: null, accuracyM: null };
      try {
        await api(`/api/devices/${encodeURIComponent(id)}/readings`, { method: 'POST', headers, body: { ...reading, observedAt: new Date(observedAt).toISOString() } });
        setSendMsg({ tone: 'ok', text: `Dernier envoi à ${clock(new Date().toISOString())}.` });
      } catch (e) {
        setSendMsg({ tone: 'error', text: e instanceof NetworkError ? 'Envoi impossible : pas de connexion au serveur. La balise sera dite muette.' : e instanceof ApiFailure ? e.message : 'Envoi impossible.' });
      }
      void refresh();
    };
    void tick();
    const t = setInterval(tick, SEND_EVERY_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, id, token, refresh]);

  const distance = mode === 'gps' && fix && home ? haversine(home, fix) : null;
  const lowAccuracy = mode === 'gps' && fix && fix.acc > 25;
  const l = beacon?.latest ?? null;

  return (
    <div className="v-page min-h-screen">
      <div className="bg-encre px-3 py-1.5 text-center text-[13px] text-white" role="note">
        Démonstration · ce téléphone joue le rôle d’une balise · aucun capteur n’est posé sur un animal
      </div>
      {mode === 'sim' && !stopped && (
        <div className="bg-laterite-soft px-3 py-2 text-center text-[15px] font-bold text-laterite" role="status">
          DONNÉES SIMULÉES : la distance est réglée à la main, ce n’est pas une mesure
        </div>
      )}
      <main className="mx-auto max-w-xl space-y-5 p-4">
        <header>
          <p className="v-kicker">Balise de démonstration</p>
          <h1 className="v-display mt-1 text-[34px]">
            <span className="num">{id}</span>
          </h1>
          {beacon && (
            <p className="mt-1">
              Associée à <b className="num">{beacon.animalId ?? 'aucun animal'}</b> · seuil de la zone : <b>{beacon.radiusM} m</b>
            </p>
          )}
        </header>

        {fatal && (
          <p role="alert" className="border-l-[3px] border-danger pl-3">
            {fatal}
          </p>
        )}
        {stopped && (
          <p role="status" className="border-l-[3px] border-encre pl-3">
            Cette balise a été arrêtée depuis l’écran « Mon élevage ». Elle n’envoie plus rien.
          </p>
        )}

        {!fatal && !stopped && (
          <>
            <section className="border-t-2 border-encre pt-3" aria-labelledby="etat-h">
              <h2 id="etat-h" className="v-kicker">
                État enregistré par le serveur
              </h2>
              <p className="v-display mt-1 text-[30px]" aria-live="polite">
                {beacon ? BEACON_STATUS_LABELS[beacon.status] : 'Lecture…'}
              </p>
              {l ? (
                <p className="v-meta mt-1">
                  {l.distanceM === null ? 'Pas de position' : `${Math.round(l.distanceM)} m du repère`}
                  {l.accuracyM ? ` (précision ± ${Math.round(l.accuracyM)} m)` : ''} · observée à <span className="num">{clock(l.observedAt)}</span> · reçue à <span className="num">{clock(l.receivedAt)}</span> · {BEACON_SOURCE_LABELS[l.source]}
                </p>
              ) : (
                <p className="v-meta mt-1">Aucune mesure reçue pour l’instant.</p>
              )}
              {sendMsg && <p className={`mt-1 text-[14px] ${sendMsg.tone === 'error' ? 'text-danger' : 'text-encre-2'}`}>{sendMsg.text}</p>}
            </section>

            <div className="flex gap-2" role="group" aria-label="Origine de la distance">
              <button type="button" className="v-chip" aria-pressed={mode === 'gps'} onClick={() => setMode('gps')}>
                Position du téléphone (GPS)
              </button>
              <button type="button" className="v-chip" aria-pressed={mode === 'sim'} onClick={() => setMode('sim')}>
                Distance simulée
              </button>
            </div>

            {mode === 'gps' ? (
              <section className="space-y-3" aria-label="Mesure par GPS">
                <ol className="space-y-3">
                  <li>
                    <p className="font-semibold">1. Autoriser la position</p>
                    {!watching ? (
                      <button type="button" className="v-btn-go mt-1.5" onClick={startGps}>
                        Autoriser la position
                      </button>
                    ) : (
                      <p className="v-meta">{fix ? `Position reçue, précision ± ${Math.round(fix.acc)} m.` : 'En attente d’une première position…'}</p>
                    )}
                  </li>
                  <li>
                    <p className="font-semibold">2. Se placer au repère (près de l’ordinateur), puis le fixer</p>
                    <button type="button" className="v-btn-go mt-1.5" onClick={setHomeHere} disabled={!fix}>
                      {home ? 'Refixer le repère ici' : 'Fixer le repère ici'}
                    </button>
                    {home && <p className="v-meta mt-1">Repère fixé (précision ± {Math.round(home.acc)} m). Il reste sur ce téléphone.</p>}
                  </li>
                  <li>
                    <p className="font-semibold">3. S’éloigner : la position par rapport au repère est transmise toutes les 3 secondes</p>
                    <p className="v-figure mt-1 text-[44px]">{distance === null ? '— m' : `${Math.round(distance)} m`}</p>
                  </li>
                </ol>
                {geoMsg && (
                  <p role="alert" className="border-l-[3px] border-danger pl-3">
                    {geoMsg}
                  </p>
                )}
                {lowAccuracy && (
                  <p className="border-l-[3px] border-amber-line pl-3 text-amber">
                    Précision faible (± {Math.round(fix!.acc)} m). En intérieur, le GPS ne distingue pas quelques mètres : le serveur dira « incertain » plutôt que de trancher. Pour une démonstration en salle, utilisez la distance simulée.
                  </p>
                )}
              </section>
            ) : (
              <section className="space-y-2" aria-label="Distance simulée">
                <label htmlFor="sim" className="font-semibold">
                  Distance simulée au repère
                </label>
                <p className="v-figure text-[44px]">{sim} m</p>
                <input id="sim" type="range" min={0} max={200} step={1} value={sim} onChange={(e) => setSim(Number(e.target.value))} className="w-full" style={{ accentColor: 'var(--color-laterite)', height: 44 }} />
                <div className="flex flex-wrap gap-2">
                  {[5, Math.max(1, (beacon?.radiusM ?? 30) - 5), (beacon?.radiusM ?? 30) + 20, 120].map((v, i) => (
                    <button key={i} type="button" className="v-chip" onClick={() => setSim(v)}>
                      {v} m
                    </button>
                  ))}
                </div>
                <p className="font-semibold">Direction simulée</p>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Direction simulée">
                  {DIRECTIONS.map(([name, deg]) => (
                    <button key={name} type="button" className="v-chip" aria-pressed={simBearing === deg} onClick={() => setSimBearing(deg)}>
                      {name}
                    </button>
                  ))}
                </div>
                <p className="v-meta">Chaque envoi est marqué « distance simulée » dans les données, les réponses et les preuves.</p>
              </section>
            )}

            <p className="v-meta border-t border-filet pt-3">
              Gardez cette page ouverte et l’écran allumé : un téléphone en veille n’envoie plus rien, et la balise est alors dite « muette ». Les coordonnées GPS restent sur ce téléphone ; seules la distance et la position par rapport au repère (mètres vers l’est et vers le nord) sont transmises.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
