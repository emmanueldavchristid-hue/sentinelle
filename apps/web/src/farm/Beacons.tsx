import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { beaconName, BEACON_STATUS_LABELS, type Beacon, type BeaconsData, type IncidentSummary, type ToolResult } from '@sentinelle/contracts';
import { api, ApiFailure, errorMessage, type Session } from '../api';
import { fmtState, SourceChip } from './parts';

/**
 * Balises de démonstration sur l'écran de l'éleveur : association (lien et QR code pour le téléphone), suivi, arrêt.
 * Le libellé reste « balise de démonstration : un téléphone », jamais « capteur connecté à un animal ».
 */
const GLYPH: Record<Beacon['status'], string> = { INSIDE: '●', OUTSIDE: '▲', UNCERTAIN: '?', NO_FIX: '∅', NEVER: '○', SILENT: '…', STOPPED: '■' };
const TONE: Record<Beacon['status'], string> = { INSIDE: 'text-paturage', OUTSIDE: 'text-danger', UNCERTAIN: 'text-amber', NO_FIX: 'text-amber', NEVER: 'text-encre-2', SILENT: 'text-amber', STOPPED: 'text-encre-2' };

/** Un incident terminé reste proposé à la lecture pendant ce délai, sous une forme calme. */
const CLOSED_SHOWN_MS = 30 * 60_000;

/** Ce que le service d'envoi a réellement répondu pour l'e-mail d'alerte d'un incident. Rien si aucun envoi n'a été tenté. */
function EmailLine({ email }: { email: IncidentSummary['email'] }) {
  if (!email) return null;
  const at = email.at ? fmtState(email.at).slice(11, 16) : null;
  return (
    <p className="v-meta mt-1.5">
      {email.status === 'SENT' && (
        <>
          ✉ E-mail d’alerte accepté par {email.provider ?? 'le service d’envoi'}
          {at ? (
            <>
              {' '}
              à <span className="num">{at}</span>
            </>
          ) : null}
          {email.to ? `, pour ${email.to}` : ''}. Un seul message par épisode.
        </>
      )}
      {email.status === 'FAILED' && <>✉ E-mail d’alerte non parti. {email.error}</>}
      {email.status === 'SENDING' && <>✉ E-mail d’alerte en cours d’envoi…</>}
    </p>
  );
}

/**
 * Bandeau d'incident : la distance mesurée est le fait, elle est donc le plus grand signe. « Comprendre avec Sentinelle »
 * est l'action principale ; la question libre reste à côté. Une fois l'épisode terminé, le bandeau reste, sans ton d'urgence.
 */
