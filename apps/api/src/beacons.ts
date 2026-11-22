import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { formatInstant } from '@sentinelle/domain';
import { bearingOf, DEFAULT_BEACON_LABEL, type Beacon, type BeaconReading, type BeaconsData, type IncidentData, type IncidentSummary, type SourceData, type Statement, type ToolResult, type TrackPoint, type ZoneState } from '@sentinelle/contracts';
import type { Db, Queryable } from './db.js';
import { HttpError, parse, sha256, type User } from './http.js';
import { incidentMail, MailError, maskEmail, type AlertNotifier } from './notify.js';

/**
 * Balises de démonstration : un téléphone joue le rôle d'un capteur de proximité (idée de Mouhi, 21/11).
 *
 * Ce que c'est : un contrat d'événement IoT minimal (dispositif, source, instant observé, instant reçu, unité, qualité)
 * et UN type de dispositif, la balise « téléphone ». Ce que ce n'est pas : une plateforme IoT, ni un matériel posé sur un animal.
 *
 * Règles de vérité :
 * - une balise mesure SA distance à un repère, pas la position ni l'état de l'animal auquel on l'associe ;
 * - la source de chaque mesure (GPS du téléphone, ou distance SIMULÉE à la main) est stockée et affichée dans chaque preuve ;
 * - « hors zone » n'est dit que si la distance dépasse le seuil même en tenant compte de la précision ; sinon « incertain » ;
 * - une balise muette n'est pas « sortie » : on dit seulement depuis quand rien n'a été reçu ;
 * - aucune coordonnée géographique n'est transmise ni stockée. Le suivi GPS repose sur la position RELATIVE au repère
 *   (mètres vers l'est et le nord), calculée par le téléphone : on connaît la trajectoire autour du repère, pas le lieu ;
 * - aucune notification externe par défaut. Si l'e-mail d'alerte est activé côté serveur (voir notify.ts), UN message part par
 *   épisode, vers un destinataire de test fixé côté serveur, et son statut réel est gardé avec l'incident ;
 * - la distance est calculée par le téléphone (son GPS, un repère fixé par l'utilisateur) : ce n'est pas une mesure radio
 *   de la proximité avec l'ordinateur ;
 * - un éloignement ouvre UN incident par épisode (table device_incidents), qui garde les faits qui l'ont justifié.
 */
export const OUTSIDE_RULE = 'Hors de la zone si la distance mesurée dépasse le seuil même en retirant la précision annoncée.';

export const SILENT_AFTER_SECONDS = 20;
const KEEP_READINGS = 300;
/** Nombre de points de trajectoire renvoyés (une mesure toutes les 3 secondes : environ 6 minutes). */
const TRACK_POINTS = 120;
const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const fmtSec = (s: string) => `${formatInstant(Date.parse(s))}:${s.slice(17, 19)}`;
const meters = (n: number) => `${Math.round(n)} m`;

/** Statut d'une mesure selon le seuil : la précision compte, on ne tranche pas quand elle ne le permet pas. */
export function zoneOf(distanceM: number | null, accuracyM: number | null, radiusM: number): ZoneState {
  if (distanceM === null) return 'NO_FIX';
  const acc = accuracyM ?? 0;
  if (distanceM - acc > radiusM) return 'OUTSIDE';
  if (distanceM + acc <= radiusM) return 'INSIDE';
  return 'UNCERTAIN';
}

export const CreateBeaconSchema = z.object({
  /** Animal enregistré auquel associer la balise. Facultatif : une balise peut n'avoir qu'un nom (« Poulet A »). */
  animalId: z.string().trim().max(40).optional(),
  /** Nom donné à la balise pour la démonstration. Ce n'est pas un animal enregistré. */
  label: z.string().trim().min(1).max(40).optional(),
  radiusM: z.number().int().min(5, 'Seuil de 5 m au moins').max(500, 'Seuil de 500 m au plus').default(30),
});
export const ReadingSchema = z.object({
  source: z.enum(['PHONE_GPS', 'SIMULATED']),
  observedAt: z.iso.datetime({ offset: true }),
  distanceM: z.number().min(0).max(100_000).nullable(),
  accuracyM: z.number().min(0).max(100_000).nullable(),
  /** Suivi GPS : position relative au repère, en mètres vers l'est et vers le nord. Facultatif (anciennes balises : distance seule). */
  eastM: z.number().min(-100_000).max(100_000).nullable().optional(),
  northM: z.number().min(-100_000).max(100_000).nullable().optional(),
});

interface DeviceRow {
  id: string;
  org_id: string;
  label: string;
  animal_id: string | null;
  radius_m: number;
  created_at: unknown;
  stopped_at: unknown;
}

