import type { ApiError } from '@sentinelle/contracts';

export interface Session {
  userId: string;
  name: string;
  role: 'AGENT' | 'VET' | 'FARMER';
  orgId: string;
  orgName: string;
}

const SESSION_KEY = 'sentinelle.session';
const SIM_KEY = 'sentinelle.simulatedOffline';

export function loadSession(): Session | null {
  try {
    const s = localStorage.getItem(SESSION_KEY);
    return s ? (JSON.parse(s) as Session) : null;
  } catch {
    return null;
  }
}
export function saveSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* stockage indisponible : session limitée à l'onglet */
  }
}

/** Simulation de coupure réseau (démonstration) : bloque les appels côté client. Nommée comme telle dans l'interface. */
let simulatedOffline = (() => {
  try {
    return localStorage.getItem(SIM_KEY) === '1';
  } catch {
    return false;
  }
})();
export const isSimulatedOffline = () => simulatedOffline;
export function setSimulatedOffline(v: boolean) {
  simulatedOffline = v;
  try {
    localStorage.setItem(SIM_KEY, v ? '1' : '0');
  } catch {
    /* ignoré */
  }
}

export class NetworkError extends Error {
  constructor(message = 'Serveur injoignable') {
    super(message);
  }
}
export class ApiFailure extends Error {
  constructor(
    public status: number,
    public body: ApiError & Record<string, unknown>,
  ) {
    super(body.message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; session?: Session | null; timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<T> {
  if (simulatedOffline) throw new NetworkError('Réseau coupé (simulation de démonstration)');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 8000);
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.session ? { 'x-demo-user': init.session.userId } : {}),
        ...(init.headers ?? {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    });
  } catch {
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new NetworkError('Réponse illisible du serveur');
  }
  if (!res.ok) {
    if (res.status >= 500 || !data || typeof data !== 'object') throw new NetworkError(`Erreur serveur (${res.status})`);
    throw new ApiFailure(res.status, data as ApiError & Record<string, unknown>);
  }
  return data as T;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiFailure || e instanceof NetworkError) return e.message;
  return 'Erreur inattendue';
}
