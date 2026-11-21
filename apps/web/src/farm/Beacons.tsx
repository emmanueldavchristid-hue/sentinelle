import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { BEACON_STATUS_LABELS, type Beacon, type BeaconsData, type ToolResult } from '@sentinelle/contracts';
import { api, ApiFailure, errorMessage, type Session } from '../api';
import { fmtState, SourceChip } from './parts';

/**
 * Balises de démonstration sur l'écran de l'éleveur : association (lien et QR code pour le téléphone), suivi, arrêt.
 * Le libellé reste « balise de démonstration : un téléphone », jamais « capteur connecté à un animal ».
 */
const GLYPH: Record<Beacon['status'], string> = { INSIDE: '●', OUTSIDE: '▲', UNCERTAIN: '?', NO_FIX: '∅', NEVER: '○', SILENT: '…', STOPPED: '■' };
const TONE: Record<Beacon['status'], string> = { INSIDE: 'text-paturage', OUTSIDE: 'text-danger', UNCERTAIN: 'text-amber', NO_FIX: 'text-amber', NEVER: 'text-encre-2', SILENT: 'text-amber', STOPPED: 'text-encre-2' };

/** Alerte dans l'application quand une balise est hors de sa zone. Aucune notification externe n'est envoyée. */
export function BeaconAlert({ result, onSource, onAsk }: { result: ToolResult<BeaconsData> | null; onSource: (ref: string) => void; onAsk: () => void }) {
  const out = result?.data.beacons.filter((b) => result.data.alerts.includes(b.id)) ?? [];
  if (!out.length) return null;
  return (
    <div role="alert" className="mb-4 border-2 border-danger bg-danger-soft px-4 py-3">
      <p className="v-field-flag text-danger">▲ Balise hors de sa zone{result!.data.simulated ? ' · données simulées' : ''}</p>
      {out.map((b) => (
        <p key={b.id} className="mt-1 text-[16.5px]">
          La balise de démonstration <b className="num">{b.id}</b>
          {b.animalId ? (
            <>
              , associée à <b className="num">{b.animalId}</b>,
            </>
          ) : null}{' '}
          est à <b>{b.latest?.distanceM === null || !b.latest ? '?' : Math.round(b.latest.distanceM)} m</b> du repère, pour un seuil de {b.radiusM} m
          {b.outsideSince ? (
            <>
              , depuis <span className="num">{fmtState(b.outsideSince).slice(11)}</span>
            </>
          ) : null}
          . <SourceChip sourceRef={`DEVICE:${b.id}`} onSource={onSource} />
        </p>
      ))}
      <p className="v-meta mt-1">La balise mesure sa propre distance, pas la position de l’animal. Alerte affichée dans l’application uniquement.</p>
      <button type="button" className="btn btn-sm mt-2" onClick={onAsk}>
        Demander : quel animal s’est éloigné ?
      </button>
    </div>
  );
}