const readingOf = (r: Record<string, unknown>): BeaconReading => ({
  source: r.source as BeaconReading['source'],
  observedAt: iso(r.observed_at),
  receivedAt: iso(r.received_at),
  distanceM: r.distance_m === null ? null : Number(r.distance_m),
  accuracyM: r.accuracy_m === null ? null : Number(r.accuracy_m),
  zone: r.zone as ZoneState,
  eastM: r.east_m === null || r.east_m === undefined ? null : Number(r.east_m),
  northM: r.north_m === null || r.north_m === undefined ? null : Number(r.north_m),
});

async function loadBeacon(q: Queryable, d: DeviceRow, nowIso: string): Promise<Beacon> {
  const rows = (await q.query<Record<string, unknown>>('SELECT source, observed_at, received_at, distance_m, accuracy_m, zone, east_m, north_m FROM device_readings WHERE device_id = $1 ORDER BY id DESC LIMIT $2', [d.id, KEEP_READINGS])).rows.map(readingOf);
  const latest = rows[0] ?? null;
  const silentSeconds = latest ? Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(latest.receivedAt)) / 1000)) : null;
  let status: Beacon['status'];
  if (d.stopped_at) status = 'STOPPED';
  else if (!latest) status = 'NEVER';
  else if (silentSeconds! > SILENT_AFTER_SECONDS) status = 'SILENT';
  else status = latest.zone;
  // Début de la série continue de mesures « hors zone » : depuis quand la balise est dehors.
  let outsideSince: string | null = null;
  if (latest?.zone === 'OUTSIDE') for (const r of rows) if (r.zone === 'OUTSIDE') outsideSince = r.observedAt;
    else break;
  // Trajectoire : les mesures qui portent une position relative, de la plus ancienne à la plus récente.
  const track: TrackPoint[] = rows
    .slice(0, TRACK_POINTS)
    .filter((r) => r.eastM !== null && r.eastM !== undefined && r.northM !== null && r.northM !== undefined)
    .map((r) => ({ eastM: r.eastM as number, northM: r.northM as number, observedAt: r.observedAt, zone: r.zone, source: r.source }))
    .reverse();
  return { id: d.id, label: d.label, animalId: d.animal_id, radiusM: d.radius_m, createdAt: iso(d.created_at), stoppedAt: d.stopped_at ? iso(d.stopped_at) : null, latest, status, outsideSince, silentSeconds, recent: rows.slice(0, 5), track };
}

const SOURCE_TEXT: Record<BeaconReading['source'], string> = { PHONE_GPS: 'GPS du téléphone', SIMULATED: 'distance SIMULÉE à la main' };

interface IncidentRow {
  id: string;
  org_id: string;
  device_id: string;
  animal_id: string | null;
  label: string;
  rule: string;
  radius_m: number;
  source: BeaconReading['source'];
  opened_at: unknown;
  trigger_observed_at: unknown;
  trigger_distance_m: number;
  trigger_accuracy_m: number | null;
  max_distance_m: number;
  closed_at: unknown;
  close_reason: 'BACK_INSIDE' | 'DEVICE_STOPPED' | null;
  email_status: 'SENDING' | 'SENT' | 'FAILED' | null;
  email_provider: string | null;
  email_to_masked: string | null;
  email_at: unknown;
  email_error: string | null;
}
const summaryOf = (r: IncidentRow): IncidentSummary => ({
  id: r.id,
  deviceId: r.device_id,
  label: r.label,
  animalId: r.animal_id,
  openedAt: iso(r.opened_at),
  closedAt: r.closed_at ? iso(r.closed_at) : null,
  email: r.email_status ? { status: r.email_status, provider: r.email_provider, to: r.email_to_masked, at: r.email_at ? iso(r.email_at) : null, error: r.email_error } : null,
});

/**
 * Suit l'épisode d'éloignement d'une balise à chaque mesure reçue. « Hors zone » ouvre un incident s'il n'y en a pas d'ouvert
 * (sinon met à jour la distance la plus grande) ; « dans la zone » le ferme. Une mesure incertaine ou sans position ne
 * l'ouvre ni ne le ferme : on ne conclut pas quand la précision ne le permet pas.
 * Renvoie l'identifiant de l'incident s'il vient d'être OUVERT par cette mesure (c'est le seul moment où une alerte part).
 */
