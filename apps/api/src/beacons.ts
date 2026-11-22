import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { formatInstant } from '@sentinelle/domain';
import { bearingOf, DEFAULT_BEACON_LABEL, distanceText, towardText, type AutoDevice, type Beacon, type BeaconAnchor, type BeaconReading, type BeaconsData, type IncidentData, type IncidentSummary, type SourceData, type Statement, type ToolResult, type TrackPoint, type ZoneState } from '@sentinelle/contracts';
import type { Db, Queryable } from './db.js';
import { HttpError, parse, sha256, type User } from './http.js';
import { incidentMail, MailError, maskEmail, type AlertNotifier } from './notify.js';
import { DEMO_ORG } from './seed.js';

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
 * - balise associée à la main : aucune coordonnée géographique n'est transmise ni stockée. Le suivi repose sur la position
 *   RELATIVE au repère (mètres vers l'est et le nord), calculée par le téléphone ;
 * - appareil suivi automatiquement (mode démonstration) : le navigateur envoie sa position au serveur, qui calcule la distance et
 *   le décalage est/nord par rapport au REPÈRE COMMUN de l'organisation. Les coordonnées d'une mesure ne sont ni stockées en base
 *   ni renvoyées par aucune route ; seule la position du repère est gardée (table org_anchors), et elle n'est renvoyée à personne.
 *   La dernière position brute de chaque appareil n'existe qu'en mémoire vive, pour pouvoir placer le repère sur cet appareil ;
 * - le repère commun se prend tout seul : la première position reçue le fixe. Quand il est déplacé, les mesures calculées par
 *   rapport à l'ancien repère sont effacées et les incidents ouverts sur ces mesures sont terminés pour ce motif. La dernière
 *   position de chaque appareil (celle gardée en mémoire) est alors ré-exprimée par rapport au nouveau repère, avec ses instants
 *   d'origine (observée, reçue) : la même mesure, une autre référence, aucune fraîcheur inventée ;
 * - aucune notification externe par défaut. Si l'e-mail d'alerte est activé côté serveur (voir notify.ts), UN message part par
 *   épisode, vers un destinataire de test fixé côté serveur, et son statut réel est gardé avec l'incident ;
 * - la distance vient d'un calcul à partir d'une position (GPS du téléphone, ou position donnée par le navigateur d'un
 *   ordinateur, qui n'a en général pas de GPS) : ce n'est pas une mesure radio de la proximité avec l'ordinateur ;
 * - un éloignement ouvre UN incident par épisode (table device_incidents), qui garde les faits qui l'ont justifié.
 */
export const OUTSIDE_RULE = 'Hors de la zone si la distance mesurée dépasse le seuil même en retirant la précision annoncée.';

export const SILENT_AFTER_SECONDS = 20;
const KEEP_READINGS = 300;
/** Nombre de points de trajectoire renvoyés au plus. */
const TRACK_POINTS = 120;
/**
 * Un point n'entre dans la trajectoire que s'il est à cette distance au moins du point gardé avant lui : un appareil immobile
 * qui transmet chaque seconde ne remplit pas le tracé de points superposés. La dernière position, elle, est toujours rendue telle quelle.
 */
const TRACK_MIN_STEP_M = 2;
/** Suivi automatique : nombre d'appareils actifs au plus, et nombre d'enregistrements au plus entre deux réinitialisations. */
export const AUTO_MAX_ACTIVE = 40;
const AUTO_MAX_TOTAL = 400;
/** Balises associées à la main : cinq actives au plus (les appareils suivis automatiquement ne comptent pas). */
const MANUAL_MAX_ACTIVE = 5;
const AUTO_RADIUS_M = 30;
/**
 * Une position brute gardée en mémoire ne sert à placer le repère que si elle est récente. Dix minutes : un ordinateur immobile
 * ne reçoit souvent aucune nouvelle position de son navigateur, et c'est pourtant près de lui qu'on veut le repère.
 * L'ancienneté de sa dernière position est affichée sur sa ligne.
 */
const RAW_FRESH_MS = 10 * 60_000;
const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const fmtSec = (s: string) => `${formatInstant(Date.parse(s))}:${s.slice(17, 19)}`;
const meters = distanceText;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Position relative au repère, en mètres vers l'est et vers le nord (approximation plane : exacte à quelques centimètres sur
 * les distances d'un élevage, approximative au-delà de quelques dizaines de kilomètres). La distance est la norme de ce décalage.
 */
export function offsetFromAnchor(anchor: { latitude: number; longitude: number }, p: { latitude: number; longitude: number }): { eastM: number; northM: number; distanceM: number } {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLon = ((p.longitude - anchor.longitude + 540) % 360) - 180;
  const eastM = R * Math.cos(rad(anchor.latitude)) * rad(dLon);
  const northM = R * rad(p.latitude - anchor.latitude);
  return { eastM, northM, distanceM: Math.hypot(eastM, northM) };
}

/**
 * Dernière position brute de chaque appareil suivi automatiquement, EN MÉMOIRE VIVE seulement (jamais en base, jamais renvoyée).
 * Elle ne sert qu'à une chose : pouvoir placer le repère commun sur cet appareil. Elle disparaît à l'arrêt du serveur.
 */
interface RawFix {
  latitude: number;
  longitude: number;
  accuracyM: number;
  /** Instant observé par l'appareil, tel qu'il l'a transmis. */
  observedAt: string;
  /** Instant de réception par le serveur. */
  at: number;
  /** Hachage du jeton de l'appareil : une position gardée avant une réinitialisation ne vaut pas pour un autre appareil de même identifiant. */
  tokenHash: string;
}
const RAW = new WeakMap<object, Map<string, RawFix>>();
function rawOf(db: Db): Map<string, RawFix> {
  let m = RAW.get(db);
  if (!m) RAW.set(db, (m = new Map()));
  return m;
}

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
/** Enregistrement automatique : le navigateur dit seulement, s'il le sait, s'il est un téléphone ou un ordinateur. */
export const AutoDeviceSchema = z.object({ kind: z.enum(['PHONE', 'COMPUTER']).optional() });
/** Position d'un appareil suivi automatiquement. Elle sert au calcul puis n'est pas stockée. */
export const PositionSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(10_000_000),
  /** Instant où le navigateur a obtenu cette position (pas l'instant de l'envoi). */
  observedAt: z.iso.datetime({ offset: true }),
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
  origin: 'MANUAL' | 'AUTO';
  kind: 'PHONE' | 'COMPUTER' | null;
}
const DEVICE_COLS = 'id, org_id, label, animal_id, radius_m, created_at, stopped_at, origin, kind';

interface AnchorRow {
  org_id: string;
  seq: number;
  latitude: number;
  longitude: number;
  accuracy_m: number | null;
  set_at: unknown;
  set_by_device: string | null;
  set_by_label: string | null;
  set_how: BeaconAnchor['how'];
}
const anchorRow = async (q: Queryable, orgId: string) => (await q.query<AnchorRow>('SELECT * FROM org_anchors WHERE org_id = $1', [orgId])).rows[0] ?? null;
/** Ce qu'on montre du repère : quand, par quel appareil, avec quelle précision. Jamais sa position. */
const anchorInfo = (a: AnchorRow): BeaconAnchor => ({ setAt: iso(a.set_at), byDeviceId: a.set_by_device, byLabel: a.set_by_label, accuracyM: a.accuracy_m === null ? null : Number(a.accuracy_m), how: a.set_how });

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

/**
 * État d'une balise. anchorSeq : numéro du repère commun en vigueur ; une mesure calculée par rapport à un ancien repère n'est
 * jamais lue (elle est aussi effacée quand le repère est déplacé). raw : positions brutes en mémoire, pour savoir si le repère
 * peut être placé sur cet appareil.
 */
async function loadBeacon(q: Queryable, d: DeviceRow, nowIso: string, anchorSeq: number | null, raw?: Map<string, RawFix>): Promise<Beacon> {
  const rows = (
    await q.query<Record<string, unknown>>(
      'SELECT source, observed_at, received_at, distance_m, accuracy_m, zone, east_m, north_m FROM device_readings WHERE device_id = $1 AND (anchor_seq IS NULL OR anchor_seq = $3) ORDER BY id DESC LIMIT $2',
      [d.id, KEEP_READINGS, anchorSeq ?? -1],
    )
  ).rows.map(readingOf);
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
  // Trajectoire : les mesures qui portent une position relative, de la plus ancienne à la plus récente. On part de la plus
  // récente (toujours gardée) et on remonte, en ne gardant un point que s'il s'écarte assez du précédent point gardé.
  const track: TrackPoint[] = [];
  for (const r of rows) {
    if (r.eastM === null || r.eastM === undefined || r.northM === null || r.northM === undefined) continue;
    const kept = track.at(-1);
    if (kept && Math.hypot(kept.eastM - r.eastM, kept.northM - r.northM) < TRACK_MIN_STEP_M) continue;
    track.push({ eastM: r.eastM, northM: r.northM, observedAt: r.observedAt, zone: r.zone, source: r.source });
    if (track.length >= TRACK_POINTS) break;
  }
  track.reverse();
  const fix = raw?.get(d.id);
  const canAnchor = !d.stopped_at && !!fix && Date.parse(nowIso) - fix.at <= RAW_FRESH_MS;
  return { id: d.id, label: d.label, animalId: d.animal_id, radiusM: d.radius_m, createdAt: iso(d.created_at), stoppedAt: d.stopped_at ? iso(d.stopped_at) : null, latest, status, outsideSince, silentSeconds, recent: rows.slice(0, 5), track, auto: d.origin === 'AUTO', kind: d.kind, canAnchor };
}

const SOURCE_TEXT: Record<BeaconReading['source'], string> = { PHONE_GPS: 'GPS du téléphone', BROWSER_POSITION: 'position donnée par le navigateur de l’appareil (pas forcément un GPS)', SIMULATED: 'distance SIMULÉE à la main' };
/** Ce qu'est le dispositif, en clair : jamais « un capteur posé sur un animal ». */
const deviceKindText = (d: { auto?: boolean; kind?: 'PHONE' | 'COMPUTER' | null }) => (d.auto ? `${d.kind === 'PHONE' ? 'téléphone' : d.kind === 'COMPUTER' ? 'ordinateur' : 'appareil'} suivi automatiquement depuis l’ouverture du lien` : 'téléphone');

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
  close_reason: 'BACK_INSIDE' | 'DEVICE_STOPPED' | 'ANCHOR_MOVED' | null;
  email_status: 'SENDING' | 'SENT' | 'FAILED' | null;
  email_provider: string | null;
  email_to_masked: string | null;
  email_at: unknown;
  email_error: string | null;
}
/** Pourquoi un incident est terminé, dans une phrase. */
const CLOSE_TEXT: Record<NonNullable<IncidentRow['close_reason']>, string> = {
  BACK_INSIDE: 'la balise a de nouveau été mesurée dans la zone',
  DEVICE_STOPPED: 'la balise a été arrêtée',
  ANCHOR_MOVED: 'le repère commun a été déplacé, la distance mesurée ne valait que pour l’ancien repère',
};
const summaryOf = (r: IncidentRow): IncidentSummary => ({
  id: r.id,
  deviceId: r.device_id,
  label: r.label,
  animalId: r.animal_id,
  openedAt: iso(r.opened_at),
  closedAt: r.closed_at ? iso(r.closed_at) : null,
  closeReason: r.close_reason,
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
  const measured = l.distanceM === null ? 'aucune position disponible' : `${meters(l.distanceM)} du repère${dir ? `, ${towardText(dir)}` : ''}${l.accuracyM ? ` (précision ± ${meters(l.accuracyM)})` : ''}`;
  const when = `mesure du ${fmtSec(l.observedAt)}, reçue à ${fmtSec(l.receivedAt).slice(11)}, source : ${SOURCE_TEXT[l.source]}`;
  if (b.status === 'SILENT') return { nature: 'MISSING', text: `${who} : plus aucune mesure reçue depuis ${b.silentSeconds} secondes. Dernière mesure : ${measured} (${when}). Le silence d’une balise ne dit pas où elle se trouve.`, sources: src };
  if (b.status === 'OUTSIDE') return { nature: 'COMPUTED', text: `${who} : HORS de la zone. ${measured.charAt(0).toUpperCase() + measured.slice(1)}, pour un seuil de ${meters(b.radiusM)}${b.outsideSince ? `, depuis ${fmtSec(b.outsideSince).slice(11)}` : ''} (${when}).`, sources: src };
  if (b.status === 'INSIDE') return { nature: 'COMPUTED', text: `${who} : dans la zone. ${measured.charAt(0).toUpperCase() + measured.slice(1)}, pour un seuil de ${meters(b.radiusM)} (${when}).`, sources: src };
  if (b.status === 'UNCERTAIN') return { nature: 'MISSING', text: `${who} : incertain. ${measured.charAt(0).toUpperCase() + measured.slice(1)}, pour un seuil de ${meters(b.radiusM)} : la précision ne permet pas de dire si elle est dedans ou dehors (${when}).`, sources: src };
  return { nature: 'MISSING', text: `${who} : le téléphone n’a pas de position pour l’instant (${when}).`, sources: src };
}

export function beaconFunctions(db: Db, alerts: { emailReady?: boolean } = {}) {
  const raw = rawOf(db);
  const dbNow = async () => iso((await db.query<{ now: unknown }>('SELECT now() AS now')).rows[0]!.now);
  // Toutes les balises actives (elles sont bornées à la création), puis les dernières arrêtées.
  const devicesOf = async (orgId: string) => [
    ...(await db.query<DeviceRow>(`SELECT ${DEVICE_COLS} FROM devices WHERE org_id = $1 AND stopped_at IS NULL ORDER BY created_at DESC LIMIT $2`, [orgId, AUTO_MAX_ACTIVE + MANUAL_MAX_ACTIVE])).rows,
    ...(await db.query<DeviceRow>(`SELECT ${DEVICE_COLS} FROM devices WHERE org_id = $1 AND stopped_at IS NOT NULL ORDER BY stopped_at DESC LIMIT 8`, [orgId])).rows,
  ];

  /** Lecture des balises de l'exploitation : même enveloppe que les autres fonctions (sources, dates, limites). */
  async function read(u: User): Promise<ToolResult<BeaconsData>> {
    const asOf = await dbNow();
    const anchor = await anchorRow(db, u.org_id);
    const beacons: Beacon[] = [];
    for (const d of await devicesOf(u.org_id)) beacons.push(await loadBeacon(db, d, asOf, anchor?.seq ?? null, raw));
    const active = beacons.filter((b) => b.status !== 'STOPPED');
    const autoActive = active.filter((b) => b.auto);
    const alerts = active.filter((b) => b.status === 'OUTSIDE');
    const simulated = active.some((b) => b.latest?.source === 'SIMULATED');
    const statements: Statement[] = active.length
      ? [
          alerts.length
            ? { nature: 'COMPUTED', text: `${alerts.length > 1 ? `${alerts.length} balises sont` : 'Une balise est'} hors de sa zone : ${alerts.map((b) => `${shown(b)}${b.animalId ? ` (associée à ${b.animalId})` : ''}`).join(', ')}.`, sources: alerts.map((b) => `DEVICE:${b.id}`) }
            : { nature: 'COMPUTED', text: `Aucune balise n’est hors de sa zone d’après les dernières mesures reçues (${active.length} balise${active.length > 1 ? 's' : ''} suivie${active.length > 1 ? 's' : ''}).`, sources: active.map((b) => `DEVICE:${b.id}`) },
          ...active.map(beaconSentence),
        ]
      : [{ nature: 'MISSING', text: 'Aucun appareil n’est suivi comme balise pour l’instant. Aucun capteur n’est connecté : rien n’est mesuré.', sources: [] }];
    // Le repère commun : qui l'a fixé et quand. Sa position n'est jamais dite.
    if (autoActive.length && anchor) {
      const a = anchorInfo(anchor);
      const by = a.byLabel ? `« ${a.byLabel} »` : (a.byDeviceId ?? 'un appareil');
      statements.push({
        nature: 'FACT',
        text: `Repère commun des appareils suivis automatiquement : ${a.how === 'MOVED' ? `placé sur l’appareil ${by}` : `fixé à la première position reçue, celle de l’appareil ${by},`} le ${fmtSec(a.setAt)}${a.accuracyM ? ` (précision de cette position : ± ${meters(a.accuracyM)})` : ''}.`,
        sources: a.byDeviceId ? [`DEVICE:${a.byDeviceId}`] : [],
      });
    }
    const limits = [
      'Une balise mesure sa propre distance à un repère choisi par l’utilisateur. Elle ne mesure ni la position exacte ni l’état de l’animal auquel elle est associée.',
      // Deux chemins, deux vérités : la balise associée à la main ne transmet aucune coordonnée ; l'appareil suivi automatiquement envoie sa position.
      ...(autoActive.length
        ? [
            'Appareils suivis automatiquement : le navigateur de l’appareil envoie sa position au serveur de démonstration, qui calcule la distance et la direction par rapport au repère commun. La position d’une mesure n’est ni stockée ni renvoyée ; seule celle du repère est gardée sur le serveur.',
            ...(autoActive.some((b) => b.latest?.source === 'BROWSER_POSITION') ? ['Un ordinateur n’a en général pas de GPS : sa position vient du réseau (Wi-Fi, adresse IP) et peut être fausse de plusieurs centaines de mètres. Sa précision annoncée le dit.'] : []),
          ]
        : []),
      ...(active.some((b) => !b.auto) || !autoActive.length ? ['Suivi GPS : la position est relative au repère (distance et direction), calculée par le téléphone. Aucune coordonnée géographique n’est transmise.'] : []),
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
      data: { beacons, alerts: alerts.map((b) => b.id), simulated, anchor: anchor ? anchorInfo(anchor) : null, incidents: (await db.query<IncidentRow>('SELECT * FROM device_incidents WHERE org_id = $1 ORDER BY (closed_at IS NULL) DESC, opened_at DESC LIMIT 10', [u.org_id])).rows.map(summaryOf) },
      sources: [...active.map((b) => ({ ref: `DEVICE:${b.id}`, label: `Balise ${b.id}` })), ...active.filter((b) => b.animalId).map((b) => ({ ref: `ANIMAL:${b.animalId}`, label: b.animalId! }))],
      limits,
    };
  }

  /** Preuve d'une balise : le dispositif et ses dernières mesures, avec source, instants, unité et statut. */
  async function source(u: User, id: string): Promise<SourceData | null> {
    const d = (await db.query<DeviceRow>(`SELECT ${DEVICE_COLS} FROM devices WHERE id = $1 AND org_id = $2`, [id, u.org_id])).rows[0];
    if (!d) return null;
    const anchor = await anchorRow(db, u.org_id);
    const b = await loadBeacon(db, d, await dbNow(), anchor?.seq ?? null, raw);
    const zone: Record<ZoneState, string> = { INSIDE: 'dans la zone', OUTSIDE: 'hors de la zone', UNCERTAIN: 'incertain', NO_FIX: 'pas de position' };
    return {
      ref: `DEVICE:${b.id}`,
      kind: 'device',
      title: `Balise de démonstration ${b.id}`,
      fields: [
        { label: 'Dispositif', value: `${b.label} (${deviceKindText(b)}, pas un capteur posé sur un animal)` },
        { label: 'Animal associé', value: b.animalId ?? 'aucun' },
        { label: 'Seuil de la zone', value: meters(b.radiusM) },
        { label: 'Statut', value: beaconSentence(b).text },
        { label: b.auto ? 'Suivi depuis le' : 'Associée le', value: fmtSec(b.createdAt) },
        // Appareil suivi automatiquement : par rapport à quel repère ses distances sont calculées. La position du repère n'est pas dite.
        ...(b.auto
          ? [{ label: 'Repère', value: anchor ? `repère commun, ${anchor.set_how === 'MOVED' ? 'placé sur' : 'fixé à la première position reçue, celle de'} ${anchor.set_by_label ?? anchor.set_by_device ?? 'un appareil'}, le ${fmtSec(iso(anchor.set_at))}. Distance calculée par le serveur à partir de la position envoyée par l’appareil.` : 'pas encore de repère commun' }]
          : []),
        ...b.recent.map((r, i) => ({
          label: i === 0 ? 'Dernière mesure' : `Mesure précédente ${i}`,
          value: `${r.distanceM === null ? 'pas de position' : meters(r.distanceM)}${bearingOf(r.eastM, r.northM, r.accuracyM) ? ` ${towardText(bearingOf(r.eastM, r.northM, r.accuracyM)!)}` : ''}${r.accuracyM ? ` ± ${meters(r.accuracyM)}` : ''} · ${zone[r.zone]} · observée ${fmtSec(r.observedAt)} · reçue ${fmtSec(r.receivedAt).slice(11)} · ${SOURCE_TEXT[r.source]}`,
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
    const d = (await db.query<DeviceRow>(`SELECT ${DEVICE_COLS} FROM devices WHERE id = $1 AND org_id = $2`, [row.device_id, u.org_id])).rows[0];
    const current = d ? await loadBeacon(db, d, asOf, (await anchorRow(db, u.org_id))?.seq ?? null, raw) : null;
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
        ? { nature: 'FACT', text: `Incident terminé le ${fmtSec(iso(row.closed_at))} : ${CLOSE_TEXT[row.close_reason ?? 'BACK_INSIDE']}.`, sources: [`INCIDENT:${row.id}`] }
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
      d?.origin === 'AUTO'
        ? 'La distance est calculée par le serveur à partir de la position envoyée par l’appareil et du repère commun : ce n’est pas une mesure radio de la proximité avec l’ordinateur.'
        : 'La distance est calculée par le téléphone à partir de son GPS et du repère : ce n’est pas une mesure radio de la proximité avec l’ordinateur.',
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
    const d = (await db.query<DeviceRow>(`SELECT ${DEVICE_COLS} FROM devices WHERE id = $1 AND org_id = $2`, [row.device_id, u.org_id])).rows[0];
    return {
      ref: `INCIDENT:${row.id}`,
      kind: 'incident',
      title: `Incident d’éloignement ${row.id}`,
      fields: [
        { label: 'Balise', value: `${row.label} (${row.device_id}), ${d?.origin === 'AUTO' ? deviceKindText({ auto: true, kind: d.kind }) : 'téléphone de démonstration'}` },
        { label: 'Animal associé', value: row.animal_id ?? 'aucun' },
        { label: 'Règle', value: row.rule },
        { label: 'Seuil', value: meters(row.radius_m) },
        { label: 'Mesure qui a ouvert l’incident', value: `${meters(Number(row.trigger_distance_m))}${row.trigger_accuracy_m ? ` ± ${meters(Number(row.trigger_accuracy_m))}` : ''} · observée ${fmtSec(iso(row.trigger_observed_at))} · reçue ${fmtSec(iso(row.opened_at)).slice(11)} · ${SOURCE_TEXT[row.source]}` },
        { label: 'Distance la plus grande', value: meters(Number(row.max_distance_m)) },
        { label: 'Statut', value: row.closed_at ? `terminé le ${fmtSec(iso(row.closed_at))} (${row.close_reason === 'DEVICE_STOPPED' ? 'balise arrêtée' : row.close_reason === 'ANCHOR_MOVED' ? 'repère commun déplacé' : 'balise de nouveau dans la zone'})` : 'ouvert' },
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
  demoMode: boolean;
  currentUser: (req: FastifyRequest) => Promise<User>;
  audit: (q: Queryable, u: User | null, action: string, entity: string, id: string, detail?: unknown) => Promise<void>;
}

/** Une mesure telle qu'elle est gardée : des mètres par rapport à un repère, jamais des coordonnées. */
interface Measure {
  source: BeaconReading['source'];
  observedAt: string;
  distanceM: number | null;
  accuracyM: number | null;
  eastM: number | null;
  northM: number | null;
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
      incidentMail(n, {
        incidentId,
        label: d.label && d.label !== DEFAULT_BEACON_LABEL ? d.label : d.id,
        animalId: d.animal_id,
        radiusM: d.radius_m,
        distanceM: reading.distanceM,
        accuracyM: accuracy,
        simulated: reading.source === 'SIMULATED',
        // Un ordinateur n'a pas de GPS : le message ne dit pas « GPS du téléphone » pour lui.
        ...(reading.source === 'BROWSER_POSITION' ? { sourceText: SOURCE_TEXT.BROWSER_POSITION } : {}),
        observedAt: fmtSec(reading.observedAt),
      }),
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

/** Un téléphone a un GPS ; pour tout autre appareil, on dit seulement que la position vient de son navigateur. */
const sourceOf = (d: { kind: DeviceRow['kind'] }): BeaconReading['source'] => (d.kind === 'PHONE' ? 'PHONE_GPS' : 'BROWSER_POSITION');

export function registerBeacons(ctx: Ctx, notifier: AlertNotifier | null = null) {
  const { db } = ctx;
  const raw = rawOf(db);
  const newId = () => `BAL-${randomBytes(3).toString('hex').toUpperCase().slice(0, 4)}`;

  /** Associe une balise de démonstration à un animal. Le jeton n'est renvoyé qu'une fois ; seul son hachage est stocké. */
  ctx.app.post('/api/farm/devices', async (req, reply) => {
    const u = await ctx.currentUser(req);
    const body = parse(CreateBeaconSchema, req.body);
    const animal = body.animalId ? ((await db.query<{ id: string }>('SELECT id FROM animals WHERE org_id = $1 AND (id = $2 OR UPPER(tag) = UPPER($2)) LIMIT 1', [u.org_id, body.animalId])).rows[0] ?? null) : null;
    if (body.animalId && !animal) throw new HttpError(400, 'VALIDATION', 'Données invalides', { fields: { animalId: 'Animal inconnu dans votre périmètre' } });
    // La limite de cinq ne vaut que pour les balises associées à la main : les appareils suivis automatiquement ont la leur.
    const active = Number((await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM devices WHERE org_id = $1 AND stopped_at IS NULL AND origin = 'MANUAL'`, [u.org_id])).rows[0]!.n);
    if (active >= MANUAL_MAX_ACTIVE) throw new HttpError(409, 'CONFLICT', 'Cinq balises de démonstration au plus. Arrêtez-en une avant d’en associer une autre.');
    const id = newId();
    const token = randomBytes(24).toString('base64url');
    await db.query('INSERT INTO devices(id, org_id, label, animal_id, token_hash, radius_m, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, u.org_id, body.label ?? DEFAULT_BEACON_LABEL, animal?.id ?? null, sha256(token), body.radiusM, u.id]);
    await ctx.audit(db, u, 'DEVICE_PAIRED', 'device', id, { animalId: animal?.id ?? null, radiusM: body.radiusM });
    return reply.status(201).send({ id, token, label: body.label ?? DEFAULT_BEACON_LABEL, animalId: animal?.id ?? null, radiusM: body.radiusM });
  });

  /** Arrête une balise et termine son incident ouvert. Renvoie faux si elle était déjà arrêtée. */
  async function stopDevice(id: string, orgId: string): Promise<boolean> {
    const r = await db.query('UPDATE devices SET stopped_at = now() WHERE id = $1 AND org_id = $2 AND stopped_at IS NULL RETURNING id', [id, orgId]);
    if (!r.rows.length) return false;
    await db.query(`UPDATE device_incidents SET closed_at = now(), close_reason = 'DEVICE_STOPPED' WHERE device_id = $1 AND closed_at IS NULL`, [id]);
    raw.delete(id);
    return true;
  }

  ctx.app.post('/api/farm/devices/:id/stop', async (req) => {
    const u = await ctx.currentUser(req);
    const id = (req.params as { id: string }).id;
    if (!(await stopDevice(id, u.org_id))) throw new HttpError(404, 'NOT_FOUND', 'Balise introuvable ou déjà arrêtée');
    await ctx.audit(db, u, 'DEVICE_STOPPED', 'device', id);
    return { ok: true };
  });

  /**
   * Place le repère commun sur un appareil suivi : sa dernière position reçue (gardée en mémoire vive, récente) devient le repère.
   * Réservé à une session utilisateur. Les mesures calculées par rapport à l'ancien repère sont effacées, et les incidents
   * ouverts sur ces mesures sont terminés pour ce motif : une distance à l'ancien repère ne dit rien du nouveau.
   * La dernière position de chaque appareil est ensuite ré-exprimée par rapport au nouveau repère, avec ses instants d'origine :
   * l'appareil qui porte le repère est à 0 m tout de suite, et un appareil muet reste dit muet (rien n'est rajeuni). Cette
   * ré-expression n'ouvre pas d'incident et n'envoie pas d'e-mail : c'est la prochaine mesure reçue qui le fera, s'il y a lieu.
   */
  ctx.app.post('/api/farm/devices/:id/anchor', async (req) => {
    const u = await ctx.currentUser(req);
    const id = (req.params as { id: string }).id;
    const d = (await db.query<DeviceRow & { token_hash: string }>('SELECT * FROM devices WHERE id = $1 AND org_id = $2', [id, u.org_id])).rows[0];
    if (!d) throw new HttpError(404, 'NOT_FOUND', 'Balise introuvable dans votre périmètre');
    const fix = raw.get(id);
    if (d.stopped_at || !fix || fix.tokenHash !== d.token_hash || Date.now() - fix.at > RAW_FRESH_MS)
      throw new HttpError(409, 'CONFLICT', 'Cet appareil n’a pas transmis de position récente : le repère ne peut pas être placé sur lui.');
    const anchor = await db.tx(async (q) => {
      const a = (
        await q.query<AnchorRow>(
          `INSERT INTO org_anchors(org_id, latitude, longitude, accuracy_m, set_by_device, set_by_label, set_how) VALUES ($1,$2,$3,$4,$5,$6,'MOVED')
           ON CONFLICT (org_id) DO UPDATE SET seq = org_anchors.seq + 1, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, accuracy_m = EXCLUDED.accuracy_m,
             set_at = now(), set_by_device = EXCLUDED.set_by_device, set_by_label = EXCLUDED.set_by_label, set_how = 'MOVED'
           RETURNING *`,
          [u.org_id, fix.latitude, fix.longitude, fix.accuracyM, d.id, d.label],
        )
      ).rows[0]!;
      await q.query(
        `UPDATE device_incidents SET closed_at = now(), close_reason = 'ANCHOR_MOVED'
         WHERE org_id = $1 AND closed_at IS NULL AND device_id IN (SELECT DISTINCT device_id FROM device_readings WHERE org_id = $1 AND anchor_seq IS NOT NULL)`,
        [u.org_id],
      );
      await q.query('DELETE FROM device_readings WHERE org_id = $1 AND anchor_seq IS NOT NULL', [u.org_id]);
      const tracked = (await q.query<DeviceRow & { token_hash: string }>(`SELECT * FROM devices WHERE org_id = $1 AND origin = 'AUTO' AND stopped_at IS NULL ORDER BY created_at`, [u.org_id])).rows;
      for (const t of tracked) {
        const f = raw.get(t.id);
        if (!f || f.tokenHash !== t.token_hash || Date.now() - f.at > RAW_FRESH_MS) continue;
        const o = offsetFromAnchor(a, f);
        const distance = round1(o.distanceM);
        const accuracy = round1(f.accuracyM);
        await q.query('INSERT INTO device_readings(device_id, org_id, source, observed_at, received_at, distance_m, accuracy_m, zone, east_m, north_m, anchor_seq) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
          t.id,
          t.org_id,
          sourceOf(t),
          f.observedAt,
          new Date(f.at).toISOString(),
          distance,
          accuracy,
          zoneOf(distance, accuracy, t.radius_m),
          round1(o.eastM),
          round1(o.northM),
          a.seq,
        ]);
      }
      return a;
    });
    await ctx.audit(db, u, 'ANCHOR_MOVED', 'device', id);
    return { ok: true, anchor: anchorInfo(anchor) };
  });

  /**
   * Enregistrement automatique d'un appareil (mode démonstration seulement) : ouvrir le lien de l'application suffit, sans session
   * ni QR code. La balise appartient à l'organisation de démonstration, n'est associée à aucun animal, et porte un nom numéroté.
   * Le jeton n'est renvoyé qu'ici, une fois ; le navigateur le garde. Hors mode démonstration, la route n'existe pas.
   */
  ctx.app.post('/api/devices/auto', async (req, reply) => {
    if (!ctx.demoMode) throw new HttpError(404, 'NOT_FOUND', 'Route inconnue');
    const body = parse(AutoDeviceSchema, req.body ?? {});
    const owner = (await db.query<{ id: string }>(`SELECT id FROM users WHERE org_id = $1 ORDER BY (id = 'U-ELEVEUR') DESC, id LIMIT 1`, [DEMO_ORG])).rows[0];
    if (!owner) throw new HttpError(409, 'CONFLICT', 'L’organisation de démonstration n’existe pas : réinitialisez la démonstration.');
    const count = (await db.query<{ active: number; total: number }>(`SELECT COUNT(*) FILTER (WHERE stopped_at IS NULL)::int AS active, COUNT(*)::int AS total FROM devices WHERE org_id = $1 AND origin = 'AUTO'`, [DEMO_ORG])).rows[0]!;
    if (Number(count.active) >= AUTO_MAX_ACTIVE) throw new HttpError(409, 'CONFLICT', `${AUTO_MAX_ACTIVE} appareils sont déjà suivis automatiquement : celui-ci ne peut pas l’être tant que l’un d’eux n’est pas arrêté.`, { reason: 'AUTO_LIMIT' });
    if (Number(count.total) >= AUTO_MAX_TOTAL) throw new HttpError(409, 'CONFLICT', 'Trop d’appareils ont été enregistrés depuis la dernière réinitialisation de la démonstration.', { reason: 'AUTO_LIMIT' });
    const prefix = body.kind === 'PHONE' ? 'Téléphone' : body.kind === 'COMPUTER' ? 'Ordinateur' : 'Appareil';
    const token = randomBytes(24).toString('base64url');
    // Le numéro est calculé dans la même instruction que l'insertion ; l'index unique écarte deux enregistrements simultanés.
    for (let attempt = 0; ; attempt++) {
      const id = newId();
      try {
        const label = (
          await db.query<{ label: string }>(
            `INSERT INTO devices(id, org_id, label, animal_id, token_hash, radius_m, created_by, origin, kind, auto_seq)
             SELECT $1::text, $2::text, $3::text || ' ' || (COALESCE(MAX(auto_seq), 0) + 1), NULL, $4::text, $5::int, $6::text, 'AUTO', $7::text, COALESCE(MAX(auto_seq), 0) + 1
             FROM devices WHERE org_id = $2::text AND origin = 'AUTO'
             RETURNING label`,
            [id, DEMO_ORG, prefix, sha256(token), AUTO_RADIUS_M, owner.id, body.kind ?? null],
          )
        ).rows[0]!.label;
        await ctx.audit(db, null, 'DEVICE_AUTO_REGISTERED', 'device', id, { kind: body.kind ?? null });
        const created: AutoDevice = { id, token, label, radiusM: AUTO_RADIUS_M };
        return reply.status(201).send(created);
      } catch (e) {
        if ((e as { code?: string }).code !== '23505' || attempt >= 4) throw e;
      }
    }
  });

  /** Authentification du dispositif par son jeton (en-tête), sans session utilisateur. */
  async function deviceFromToken(req: FastifyRequest): Promise<DeviceRow & { token_hash: string }> {
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
    return loadBeacon(db, d, now, (await anchorRow(db, d.org_id))?.seq ?? null);
  });

  /** « Arrêter le suivi », depuis l'appareil lui-même : il prouve qui il est par son jeton. Sans effet si la balise est déjà arrêtée. */
  ctx.app.post('/api/devices/:id/stop', async (req) => {
    const d = await deviceFromToken(req);
    if (await stopDevice(d.id, d.org_id)) await ctx.audit(db, null, 'DEVICE_STOPPED', 'device', d.id, { by: 'device' });
    return { ok: true };
  });

  /**
   * Garde-fous communs à toute mesure : instant observé plausible, une mesure par seconde au plus.
   * Renvoie faux si la mesure doit être ignorée (trop rapprochée de la précédente).
   */
  async function admissible(d: DeviceRow, observedAt: string): Promise<boolean> {
    const now = Date.now();
    if (Math.abs(Date.parse(observedAt) - now) > 10 * 60_000) throw new HttpError(400, 'VALIDATION', 'Données invalides', { fields: { observedAt: 'Instant observé trop éloigné de l’heure du serveur' } });
    const last = (await db.query<{ received_at: unknown }>('SELECT received_at FROM device_readings WHERE device_id = $1 ORDER BY id DESC LIMIT 1', [d.id])).rows[0];
    return !(last && now - Date.parse(iso(last.received_at)) < 900);
  }

  /** Chemin commun des mesures : statut, enregistrement, épisode d'éloignement, e-mail éventuel, purge des plus anciennes. */
  async function store(d: DeviceRow, m: Measure, anchorSeq: number | null): Promise<ZoneState> {
    const zone = zoneOf(m.distanceM, m.accuracyM, d.radius_m);
    await db.query('INSERT INTO device_readings(device_id, org_id, source, observed_at, distance_m, accuracy_m, zone, east_m, north_m, anchor_seq) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [d.id, d.org_id, m.source, m.observedAt, m.distanceM, m.accuracyM, zone, m.eastM, m.northM, anchorSeq]);
    const opened = await trackIncident(db, d, zone, m, m.accuracyM);
    // Un nouvel épisode d'éloignement : un e-mail, et un seul, si l'envoi est activé. La mesure n'attend pas la réponse du fournisseur.
    if (opened && notifier && m.distanceM !== null) void notifyIncident(ctx, notifier, d, opened, { source: m.source, observedAt: m.observedAt, distanceM: m.distanceM }, m.accuracyM).catch(() => {});
    await db.query('DELETE FROM device_readings WHERE device_id = $1 AND id <= COALESCE((SELECT id FROM device_readings WHERE device_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1), 0)', [d.id, KEEP_READINGS]);
    return zone;
  }
  const TOO_FAST = { accepted: false, reason: 'Une mesure par seconde au plus' };

  /** Réception d'une mesure d'une balise associée à la main. Le serveur calcule le statut (dans la zone, hors zone, incertain, pas de position). */
  ctx.app.post('/api/devices/:id/readings', async (req, reply) => {
    const d = await deviceFromToken(req);
    if (d.stopped_at) throw new HttpError(409, 'CONFLICT', 'Cette balise a été arrêtée.');
    // Un appareil suivi automatiquement envoie sa position : le serveur calcule sa distance au repère commun. Il n'annonce pas de distance.
    if (d.origin === 'AUTO') throw new HttpError(409, 'CONFLICT', 'Cet appareil est suivi automatiquement : il transmet sa position, pas une distance.');
    const body = parse(ReadingSchema, req.body);
    if (!(await admissible(d, body.observedAt))) return reply.status(202).send(TOO_FAST);
    const accuracy = body.source === 'SIMULATED' ? 0 : body.accuracyM;
    // Position relative : acceptée seulement si elle est complète et cohérente avec la distance annoncée (sinon l'une des deux est fausse).
    const hasOffset = body.eastM !== null && body.eastM !== undefined && body.northM !== null && body.northM !== undefined;
    if (hasOffset !== ((body.eastM ?? null) !== null || (body.northM ?? null) !== null)) throw new HttpError(400, 'VALIDATION', 'Données invalides', { fields: { eastM: 'Position relative incomplète' } });
    if (hasOffset && (body.distanceM === null || Math.abs(Math.hypot(body.eastM as number, body.northM as number) - body.distanceM) > Math.max(3, body.distanceM * 0.05)))
      throw new HttpError(400, 'VALIDATION', 'Données invalides', { fields: { eastM: 'Position relative incohérente avec la distance' } });
    const zone = await store(d, { source: body.source, observedAt: body.observedAt, distanceM: body.distanceM, accuracyM: accuracy, eastM: hasOffset ? (body.eastM as number) : null, northM: hasOffset ? (body.northM as number) : null }, null);
    return reply.status(201).send({ accepted: true, zone, radiusM: d.radius_m });
  });

  /**
   * Réception de la position d'un appareil suivi automatiquement. Le serveur calcule la distance et le décalage est/nord par
   * rapport au repère commun, puis suit le chemin commun des mesures. La position elle-même n'est pas stockée en base ni
   * renvoyée : elle reste en mémoire vive, la dernière seulement, pour pouvoir placer le repère sur cet appareil.
   * S'il n'y a pas encore de repère, cette position le devient : l'appareil est alors à 0 m.
   */
  ctx.app.post('/api/devices/:id/position', async (req, reply) => {
    const d = await deviceFromToken(req);
    if (d.stopped_at) throw new HttpError(409, 'CONFLICT', 'Cette balise a été arrêtée.', { reason: 'STOPPED' });
    if (d.origin !== 'AUTO') throw new HttpError(409, 'CONFLICT', 'Cette balise a été associée à la main : elle transmet une distance calculée sur le téléphone, pas sa position.');
    const body = parse(PositionSchema, req.body);
    if (!(await admissible(d, body.observedAt))) return reply.status(202).send(TOO_FAST);
    let anchor = await anchorRow(db, d.org_id);
    if (!anchor) {
      const created = await db.query(
        `INSERT INTO org_anchors(org_id, latitude, longitude, accuracy_m, set_by_device, set_by_label, set_how) VALUES ($1,$2,$3,$4,$5,$6,'FIRST_POSITION') ON CONFLICT (org_id) DO NOTHING RETURNING org_id`,
        [d.org_id, body.latitude, body.longitude, body.accuracyM, d.id, d.label],
      );
      if (created.rows.length) await ctx.audit(db, null, 'ANCHOR_SET', 'device', d.id, { how: 'FIRST_POSITION' });
      anchor = (await anchorRow(db, d.org_id))!;
    }
    const o = offsetFromAnchor(anchor, body);
    raw.set(d.id, { latitude: body.latitude, longitude: body.longitude, accuracyM: body.accuracyM, observedAt: body.observedAt, at: Date.now(), tokenHash: d.token_hash });
    const zone = await store(d, { source: sourceOf(d), observedAt: body.observedAt, distanceM: round1(o.distanceM), accuracyM: round1(body.accuracyM), eastM: round1(o.eastM), northM: round1(o.northM) }, anchor.seq);
    return reply.status(201).send({ accepted: true, zone, radiusM: d.radius_m });
  });
}
