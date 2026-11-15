import Dexie, { type Table } from 'dexie';
import type { ObservationSync, TemporalValueDto } from '@sentinelle/contracts';

/** États visibles : Brouillon local → À transmettre → En cours → Reçu ; Échec avec relance. */
export type OutboxState = 'PENDING' | 'SENDING' | 'RECEIVED' | 'FAILED';
export const OUTBOX_LABELS: Record<OutboxState, string> = {
  PENDING: 'À transmettre',
  SENDING: 'En cours',
  RECEIVED: 'Reçu par le serveur',
  FAILED: 'Échec',
};

export interface OutboxItem {
  id: string; // identifiant client (= id de l'observation côté serveur)
  idempotencyKey: string;
  payloadVersion: 1;
  kind: 'observation';
  payload: ObservationSync;
  state: OutboxState;
  attempts: number;
  lastError: string | null;
  /** Erreur définitive (validation serveur) : la relance ne servirait à rien. */
  permanent: boolean;
  createdAt: string;
  updatedAt: string;
  receivedAt: string | null;
}

export interface ObservationDraft {
  id: 'observation';
  animalId: string;
  locationId: string;
  precision: TemporalValueDto['precision'];
  date: string;
  time: string;
  note: string;
  updatedAt: string;
}

export interface CacheEntry {
  key: string;
  value: unknown;
  savedAt: string;
}

/**
 * Base locale séparée par organisation et utilisateur. Aucun secret n'y est stocké.
 * Purgée à la déconnexion (changement de rôle).
 */
export class LocalDb extends Dexie {
  drafts!: Table<ObservationDraft, string>;
  outbox!: Table<OutboxItem, string>;
  cache!: Table<CacheEntry, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({ drafts: 'id', outbox: 'id, state, createdAt', cache: 'key' });
  }
}

export const localDbName = (orgId: string, userId: string) => `sentinelle-${orgId}-${userId}`;

export async function enqueueObservation(db: LocalDb, payload: Omit<ObservationSync, 'payloadVersion' | 'clientId' | 'idempotencyKey' | 'recordedAtClient'>): Promise<OutboxItem> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const item: OutboxItem = {
    id,
    idempotencyKey: crypto.randomUUID(),
    payloadVersion: 1,
    kind: 'observation',
    payload: { ...payload, payloadVersion: 1, clientId: id, idempotencyKey: '', recordedAtClient: now },
    state: 'PENDING',
    attempts: 0,
    lastError: null,
    permanent: false,
    createdAt: now,
    updatedAt: now,
    receivedAt: null,
  };
  item.payload.idempotencyKey = item.idempotencyKey;
  await db.transaction('rw', db.outbox, db.drafts, async () => {
    await db.outbox.add(item);
    await db.drafts.delete('observation');
  });
  return item;
}

/** Un envoi interrompu (onglet fermé pendant « En cours ») redevient « À transmettre » : la clé d'idempotence évite tout doublon. */
export async function recoverInterrupted(db: LocalDb): Promise<number> {
  return db.outbox.where('state').equals('SENDING').modify({ state: 'PENDING' });
}

export type SendResult = { ok: true; receivedAt: string } | { ok: false; permanent: boolean; message: string };

/**
 * Transmet les éléments en attente, un par un. L'état « Reçu » n'est posé qu'après une réponse serveur valide.
 * `send` est injecté pour pouvoir être testé sans réseau.
 */
export async function syncOutbox(db: LocalDb, send: (item: OutboxItem) => Promise<SendResult>, opts: { includeFailed?: boolean } = {}) {
  const states: OutboxState[] = opts.includeFailed ? ['PENDING', 'FAILED'] : ['PENDING'];
  const items = (await db.outbox.where('state').anyOf(states).sortBy('createdAt')).filter((i) => !i.permanent);
  let sent = 0;
  let failed = 0;
  for (const item of items) {
    await db.outbox.update(item.id, { state: 'SENDING', updatedAt: new Date().toISOString() });
    let r: SendResult;
    try {
      r = await send(item);
    } catch (e) {
      r = { ok: false, permanent: false, message: e instanceof Error ? e.message : 'Erreur inattendue' };
    }
    const now = new Date().toISOString();
    if (r.ok) {
      await db.outbox.update(item.id, { state: 'RECEIVED', receivedAt: r.receivedAt, lastError: null, attempts: item.attempts + 1, updatedAt: now });
      sent++;
    } else {
      await db.outbox.update(item.id, { state: 'FAILED', lastError: r.message, permanent: r.permanent, attempts: item.attempts + 1, updatedAt: now });
      failed++;
      if (!r.permanent) break; // serveur injoignable : inutile d'essayer les suivants maintenant
    }
  }
  return { sent, failed };
}