async function trackIncident(q: Queryable, d: DeviceRow, zone: ZoneState, reading: { source: BeaconReading['source']; observedAt: string; distanceM: number | null }, accuracy: number | null): Promise<string | null> {
  if (zone === 'OUTSIDE' && reading.distanceM !== null) {
    const id = `INC-${randomBytes(4).toString('hex').toUpperCase().slice(0, 5)}`;
    const opened = await q.query<{ id: string }>(
      `INSERT INTO device_incidents(id, org_id, device_id, animal_id, label, rule, radius_m, source, trigger_observed_at, trigger_distance_m, trigger_accuracy_m, max_distance_m)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10)
       ON CONFLICT (device_id) WHERE closed_at IS NULL DO NOTHING RETURNING id`,
      [id, d.org_id, d.id, d.animal_id, d.label, OUTSIDE_RULE, d.radius_m, reading.source, reading.observedAt, reading.distanceM, accuracy],
    );
    if (opened.rows.length) return id;
    await q.query('UPDATE device_incidents SET max_distance_m = GREATEST(max_distance_m, $2) WHERE device_id = $1 AND closed_at IS NULL', [d.id, reading.distanceM]);
  } else if (zone === 'INSIDE') {
    await q.query(`UPDATE device_incidents SET closed_at = now(), close_reason = 'BACK_INSIDE' WHERE device_id = $1 AND closed_at IS NULL`, [d.id]);
  }
  return null;
}

/** Nom d'une balise dans une phrase : son nom choisi entre guillemets, sinon son identifiant. */
const shown = (b: { id: string; label: string }) => (b.label && b.label !== DEFAULT_BEACON_LABEL ? `« ${b.label} »` : b.id);

/** Phrase de statut d'une balise. Toujours « la balise », jamais « l'animal ». */
export function beaconSentence(b: Beacon): Statement {
  const who = `Balise de démonstration ${shown(b)}${b.animalId ? `, associée à ${b.animalId}` : ''}`;
  const src = [`DEVICE:${b.id}`, ...(b.animalId ? [`ANIMAL:${b.animalId}`] : [])];
  const l = b.latest;
  if (b.status === 'STOPPED') return { nature: 'FACT', text: `${who} : arrêtée le ${fmtSec(b.stoppedAt!)}.`, sources: src };
  if (!l) return { nature: 'MISSING', text: `${who} : aucune mesure reçue. Cela ne dit rien de l’endroit où elle se trouve.`, sources: src };
  // La direction n'est dite que si le téléphone transmet sa position relative, et si la balise est assez loin du repère pour qu'elle ait un sens.
  const dir = bearingOf(l.eastM, l.northM, l.accuracyM);
  const measured = l.distanceM === null ? 'aucune position disponible' : `${meters(l.distanceM)} du repère${dir ? `, vers le ${dir}` : ''}${l.accuracyM ? ` (précision ± ${meters(l.accuracyM)})` : ''}`;
  const when = `mesure du ${fmtSec(l.observedAt)}, reçue à ${fmtSec(l.receivedAt).slice(11)}, source : ${SOURCE_TEXT[l.source]}`;
  if (b.status === 'SILENT') return { nature: 'MISSING', text: `${who} : plus aucune mesure reçue depuis ${b.silentSeconds} secondes. Dernière mesure : ${measured} (${when}). Le silence d’une balise ne dit pas où elle se trouve.`, sources: src };
  if (b.status === 'OUTSIDE') return { nature: 'COMPUTED', text: `${who} : HORS de la zone. ${measured.charAt(0).toUpperCase() + measured.slice(1)}, pour un seuil de ${meters(b.radiusM)}${b.outsideSince ? `, depuis ${fmtSec(b.outsideSince).slice(11)}` : ''} (${when}).`, sources: src };
  if (b.status === 'INSIDE') return { nature: 'COMPUTED', text: `${who} : dans la zone. ${measured.charAt(0).toUpperCase() + measured.slice(1)}, pour un seuil de ${meters(b.radiusM)} (${when}).`, sources: src };
  if (b.status === 'UNCERTAIN') return { nature: 'MISSING', text: `${who} : incertain. ${measured.charAt(0).toUpperCase() + measured.slice(1)}, pour un seuil de ${meters(b.radiusM)} : la précision ne permet pas de dire si elle est dedans ou dehors (${when}).`, sources: src };
  return { nature: 'MISSING', text: `${who} : le téléphone n’a pas de position pour l’instant (${when}).`, sources: src };
}

