import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiFailure, isSimulatedOffline, loadSession, NetworkError, saveSession, setSimulatedOffline, type Session } from './api';
import { LocalDb, localDbName, recoverInterrupted, syncOutbox, type OutboxItem, type SendResult } from './local';

export type Connection = 'checking' | 'online' | 'offline';

interface Ctx {
  session: Session | null;
  login: (s: Session) => void;
  logout: () => Promise<void>;
  db: LocalDb | null;
  connection: Connection;
  lastCheck: string | null;
  checkConnection: () => Promise<boolean>;
  simulated: boolean;
  setSimulated: (v: boolean) => void;
  syncing: boolean;
  syncNow: (includeFailed?: boolean) => Promise<{ sent: number; failed: number } | null>;
  outboxVersion: number;
  bumpOutbox: () => void;
}

const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => {
  const c = useContext(AppCtx);
  if (!c) throw new Error('AppProvider manquant');
  return c;
};

/** Hash minimal : #/chemin/segment */
export function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [r, setR] = useState(read);
  useEffect(() => {
    const on = () => setR(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}
export const go = (path: string) => {
  window.location.hash = `#/${path}`;
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [connection, setConnection] = useState<Connection>('checking');
  const [lastCheck, setLastCheck] = useState<string | null>(null);
  const [simulated, setSim] = useState(isSimulatedOffline());
  const [syncing, setSyncing] = useState(false);
  const [outboxVersion, setOutboxVersion] = useState(0);
  const syncLock = useRef(false);

  const db = useMemo(() => (session ? new LocalDb(localDbName(session.orgId, session.userId)) : null), [session]);
  useEffect(() => {
    if (!db) return;
    recoverInterrupted(db).then((n) => n && setOutboxVersion((v) => v + 1));
    return () => db.close();
  }, [db]);

  /** Vérifie réellement le serveur (ne se fie pas à navigator.onLine). */
  const checkConnection = useCallback(async () => {
    try {
      await api('/api/health', { timeoutMs: 4000 });
      setConnection('online');
      setLastCheck(new Date().toISOString());
      return true;
    } catch {
      setConnection('offline');
      setLastCheck(new Date().toISOString());
      return false;
    }
  }, []);

  useEffect(() => {
    checkConnection();
    const t = setInterval(checkConnection, 15000);
    const on = () => checkConnection();
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      clearInterval(t);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, [checkConnection]);

  const setSimulated = useCallback(
    (v: boolean) => {
      setSimulatedOffline(v);
      setSim(v);
      checkConnection();
    },
    [checkConnection],
  );

  const login = useCallback((s: Session) => {
    saveSession(s);
    setSession(s);
  }, []);

  /** Déconnexion : purge des données locales de cet utilisateur (brouillons, file, cache). */
  const logout = useCallback(async () => {
    if (db) {
      db.close();
      await db.delete();
    }
    saveSession(null);
    setSession(null);
    go('');
  }, [db]);

  const syncNow = useCallback(
    async (includeFailed = false) => {
      if (!db || !session || syncLock.current) return null;
      syncLock.current = true;
      setSyncing(true);
      try {
        const send = async (item: OutboxItem): Promise<SendResult> => {
          try {
            const r = await api<{ observation: { receivedAt: string } }>('/api/sync/observations', { method: 'POST', body: item.payload, session });
            return { ok: true, receivedAt: r.observation.receivedAt };
          } catch (e) {
            if (e instanceof ApiFailure) {
              const fields = e.body.fields ? Object.values(e.body.fields as Record<string, string>).join(' ; ') : '';
              return { ok: false, permanent: e.status === 400 || e.status === 409, message: fields || e.message };
            }
            return { ok: false, permanent: false, message: e instanceof NetworkError ? e.message : 'Erreur inattendue' };
          }
        };
        const r = await syncOutbox(db, send, { includeFailed });
        await checkConnection();
        return r;
      } finally {
        syncLock.current = false;
        setSyncing(false);
        setOutboxVersion((v) => v + 1);
      }
    },
    [db, session, checkConnection],
  );

  const value: Ctx = {
    session,
    login,
    logout,
    db,
    connection,
    lastCheck,
    checkConnection,
    simulated,
    setSimulated,
    syncing,
    syncNow,
    outboxVersion,
    bumpOutbox: () => setOutboxVersion((v) => v + 1),
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

/** Chargement d'une ressource d'API avec états explicites. */
export function useResource<T>(path: string | null, deps: unknown[] = []) {
  const { session } = useApp();
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: !!path });
  const reload = useCallback(async () => {
    if (!path) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api<T>(path, { session });
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState((s) => ({ data: s.data, error, loading: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, session, ...deps]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { ...state, reload };
}
