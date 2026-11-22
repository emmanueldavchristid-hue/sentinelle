import { z } from 'zod';

/** Instant ISO 8601 UTC. */
const isoInstant = z.iso.datetime({ offset: true });
/** Jour civil réel : « 2026-02-30 » est refusé (le calendrier fait foi, pas seulement le format). */
export function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const t = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === date;
}
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ')
  .refine(isRealDate, 'Cette date n’existe pas dans le calendrier');

export const TemporalValueSchema = z.discriminatedUnion('precision', [
  z.object({ precision: z.literal('INSTANT'), at: isoInstant }),
  z.object({ precision: z.literal('DAY'), date: isoDate }),
  z.object({ precision: z.literal('INTERVAL'), from: isoInstant, to: isoInstant }).refine((v) => Date.parse(v.from) <= Date.parse(v.to), {
    message: 'Le début de l’intervalle doit précéder la fin',
  }),
  z.object({ precision: z.literal('UNKNOWN') }),
]);
export type TemporalValueDto = z.infer<typeof TemporalValueSchema>;

export const VerificationSchema = z.enum(['DECLARED', 'VERIFIED', 'TO_VERIFY']);
export const RoleSchema = z.enum(['AGENT', 'VET', 'FARMER']);
export const ROLE_LABELS: Record<z.infer<typeof RoleSchema>, string> = { FARMER: 'Éleveur', AGENT: 'Agent de terrain', VET: 'Vétérinaire' };
export type Role = z.infer<typeof RoleSchema>;

/** Données d'une révision d'enregistrement (append-only). */
export const PresenceDataSchema = z.object({
  kind: z.literal('presence'),
  animalId: z.string().min(1).max(40),
  locationId: z.string().min(1).max(40),
  start: TemporalValueSchema,
  end: TemporalValueSchema.nullable(),
  verification: VerificationSchema,
  source: z.string().max(200),
  revisionNote: z.string().max(300).optional(),
});
export const MovementDataSchema = z.object({
  kind: z.literal('movement'),
  animalId: z.string().min(1).max(40),
  fromLocationId: z.string().min(1).max(40),
  toLocationId: z.string().min(1).max(40),
  departure: TemporalValueSchema,
  arrival: TemporalValueSchema,
  verification: VerificationSchema,
  source: z.string().max(200),
  revisionNote: z.string().max(300).optional(),
});
export const RecordDataSchema = z.discriminatedUnion('kind', [PresenceDataSchema, MovementDataSchema]);

/** Opération de synchronisation d'une observation saisie sur le terrain. Payload versionné. */
export const ObservationSyncSchema = z.object({
  payloadVersion: z.literal(1),
  clientId: z.uuid(),
  idempotencyKey: z.uuid(),
  animalId: z.string().min(1).max(40),
  locationId: z.string().min(1).max(40),
  eventTime: TemporalValueSchema,
  note: z.string().trim().min(3, 'Décrivez l’observation (3 caractères minimum)').max(1000),
  recordedAtClient: isoInstant,
});
export type ObservationSync = z.infer<typeof ObservationSyncSchema>;

export const ReviewSchema = z.object({
  decision: z.enum(['OPEN_INVESTIGATION', 'CLOSE']),
  note: z.string().max(500).optional(),
});

export const WindowSchema = z
  .object({ from: isoInstant, to: isoInstant })
  .refine((w) => Date.parse(w.from) < Date.parse(w.to), { message: 'La fin de la fenêtre doit suivre le début' })
  .refine((w) => Date.parse(w.to) - Date.parse(w.from) <= 366 * 86_400_000, { message: 'Fenêtre limitée à un an' });

export const RunRequestSchema = z.object({
  window: WindowSchema,
  maxDepth: z.number().int().min(1).max(4).default(2),
  minOverlapMinutes: z.number().int().min(0).max(1440).default(0),
});

export const CreateInvestigationSchema = z.object({
  observationId: z.uuid(),
  window: WindowSchema,
  maxDepth: z.number().int().min(1).max(4).default(2),
});

/** Correction par un agent : crée une révision, jamais d'écrasement. `kind` absent = présence (compatibilité). */
const correctionBase = {
  idempotencyKey: z.uuid(),
  baseRev: z.number().int().min(1),
  reason: z.string().trim().min(3, 'Indiquez la source de la correction').max(300),
};
export const PresenceCorrectionSchema = z.object({ kind: z.literal('presence'), ...correctionBase, start: TemporalValueSchema, end: TemporalValueSchema.nullable() });
export const MovementCorrectionSchema = z.object({ kind: z.literal('movement'), ...correctionBase, departure: TemporalValueSchema, arrival: TemporalValueSchema });
export const RecordCorrectionSchema = z.preprocess(
  (v) => (v && typeof v === 'object' && !('kind' in v) ? { ...v, kind: 'presence' } : v),
  z.discriminatedUnion('kind', [PresenceCorrectionSchema, MovementCorrectionSchema]),
);
export type RecordCorrection = z.infer<typeof RecordCorrectionSchema>;

export const ObservationStatusSchema = z.enum(['NEW', 'UNDER_INVESTIGATION', 'CLOSED']);
export const TaskStatusSchema = z.enum(['OPEN', 'REQUESTED', 'DONE']);

export const OBSERVATION_STATUS_LABELS: Record<z.infer<typeof ObservationStatusSchema>, string> = {
  NEW: 'Nouveau — à examiner',
  UNDER_INVESTIGATION: 'Enquête ouverte',
  CLOSED: 'Classé',
};
export const TASK_STATUS_LABELS: Record<z.infer<typeof TaskStatusSchema>, string> = {
  OPEN: 'À demander',
  REQUESTED: 'Demandée à un agent',
  DONE: 'Complétée',
};

/** Format d'erreur d'API, sans fuite de détails internes. */
export interface ApiError {
  error: string;
  message: string;
  fields?: Record<string, string>;
}

/** Interface remplaçable pour une future aide IA à la structuration (D-05). Aucune implémentation fournie. */
export interface StructuringProposal {
  sourceText: string;
  animalId: string | null;
  locationId: string | null;
  eventTime: TemporalValueDto | null;
  observation: string | null;
  undetermined: string[];
}
export interface StructuringProvider {
  readonly name: string;
  propose(sourceText: string, signal: AbortSignal): Promise<StructuringProposal>;
}

export * from './farm.js';