export function beaconFunctions(db: Db, alerts: { emailReady?: boolean } = {}) {
  const dbNow = async () => iso((await db.query<{ now: unknown }>('SELECT now() AS now')).rows[0]!.now);
  const devicesOf = async (orgId: string) => (await db.query<DeviceRow>('SELECT id, org_id, label, animal_id, radius_m, created_at, stopped_at FROM devices WHERE org_id = $1 ORDER BY created_at DESC LIMIT 20', [orgId])).rows;

  /** Lecture des balises de l'exploitation : même enveloppe que les autres fonctions (sources, dates, limites). */
  async function read(u: User): Promise<ToolResult<BeaconsData>> {
    const asOf = await dbNow();
    const beacons: Beacon[] = [];
    for (const d of await devicesOf(u.org_id)) beacons.push(await loadBeacon(db, d, asOf));
    const active = beacons.filter((b) => b.status !== 'STOPPED');
    const alerts = active.filter((b) => b.status === 'OUTSIDE');
    const simulated = active.some((b) => b.latest?.source === 'SIMULATED');
    const statements: Statement[] = active.length
      ? [
          alerts.length
            ? { nature: 'COMPUTED', text: `${alerts.length > 1 ? `${alerts.length} balises sont` : 'Une balise est'} hors de sa zone : ${alerts.map((b) => `${shown(b)}${b.animalId ? ` (associée à ${b.animalId})` : ''}`).join(', ')}.`, sources: alerts.map((b) => `DEVICE:${b.id}`) }
            : { nature: 'COMPUTED', text: `Aucune balise n’est hors de sa zone d’après les dernières mesures reçues (${active.length} balise${active.length > 1 ? 's' : ''} suivie${active.length > 1 ? 's' : ''}).`, sources: active.map((b) => `DEVICE:${b.id}`) },
          ...active.map(beaconSentence),
        ]
      : [{ nature: 'MISSING', text: 'Aucune balise n’est associée à un animal. Aucun capteur n’est connecté : rien n’est mesuré automatiquement.', sources: [] }];
    const limits = [
      'Une balise mesure sa propre distance à un repère choisi par l’utilisateur. Elle ne mesure ni la position exacte ni l’état de l’animal auquel elle est associée.',
      'Suivi GPS : la position est relative au repère (distance et direction), calculée par le téléphone. Aucune coordonnée géographique n’est transmise.',
      'Dispositif de démonstration : un téléphone tenu à la main. Aucun capteur n’est posé sur un animal.',
      `« Hors de la zone » n’est dit que si la distance dépasse le seuil même avec la précision annoncée. Une balise est dite muette après ${SILENT_AFTER_SECONDS} secondes sans mesure.`,
    ];
    if (simulated) limits.unshift('DONNÉES SIMULÉES : au moins une balise transmet une distance réglée à la main, pas une mesure.');
    return {
      tool: 'beacons',
      params: {},
      asOf,
      period: null,
      statements,
      data: { beacons, alerts: alerts.map((b) => b.id), simulated, incidents: (await db.query<IncidentRow>('SELECT * FROM device_incidents WHERE org_id = $1 ORDER BY (closed_at IS NULL) DESC, opened_at DESC LIMIT 10', [u.org_id])).rows.map(summaryOf) },
      sources: [...active.map((b) => ({ ref: `DEVICE:${b.id}`, label: `Balise ${b.id}` })), ...active.filter((b) => b.animalId).map((b) => ({ ref: `ANIMAL:${b.animalId}`, label: b.animalId! }))],
      limits,
    };
  }

  /** Preuve d'une balise : le dispositif et ses dernières mesures, avec source, instants, unité et statut. */
  async function source(u: User, id: string): Promise<SourceData | null> {
    const d = (await db.query<DeviceRow>('SELECT id, org_id, label, animal_id, radius_m, created_at, stopped_at FROM devices WHERE id = $1 AND org_id = $2', [id, u.org_id])).rows[0];
    if (!d) return null;
    const b = await loadBeacon(db, d, await dbNow());
    const zone: Record<ZoneState, string> = { INSIDE: 'dans la zone', OUTSIDE: 'hors de la zone', UNCERTAIN: 'incertain', NO_FIX: 'pas de position' };
    return {
      ref: `DEVICE:${b.id}`,
      kind: 'device',
      title: `Balise de démonstration ${b.id}`,
      fields: [
        { label: 'Dispositif', value: `${b.label} (téléphone, pas un capteur posé sur un animal)` },
        { label: 'Animal associé', value: b.animalId ?? 'aucun' },
        { label: 'Seuil de la zone', value: meters(b.radiusM) },
        { label: 'Statut', value: beaconSentence(b).text },
        { label: 'Associée le', value: fmtSec(b.createdAt) },
        ...b.recent.map((r, i) => ({
          label: i === 0 ? 'Dernière mesure' : `Mesure précédente ${i}`,
          value: `${r.distanceM === null ? 'pas de position' : meters(r.distanceM)}${bearingOf(r.eastM, r.northM, r.accuracyM) ? ` vers le ${bearingOf(r.eastM, r.northM, r.accuracyM)}` : ''}${r.accuracyM ? ` ± ${meters(r.accuracyM)}` : ''} · ${zone[r.zone]} · observée ${fmtSec(r.observedAt)} · reçue ${fmtSec(r.receivedAt).slice(11)} · ${SOURCE_TEXT[r.source]}`,
        })),
      ],
      event: null,
      revisions: [],
    };
  }

  /**
   * Lecture d'un incident d'éloignement : ce qui a été détecté, quand, la mesure et la règle qui le justifient, puis l'état
   * ACTUEL de la balise (relu maintenant, pas celui du moment de l'incident). Sans identifiant : l'incident le plus récent.
   */
  async function incident(u: User, p: { incidentId?: string }): Promise<ToolResult<IncidentData | null>> {
    const asOf = await dbNow();
    const id = p.incidentId?.trim().toUpperCase().slice(0, 60);
    const row = id
      ? (await db.query<IncidentRow>('SELECT * FROM device_incidents WHERE id = $1 AND org_id = $2', [id, u.org_id])).rows[0]
      : (await db.query<IncidentRow>('SELECT * FROM device_incidents WHERE org_id = $1 ORDER BY (closed_at IS NULL) DESC, opened_at DESC LIMIT 1', [u.org_id])).rows[0];
    if (!row) {
      if (id) throw new HttpError(404, 'NOT_FOUND', 'Incident introuvable dans votre périmètre');
      return { tool: 'incident', params: {}, asOf, period: null, statements: [{ nature: 'MISSING', text: 'Aucun incident de balise n’est enregistré.', sources: [] }], data: null, sources: [], limits: ['Un incident n’est créé que lorsqu’une balise est mesurée hors de sa zone.'] };
    }
    const d = (await db.query<DeviceRow>('SELECT id, org_id, label, animal_id, radius_m, created_at, stopped_at FROM devices WHERE id = $1 AND org_id = $2', [row.device_id, u.org_id])).rows[0];
    const current = d ? await loadBeacon(db, d, asOf) : null;
    const who = `la balise de démonstration ${shown({ id: row.device_id, label: row.label })}${row.animal_id ? `, associée à ${row.animal_id},` : ''}`;
    const refs = [`INCIDENT:${row.id}`, `DEVICE:${row.device_id}`, ...(row.animal_id ? [`ANIMAL:${row.animal_id}`] : [])];
    const acc = row.trigger_accuracy_m ? ` (précision ± ${meters(Number(row.trigger_accuracy_m))})` : '';
    const statements: Statement[] = [
      { nature: 'FACT', text: `Incident ${row.id} : ${who} a été mesurée hors de sa zone le ${fmtSec(iso(row.trigger_observed_at))}.`, sources: refs },
      {
        nature: 'FACT',
        text: `Mesure qui a ouvert l’incident : ${meters(Number(row.trigger_distance_m))} du repère${acc}, pour un seuil de ${meters(row.radius_m)}. Source : ${SOURCE_TEXT[row.source]}. Reçue par le serveur à ${fmtSec(iso(row.opened_at)).slice(11)}.`,
        sources: [`INCIDENT:${row.id}`],
      },
      { nature: 'COMPUTED', text: `Règle appliquée : ${row.rule.charAt(0).toLowerCase()}${row.rule.slice(1)} Distance la plus grande mesurée pendant l’incident : ${meters(Number(row.max_distance_m))}.`, sources: [`INCIDENT:${row.id}`] },
      row.closed_at
        ? { nature: 'FACT', text: `Incident terminé le ${fmtSec(iso(row.closed_at))} : ${row.close_reason === 'DEVICE_STOPPED' ? 'la balise a été arrêtée' : 'la balise a de nouveau été mesurée dans la zone'}.`, sources: [`INCIDENT:${row.id}`] }
        : { nature: 'COMPUTED', text: 'Incident toujours ouvert : aucune mesure « dans la zone » n’a été reçue depuis.', sources: [`INCIDENT:${row.id}`] },
    ];
    // E-mail d'alerte : ce que le fournisseur d'envoi a réellement répondu, ou l'absence d'envoi. Jamais « reçu par le destinataire ».
    const at = row.email_at ? fmtSec(iso(row.email_at)).slice(11) : null;
    if (row.email_status === 'SENT')
      statements.push({ nature: 'FACT', text: `Un e-mail d’alerte a été accepté par le service d’envoi (${row.email_provider ?? 'fournisseur'}) à ${at}, pour ${row.email_to_masked ?? 'le destinataire de test'}. Accepté ne veut pas dire lu.`, sources: [`INCIDENT:${row.id}`] });
    else if (row.email_status === 'FAILED') statements.push({ nature: 'FACT', text: `L’e-mail d’alerte n’est pas parti. ${row.email_error ?? 'L’envoi a échoué.'}`, sources: [`INCIDENT:${row.id}`] });
    else if (row.email_status === 'SENDING') statements.push({ nature: 'MISSING', text: 'Un e-mail d’alerte est en cours d’envoi : le service d’envoi n’a pas encore répondu.', sources: [`INCIDENT:${row.id}`] });
    else statements.push({ nature: 'MISSING', text: `Aucun e-mail n’a été envoyé pour cet incident${alerts.emailReady ? '' : ' : l’envoi d’e-mails n’est pas activé sur ce serveur'}.`, sources: [] });
    if (current) {
      const now = beaconSentence(current);
      statements.push({ ...now, text: `État actuel. ${now.text}` });
    }
    const limits = [
      'Une balise mesure sa propre distance à un repère choisi par l’utilisateur. Elle ne mesure ni la position exacte ni l’état de l’animal auquel elle est associée.',
      'La distance est calculée par le téléphone à partir de son GPS et du repère : ce n’est pas une mesure radio de la proximité avec l’ordinateur.',
      `Dispositif de démonstration : un téléphone tenu à la main. Aucun capteur n’est posé sur un animal. ${alerts.emailReady || row.email_status ? 'Un e-mail d’alerte au plus part par épisode, vers un destinataire de test fixé côté serveur.' : 'Alerte affichée dans l’application uniquement : aucun message n’est envoyé.'}`,
    ];
    if (row.source === 'SIMULATED' || current?.latest?.source === 'SIMULATED') limits.unshift('DONNÉES SIMULÉES : la distance a été réglée à la main, ce n’est pas une mesure.');
    const data: IncidentData = {
      ...summaryOf(row),
      rule: row.rule,
      radiusM: row.radius_m,
      trigger: { observedAt: iso(row.trigger_observed_at), distanceM: Number(row.trigger_distance_m), accuracyM: row.trigger_accuracy_m === null ? null : Number(row.trigger_accuracy_m), source: row.source },
      maxDistanceM: Number(row.max_distance_m),
      closeReason: row.close_reason,
      current,
    };
    return { tool: 'incident', params: { incidentId: row.id }, asOf, period: null, statements, data, sources: [{ ref: `INCIDENT:${row.id}`, label: `Incident ${row.id}` }, { ref: `DEVICE:${row.device_id}`, label: `Balise ${row.device_id}` }, ...(row.animal_id ? [{ ref: `ANIMAL:${row.animal_id}`, label: row.animal_id }] : [])], limits };
  }

  /** Preuve d'un incident : l'enregistrement tel qu'il est conservé. */
  async function incidentSource(u: User, id: string): Promise<SourceData | null> {
    const row = (await db.query<IncidentRow>('SELECT * FROM device_incidents WHERE id = $1 AND org_id = $2', [id.toUpperCase(), u.org_id])).rows[0];
    if (!row) return null;
    return {
      ref: `INCIDENT:${row.id}`,
      kind: 'incident',
      title: `Incident d’éloignement ${row.id}`,
      fields: [
        { label: 'Balise', value: `${row.label} (${row.device_id}), téléphone de démonstration` },
        { label: 'Animal associé', value: row.animal_id ?? 'aucun' },
        { label: 'Règle', value: row.rule },
        { label: 'Seuil', value: meters(row.radius_m) },
        { label: 'Mesure qui a ouvert l’incident', value: `${meters(Number(row.trigger_distance_m))}${row.trigger_accuracy_m ? ` ± ${meters(Number(row.trigger_accuracy_m))}` : ''} · observée ${fmtSec(iso(row.trigger_observed_at))} · reçue ${fmtSec(iso(row.opened_at)).slice(11)} · ${SOURCE_TEXT[row.source]}` },
        { label: 'Distance la plus grande', value: meters(Number(row.max_distance_m)) },
        { label: 'Statut', value: row.closed_at ? `terminé le ${fmtSec(iso(row.closed_at))} (${row.close_reason === 'DEVICE_STOPPED' ? 'balise arrêtée' : 'balise de nouveau dans la zone'})` : 'ouvert' },
        { label: 'E-mail d’alerte', value: row.email_status === 'SENT' ? `accepté par ${row.email_provider ?? 'le service d’envoi'} à ${row.email_at ? fmtSec(iso(row.email_at)).slice(11) : '?'}, pour ${row.email_to_masked ?? 'le destinataire de test'}` : row.email_status === 'FAILED' ? `non parti : ${row.email_error ?? 'échec'}` : row.email_status === 'SENDING' ? 'en cours d’envoi' : 'aucun envoi' },
      ],
      event: null,
      revisions: [],
    };
  }

  return { read, source, incident, incidentSource };
}