export function BeaconAlert({
  result,
  detailed,
  onSource,
  onAsk,
  onUnderstand,
}: {
  result: ToolResult<BeaconsData> | null;
  detailed: boolean;
  onSource: (ref: string) => void;
  onAsk: () => void;
  /** Ouvre l'assistant sur l'incident enregistré : il en relit lui-même les faits. */
  onUnderstand: (incidentId: string) => void;
}) {
  const out = result?.data.beacons.filter((b) => result.data.alerts.includes(b.id)) ?? [];
  const incidents = result?.data.incidents ?? [];
  const openFor = (deviceId: string) => incidents.find((i) => i.deviceId === deviceId && !i.closedAt);
  // Incident encore ouvert alors que la balise n'est plus mesurée hors zone : elle ne transmet plus, ou sa mesure est incertaine.
  // L'incident n'est pas terminé pour autant : il reste affiché, avec la dernière mesure connue et son ancienneté.
  const waiting = !out.length ? incidents.find((i) => !i.closedAt) : undefined;
  const waitingBeacon = waiting ? result?.data.beacons.find((b) => b.id === waiting.deviceId) : undefined;
  if (waiting && waitingBeacon) {
    const l = waitingBeacon.latest;
    const age = waitingBeacon.silentSeconds;
    return (
      <div role="status" className="v-alert" data-tone="wait">
        <p className="v-alert-figure">
          {l?.distanceM != null ? Math.round(l.distanceM) : '?'}&nbsp;m<small>dernière mesure</small>
        </p>
        <div>
          <p className="v-field-flag text-amber">Incident ouvert · balise {BEACON_STATUS_LABELS[waitingBeacon.status].toLowerCase()}</p>
          <p className="v-alert-text mt-1">
            La balise <b className="num">{beaconName(waitingBeacon)}</b>
            {waitingBeacon.animalId ? (
              <>
                , associée à <b className="num">{waitingBeacon.animalId}</b>,
              </>
            ) : null}{' '}
            {waitingBeacon.status === 'SILENT' ? (
              <>ne transmet plus{age !== null ? ` depuis ${age < 90 ? `${age} secondes` : `${Math.round(age / 60)} minutes`}` : ''}. Sa dernière mesure la plaçait hors de sa zone. Le silence d’une balise ne dit pas où elle se trouve.</>
            ) : (
              <>n’a pas été mesurée de nouveau dans sa zone : sa dernière mesure ne permet pas de conclure.</>
            )}
          </p>
          <EmailLine email={waiting.email} />
          <button type="button" className="btn btn-sm mt-3" onClick={() => onUnderstand(waiting.id)}>
            Comprendre avec Sentinelle
          </button>
        </div>
      </div>
    );
  }
  if (!out.length) {
    // Plus d'alerte en cours : l'incident terminé récemment reste accessible, sans ton d'urgence.
    const closed = result ? incidents.find((i) => i.closedAt && Date.parse(result.asOf) - Date.parse(i.closedAt) < CLOSED_SHOWN_MS) : undefined;
    if (!closed) return null;
    return (
      <div role="status" className="v-alert" data-tone="calm">
        <p className="v-alert-figure">
          <span className="num">{fmtState(closed.closedAt!).slice(11, 16)}</span>
          <small>retour dans la zone</small>
        </p>
        <div>
          <p className="v-field-flag text-paturage">Incident terminé</p>
          <p className="v-alert-text mt-1">
            La balise <b className="num">{closed.label}</b>
            {closed.animalId ? (
              <>
                , associée à <b className="num">{closed.animalId}</b>,
              </>
            ) : null}{' '}
            n’est plus mesurée hors de sa zone depuis <span className="num">{fmtState(closed.closedAt!).slice(11, 16)}</span>.
          </p>
          <EmailLine email={closed.email} />
          <button type="button" className="btn btn-sm mt-3" onClick={() => onUnderstand(closed.id)}>
            Comprendre avec Sentinelle
          </button>
        </div>
      </div>
    );
  }
  const first = out[0]!;
  const distance = first.latest?.distanceM;
  return (
    <div role="alert" className="v-alert">
      <p className="v-alert-figure">
        {out.length === 1 ? (
          <>
            {distance === null || distance === undefined ? '?' : Math.round(distance)}&nbsp;m
            <small>seuil {first.radiusM} m</small>
          </>
        ) : (
          <>
            {out.length}
            <small>balises hors zone</small>
          </>
        )}
      </p>
      <div>
        {/* « Données simulées » ne s'affiche que si la balise hors zone transmet elle-même une distance simulée. */}
        <p className="v-field-flag text-danger">▲ Balise hors de sa zone{out.some((b) => b.latest?.source === 'SIMULATED') ? ' · données simulées' : ''}</p>
        {out.map((b) => (
          <div key={b.id} className="mt-1">
            <p className="v-alert-text">
              La balise{detailed ? ' de démonstration' : ''} <b className="num">{beaconName(b)}</b>
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
              . {detailed && <SourceChip sourceRef={`DEVICE:${b.id}`} onSource={onSource} />}
            </p>
            <EmailLine email={openFor(b.id)?.email} />
          </div>
        ))}
        {detailed && <p className="v-meta mt-1.5">La balise mesure sa propre distance, pas la position de l’animal. Sa distance est calculée par le téléphone depuis le repère.</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {out.map((b) => {
            const inc = openFor(b.id);
            return inc ? (
              <button key={b.id} type="button" className="btn btn-primary" onClick={() => onUnderstand(inc.id)}>
                Comprendre avec Sentinelle{out.length > 1 ? ` : ${beaconName(b)}` : ''}
              </button>
            ) : null;
          })}
          <button type="button" className="btn" onClick={onAsk}>
            {detailed ? 'Demander : quel animal s’est éloigné ?' : 'Qui s’est éloigné ?'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function BeaconsPanel({
  session,
  result,
  error,
  defaultAnimal,
  detailed,
  onChanged,
  onSource,
}: {
  session: Session | null;
  result: ToolResult<BeaconsData> | null;
  error: unknown;
  defaultAnimal: string | null;
  detailed: boolean;
  onChanged: () => void;
  onSource: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [animalId, setAnimalId] = useState(defaultAnimal ?? '');
  const [name, setName] = useState('');
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
  // Nom proposé : Poulet A, Poulet B… (première lettre libre). C'est le nom de la balise, pas un animal enregistré.
  const nextName = `Poulet ${'ABCDEFGHIJ'.split('').find((l) => !beacons.some((b) => b.label === `Poulet ${l}`)) ?? 'A'}`;

  const pair = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      // Affichage simple : la balise porte un nom (« Poulet A »). L'association à un animal enregistré est facultative.
      const label = name.trim() || (detailed ? undefined : nextName);
      const r = await api<{ id: string; token: string }>('/api/farm/devices', { method: 'POST', session, body: { ...(label ? { label } : {}), ...(detailed && animalId.trim() ? { animalId: animalId.trim() } : {}), radiusM: radius } });
      setName('');
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
          {detailed && <p className="v-kicker">Proximité · démonstration</p>}
          <h2 id="bal-h" className="v-display mt-0.5 text-[26px]">
            Balises
          </h2>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {detailed ? 'Associer une balise' : 'Ajouter une balise'}
        </button>
      </div>
      <p className="v-meta mt-2 max-w-[70ch]">{detailed ? 'Un téléphone joue le rôle d’un capteur de proximité : il transmet sa distance à un repère. Aucun capteur n’est posé sur un animal. Actualisé toutes les 4 secondes tant qu’une balise est suivie.' : 'Un téléphone joue le rôle d’un capteur : aucun capteur n’est posé sur un animal.'}</p>
      {result?.data.simulated && (
        <p role="status" className="mt-2 bg-laterite-soft px-3 py-2 font-bold text-laterite">
          DONNÉES SIMULÉES : au moins une balise transmet une distance réglée à la main, pas une mesure.
        </p>
      )}

      {open && (
        <form className="v-draft mt-3 space-y-3" onSubmit={pair} noValidate aria-label="Associer une balise de démonstration">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="field">
              <label htmlFor="bal-name">Nom de la balise</label>
              <input id="bal-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={detailed ? 'facultatif, ex. Poulet A' : nextName} maxLength={40} autoComplete="off" />
            </div>
            {detailed && (
              <div className="field">
                <label htmlFor="bal-animal">Animal associé (facultatif)</label>
                <input id="bal-animal" className="input num" value={animalId} onChange={(e) => setAnimalId(e.target.value)} placeholder="ex. B-071" autoComplete="off" />
              </div>
            )}
            <div className="field">
              <label htmlFor="bal-radius">Seuil de la zone, en mètres</label>
              <input id="bal-radius" className="input num" type="number" min={5} max={500} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
            </div>
          </div>
          {detailed && <p className="v-meta">Au-delà du seuil, et seulement si la précision de la mesure le permet, la balise est dite hors de sa zone.</p>}
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
                  · <span className="num">{beaconName(b)}</span>
                  {detailed && beaconName(b) !== b.id && <span className="num text-encre-2"> ({b.id})</span>}
                  {b.animalId ? (
                    <>
                      {' '}
                      · associée à <span className="num">{b.animalId}</span>
                    </>
                  ) : null}
                </p>
                <p className="v-meta mt-0.5">
                  {!detailed
                    ? b.latest
                      ? `${b.latest.distanceM === null ? 'Pas de position' : `${Math.round(b.latest.distanceM)} m du repère`} · seuil ${b.radiusM} m${b.latest.source === 'SIMULATED' ? ' · distance SIMULÉE' : ''}`
                      : `Seuil ${b.radiusM} m · aucune mesure reçue`
                    : b.latest
                    ? `${b.latest.distanceM === null ? 'Pas de position' : `${Math.round(b.latest.distanceM)} m du repère`}${b.latest.accuracyM ? ` (± ${Math.round(b.latest.accuracyM)} m)` : ''} · seuil ${b.radiusM} m · observée à ${fmtState(b.latest.observedAt).slice(11)} · reçue à ${fmtState(b.latest.receivedAt).slice(11)} · ${b.latest.source === 'SIMULATED' ? 'distance SIMULÉE' : 'GPS du téléphone'}`
                    : `Seuil ${b.radiusM} m · aucune mesure reçue`}
                  {b.status === 'SILENT' ? ` · muette depuis ${b.silentSeconds} s (cela ne dit pas où elle se trouve)` : ''}
                </p>
                {detailed ? (
                  <p className="mt-1">
                    <SourceChip sourceRef={`DEVICE:${b.id}`} onSource={onSource} />
                  </p>
                ) : (
                  <button type="button" className="mt-1 text-[14px] text-encre-2 underline underline-offset-4" onClick={() => onSource(`DEVICE:${b.id}`)}>
                    Voir le détail
                  </button>
                )}
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
      {detailed && active.length > 0 && result && (
        <p className="v-meta mt-2">
          Données lues à <span className="num">{fmtState(result.asOf).slice(11)}</span>.
        </p>
      )}
    </section>
  );
}
