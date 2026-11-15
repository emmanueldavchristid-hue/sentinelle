import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { LocalDb, enqueueObservation, localDbName, recoverInterrupted, syncOutbox, type SendResult } from './local';

const obs = { animalId: 'B-017', locationId: 'C', eventTime: { precision: 'INSTANT', at: '2026-03-12T07:30:00.000Z' } as const, note: 'Baisse d’appétit' };

describe('Outbox locale (IndexedDB simulée par fake-indexeddb)', () => {
  it('SYN-01 brouillon et file conservés après fermeture/réouverture', async () => {
    const name = localDbName('ORG', 'u1');
    const db1 = new LocalDb(name);
    await db1.drafts.put({ id: 'observation', animalId: 'B-017', locationId: 'C', precision: 'INSTANT', date: '2026-03-12', time: '07:30', note: 'brouillon', updatedAt: '' });
    await enqueueObservation(db1, obs);
    db1.close();
    const db2 = new LocalDb(name);
    const items = await db2.outbox.toArray();
    expect(items).toHaveLength(1);
    expect(items[0]!.state).toBe('PENDING');
    expect(items[0]!.payload.idempotencyKey).toBe(items[0]!.idempotencyKey);
    expect(await db2.drafts.get('observation')).toBeUndefined(); // le brouillon devient un élément de la file
    db2.close();
  });

  it('SYN-02/03 échec réseau visible, puis relance réussie seulement après réponse serveur', async () => {
    const db = new LocalDb(localDbName('ORG', 'u2'));
    const item = await enqueueObservation(db, obs);
    const down = async (): Promise<SendResult> => {
      throw new Error('Serveur injoignable');
    };
    expect(await syncOutbox(db, down)).toEqual({ sent: 0, failed: 1 });
    let saved = (await db.outbox.get(item.id))!;
    expect(saved).toMatchObject({ state: 'FAILED', attempts: 1, lastError: 'Serveur injoignable', permanent: false });
    // Sans « includeFailed », un échec n'est pas relancé automatiquement.
    const seen: string[] = [];
    await syncOutbox(db, async (i) => (seen.push(i.id), { ok: true, receivedAt: 'x' }));
    expect(seen).toEqual([]);
    expect(await syncOutbox(db, async () => ({ ok: true, receivedAt: '2026-03-12T08:00:00Z' }), { includeFailed: true })).toEqual({ sent: 1, failed: 0 });
    saved = (await db.outbox.get(item.id))!;
    expect(saved).toMatchObject({ state: 'RECEIVED', attempts: 2, receivedAt: '2026-03-12T08:00:00Z', lastError: null });
    db.close();
  });

  it('même clé d’idempotence à chaque tentative (rejeu sûr côté serveur)', async () => {
    const db = new LocalDb(localDbName('ORG', 'u3'));
    const item = await enqueueObservation(db, obs);
    const keys: string[] = [];
    await syncOutbox(db, async (i) => {
      keys.push(i.payload.idempotencyKey);
      throw new Error('coupure');
    });
    await syncOutbox(db, async (i) => (keys.push(i.payload.idempotencyKey), { ok: true, receivedAt: 'x' }), { includeFailed: true });
    expect(keys).toEqual([item.idempotencyKey, item.idempotencyKey]);
    db.close();
  });

  it('envoi interrompu (« En cours » à la fermeture) → redevient « À transmettre »', async () => {
    const db = new LocalDb(localDbName('ORG', 'u4'));
    const item = await enqueueObservation(db, obs);
    await db.outbox.update(item.id, { state: 'SENDING' });
    expect(await recoverInterrupted(db)).toBe(1);
    expect((await db.outbox.get(item.id))!.state).toBe('PENDING');
    db.close();
  });

  it('erreur de validation serveur : définitive, non relancée', async () => {
    const db = new LocalDb(localDbName('ORG', 'u5'));
    await enqueueObservation(db, obs);
    await syncOutbox(db, async () => ({ ok: false, permanent: true, message: 'Animal inconnu' }));
    let calls = 0;
    await syncOutbox(db, async () => (calls++, { ok: true, receivedAt: 'x' }), { includeFailed: true });
    expect(calls).toBe(0);
    db.close();
  });

  it('SYN-07 bases séparées par utilisateur ; purge à la déconnexion', async () => {
    const a = new LocalDb(localDbName('ORG', 'agent-a'));
    await enqueueObservation(a, obs);
    const b = new LocalDb(localDbName('ORG', 'agent-b'));
    expect(await b.outbox.count()).toBe(0);
    await a.delete();
    const a2 = new LocalDb(localDbName('ORG', 'agent-a'));
    expect(await a2.outbox.count()).toBe(0);
    a2.close();
    b.close();
  });
});