interface Ctx {
  app: FastifyInstance;
  db: Db;
  currentUser: (req: FastifyRequest) => Promise<User>;
  audit: (q: Queryable, u: User | null, action: string, entity: string, id: string, detail?: unknown) => Promise<void>;
}

/**
 * Envoie l'e-mail d'alerte d'un incident qui vient de s'ouvrir, et garde ce que le fournisseur a répondu. Appelé une seule fois
 * par incident ; la clé d'idempotence protège en plus contre un rejeu. Ne bloque pas la réception des mesures.
 */
async function notifyIncident(ctx: Ctx, n: AlertNotifier, d: DeviceRow, incidentId: string, reading: { source: BeaconReading['source']; observedAt: string; distanceM: number }, accuracy: number | null) {
  const { db } = ctx;
  await db.query(`UPDATE device_incidents SET email_status = 'SENDING', email_provider = $2, email_to_masked = $3 WHERE id = $1`, [incidentId, n.mailer.provider, maskEmail(n.to)]);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const sent = await n.mailer.send(
      incidentMail(n, { incidentId, label: d.label && d.label !== DEFAULT_BEACON_LABEL ? d.label : d.id, animalId: d.animal_id, radiusM: d.radius_m, distanceM: reading.distanceM, accuracyM: accuracy, simulated: reading.source === 'SIMULATED', observedAt: fmtSec(reading.observedAt) }),
      ac.signal,
    );
    await db.query(`UPDATE device_incidents SET email_status = 'SENT', email_message_id = $2, email_at = now(), email_error = NULL WHERE id = $1`, [incidentId, sent.id]);
    await ctx.audit(db, null, 'ALERT_EMAIL_SENT', 'incident', incidentId, { provider: n.mailer.provider });
  } catch (e) {
    const message = e instanceof MailError ? e.message : 'L’envoi a échoué.';
    await db.query(`UPDATE device_incidents SET email_status = 'FAILED', email_at = now(), email_error = $2 WHERE id = $1`, [incidentId, message.slice(0, 300)]);
    await ctx.audit(db, null, 'ALERT_EMAIL_FAILED', 'incident', incidentId, { provider: n.mailer.provider, code: e instanceof MailError ? e.code : 'ERROR' });
  } finally {
    clearTimeout(timer);
  }
}