export function BeaconsPanel({
  session,
  result,
  error,
  defaultAnimal,
  onChanged,
  onSource,
}: {
  session: Session | null;
  result: ToolResult<BeaconsData> | null;
  error: unknown;
  defaultAnimal: string | null;
  onChanged: () => void;
  onSource: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [animalId, setAnimalId] = useState(defaultAnimal ?? '');
  const [radius, setRadius] = useState(30);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [paired, setPaired] = useState<{ id: string; url: string; qr: string | null } | null>(null);
  useEffect(() => {
    if (defaultAnimal) setAnimalId(defaultAnimal);
  }, [defaultAnimal]);

  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  const beacons = result?.data.beacons ?? [];
  const active = beacons.filter((b) => b.status !== 'STOPPED');

  const pair = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (!animalId.trim()) return setMsg('Indiquez l’animal auquel associer la balise.');
    setBusy(true);
    try {
      const r = await api<{ id: string; token: string }>('/api/farm/devices', { method: 'POST', session, body: { animalId: animalId.trim(), radiusM: radius } });
      const url = `${window.location.origin}/#/balise/${encodeURIComponent(r.id)}/${encodeURIComponent(r.token)}`;
      const qr = await QRCode.toDataURL(url, { margin: 1, width: 220, errorCorrectionLevel: 'M' }).catch(() => null);
      setPaired({ id: r.id, url, qr });
      setOpen(false);
      onChanged();
    } catch (err) {
      setMsg(err instanceof ApiFailure && err.body.fields ? Object.values(err.body.fields as Record<string, string>).join(' ') : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const stop = async (id: string) => {
    try {
      await api(`/api/farm/devices/${encodeURIComponent(id)}/stop`, { method: 'POST', session });
      if (paired?.id === id) setPaired(null);
      onChanged();
    } catch (err) {
      setMsg(errorMessage(err));
    }
  };

  return (
    <section aria-labelledby="bal-h">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b-2 border-encre pb-2">
        <div>
          <p className="v-kicker">Proximité · démonstration</p>
          <h2 id="bal-h" className="v-display mt-0.5 text-[26px]">
            Balises
          </h2>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          Associer une balise
        </button>
      </div>
      <p className="v-meta mt-2 max-w-[70ch]">Un téléphone joue le rôle d’un capteur de proximité : il transmet sa distance à un repère. Aucun capteur n’est posé sur un animal. Actualisé toutes les 4 secondes tant qu’une balise est suivie.</p>
      {result?.data.simulated && (
        <p role="status" className="mt-2 bg-laterite-soft px-3 py-2 font-bold text-laterite">
          DONNÉES SIMULÉES : au moins une balise transmet une distance réglée à la main, pas une mesure.
        </p>
      )}

      {open && (
        <form className="v-draft mt-3 space-y-3" onSubmit={pair} noValidate aria-label="Associer une balise de démonstration">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="field">
              <label htmlFor="bal-animal">Animal associé</label>
              <input id="bal-animal" className="input num" value={animalId} onChange={(e) => setAnimalId(e.target.value)} placeholder="ex. B-071" autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="bal-radius">Seuil de la zone, en mètres</label>
              <input id="bal-radius" className="input num" type="number" min={5} max={500} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
            </div>
          </div>
          <p className="v-meta">Au-delà du seuil, et seulement si la précision de la mesure le permet, la balise est dite hors de sa zone.</p>
          <div className="flex flex-wrap gap-2">
            <button className="v-btn-go" style={{ minHeight: 44 }} disabled={busy}>
              {busy ? 'Association…' : 'Créer le lien de la balise'}
            </button>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Annuler
            </button>
          </div>
        </form>
      )}
      {msg && (
        <p role="alert" className="mt-2 border-l-[3px] border-danger pl-3">
          {msg}
        </p>
      )}

      {paired && (
        <div className="v-update mt-3">
          <p className="v-field-flag text-laterite">Balise {paired.id} créée : ouvrez ce lien sur le téléphone</p>
          <div className="mt-2 flex flex-wrap items-start gap-4">
            {paired.qr && <img src={paired.qr} width={180} height={180} alt={`QR code du lien de la balise ${paired.id}`} className="border border-filet bg-white" />}
            <div className="min-w-0 flex-1">
              <p className="num text-[13px] break-all">{paired.url}</p>
              <p className="v-meta mt-2">Ce lien contient le jeton de la balise : il n’est affiché qu’ici, une seule fois. Ne le montrez pas à l’écran partagé plus longtemps que nécessaire.</p>
              {local && (
                <p className="mt-2 border-l-[3px] border-amber-line pl-3 text-amber">
                  Cette adresse (localhost) n’est pas joignable depuis un téléphone. Ouvrez l’application par son lien https, puis associez la balise de nouveau : le QR code portera alors la bonne adresse.
                </p>
              )}
              <button type="button" className="btn btn-sm mt-2" onClick={() => setPaired(null)}>
                Masquer le lien
              </button>
            </div>
          </div>
        </div>
      )}

      {error !== null && !result ? (
        <p role="alert" className="mt-3 border-l-[3px] border-danger pl-3">
          Les balises n’ont pas pu être lues. {errorMessage(error)}
        </p>
      ) : beacons.length === 0 ? (
        <p className="mt-3 border border-dashed border-filet px-4 py-4 text-encre-2">Aucune balise associée. Rien n’est mesuré automatiquement.</p>
      ) : (
        <ul className="mt-1">
          {beacons.map((b) => (
            <li key={b.id} className="flex flex-wrap items-start justify-between gap-3 border-b border-filet py-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  <span className={`v-field-flag ${TONE[b.status]}`}>
                    <span aria-hidden="true">{GLYPH[b.status]} </span>
                    {BEACON_STATUS_LABELS[b.status]}
                  </span>{' '}
                  · <span className="num">{b.id}</span>
                  {b.animalId ? (
                    <>
                      {' '}
                      · associée à <span className="num">{b.animalId}</span>
                    </>
                  ) : null}
                </p>
                <p className="v-meta mt-0.5">
                  {b.latest
                    ? `${b.latest.distanceM === null ? 'Pas de position' : `${Math.round(b.latest.distanceM)} m du repère`}${b.latest.accuracyM ? ` (± ${Math.round(b.latest.accuracyM)} m)` : ''} · seuil ${b.radiusM} m · observée à ${fmtState(b.latest.observedAt).slice(11)} · reçue à ${fmtState(b.latest.receivedAt).slice(11)} · ${b.latest.source === 'SIMULATED' ? 'distance SIMULÉE' : 'GPS du téléphone'}`
                    : `Seuil ${b.radiusM} m · aucune mesure reçue`}
                  {b.status === 'SILENT' ? ` · muette depuis ${b.silentSeconds} s (cela ne dit pas où elle se trouve)` : ''}
                </p>
                <p className="mt-1">
                  <SourceChip sourceRef={`DEVICE:${b.id}`} onSource={onSource} />
                </p>
              </div>
              {b.status !== 'STOPPED' && (
                <button type="button" className="btn btn-sm" onClick={() => stop(b.id)}>
                  Arrêter
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {active.length > 0 && result && (
        <p className="v-meta mt-2">
          Données lues à <span className="num">{fmtState(result.asOf).slice(11)}</span>.
        </p>
      )}
    </section>
  );
}