export function registerBeacons(ctx: Ctx, notifier: AlertNotifier | null = null) {
  const { db } = ctx;

  /** Associe une balise de démonstration à un animal. Le jeton n'est renvoyé qu'une fois ; seul son hachage est stocké. */
  ctx.app.post('/api/farm/devices', async (req, reply) => {
    const u = await ctx.currentUser(req);
    const body = parse(CreateBeaconSchema, req.body);
    const animal = body.animalId ? ((await db.query<{ id: string }>('SELECT id FROM animals WHERE org_id = $1 AND (id = $2 OR UPPER(tag) = UPPER($2)) LIMIT 1', [u.org_id, body.animalId])).rows[0] ?? null) : null;
    if (body.animalId && !animal) throw new HttpError(400, 'VALIDATION', 'Données invalides', { fields: { animalId: 'Animal inconnu dans votre périmètre' } });
    const active = Number((await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM devices WHERE org_id = $1 AND stopped_at IS NULL', [u.org_id])).rows[0]!.n);
    if (active >= 5) throw new HttpError(409, 'CONFLICT', 'Cinq balises de démonstration au plus. Arrêtez-en une avant d’en associer une autre.');
    const id = `BAL-${randomBytes(3).toString('hex').toUpperCase().slice(0, 4)}`;
    const token = randomBytes(24).toString('base64url');
    await db.query('INSERT INTO devices(id, org_id, label, animal_id, token_hash, radius_m, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, u.org_id, body.label ?? DEFAULT_BEACON_LABEL, animal?.id ?? null, sha256(token), body.radiusM, u.id]);
    await ctx.audit(db, u, 'DEVICE_PAIRED', 'device', id, { animalId: animal?.id ?? null, radiusM: body.radiusM });
    return reply.status(201).send({ id, token, label: body.label ?? DEFAULT_BEACON_LABEL, animalId: animal?.id ?? null, radiusM: body.radiusM });
  });

  ctx.app.post('/api/farm/devices/:id/stop', async (req) => {
    const u = await ctx.currentUser(req);
    const id = (req.params as { id: string }).id;
    const r = await db.query('UPDATE devices SET stopped_at = now() WHERE id = $1 AND org_id = $2 AND stopped_at IS NULL RETURNING id', [id, u.org_id]);
    if (!r.rows.length) throw new HttpError(404, 'NOT_FOUND', 'Balise introuvable ou déjà arrêtée');
    await db.query(`UPDATE device_incidents SET closed_at = now(), close_reason = 'DEVICE_STOPPED' WHERE device_id = $1 AND closed_at IS NULL`, [id]);
    await ctx.audit(db, u, 'DEVICE_STOPPED', 'device', id);
    return { ok: true };
  });

  /** Authentification du dispositif par son jeton (en-tête), sans session utilisateur. */
  async function deviceFromToken(req: FastifyRequest): Promise<DeviceRow> {
    const id = (req.params as { id: string }).id;
    const token = req.headers['x-device-token'];
    const d = typeof token === 'string' && token ? (await db.query<DeviceRow & { token_hash: string }>('SELECT * FROM devices WHERE id = $1', [id])).rows[0] : undefined;
    if (!d || d.token_hash !== sha256(token as string)) throw new HttpError(401, 'UNAUTHENTICATED', 'Balise inconnue ou jeton invalide');
    return d;
  }

  /** Ce que le serveur sait de la balise : affiché sur le téléphone pour qu'il montre l'état enregistré, pas une supposition. */
  ctx.app.get('/api/devices/:id', async (req) => {
    const d = await deviceFromToken(req);
    const now = iso((await db.query<{ now: unknown }>('SELECT now() AS now')).rows[0]!.now);
    return loadBeacon(db, d, now);
  });

  /** Réception d'une mesure. Le serveur calcule le statut (dans la zone, hors zone, incertain, pas de position). */
  ctx.app.post('/api/devices/:id/readings', async (req, reply) => {
    const d = await deviceFromToken(req);
    if (d.stopped_at) throw new HttpError(409, 'CONFLICT', 'Cette balise a été arrêtée.');
    const body = parse(ReadingSchema, req.body);
    const now = Date.now();
    if (Math.abs(Date.parse(body.observedAt) - now) > 10 * 60_000) throw new HttpError(400, 'VALIDATION', 'Données invalides', { fields: { observedAt: 'Instant observé trop éloigné de l’heure du serveur' } });
    const last = (await db.query<{ received_at: unknown }>('SELECT received_at FROM device_readings WHERE device_id = $1 ORDER BY id DESC LIMIT 1', [d.id])).rows[0];
    if (last && now - Date.parse(iso(last.received_at)) < 900) return reply.status(202).send({ accepted: false, reason: 'Une mesure par seconde au plus' });
    const accuracy = body.source === 'SIMULATED' ? 0 : body.accuracyM;
    // Position relative : acceptée seulement si elle est complète et cohérente avec la distance annoncée (sinon l'une des deux est fausse).
    const hasOffset = body.eastM !== null && body.eastM !== undefined && body.northM !== null && body.northM !== undefined;
    if (hasOffset !== ((body.eastM ?? null) !== null || (body.northM ?? null) !== null)) throw new HttpError(400, 'VALIDATION', 'Données invalides', { fields: { eastM: 'Position relative incomplète' } });
    if (hasOffset && (body.distanceM === null || Math.abs(Math.hypot(body.eastM as number, body.northM as number) - body.distanceM) > Math.max(3, body.distanceM * 0.05)))
      throw new HttpError(400, 'VALIDATION', 'Données invalides', { fields: { eastM: 'Position relative incohérente avec la distance' } });
    const zone = zoneOf(body.distanceM, accuracy, d.radius_m);
    await db.query('INSERT INTO device_readings(device_id, org_id, source, observed_at, distance_m, accuracy_m, zone, east_m, north_m) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [d.id, d.org_id, body.source, body.observedAt, body.distanceM, accuracy, zone, hasOffset ? body.eastM : null, hasOffset ? body.northM : null]);
    const opened = await trackIncident(db, d, zone, body, accuracy);
    // Un nouvel épisode d'éloignement : un e-mail, et un seul, si l'envoi est activé. La mesure n'attend pas la réponse du fournisseur.
    if (opened && notifier && body.distanceM !== null) void notifyIncident(ctx, notifier, d, opened, { source: body.source, observedAt: body.observedAt, distanceM: body.distanceM }, accuracy).catch(() => {});
    await db.query('DELETE FROM device_readings WHERE device_id = $1 AND id <= COALESCE((SELECT id FROM device_readings WHERE device_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1), 0)', [d.id, KEEP_READINGS]);
    return reply.status(201).send({ accepted: true, zone, radiusM: d.radius_m });
  });
}
