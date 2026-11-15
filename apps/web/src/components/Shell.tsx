import type { ReactNode } from 'react';
import { formatInstant } from '@sentinelle/domain';
import { go, useApp } from '../state';

const NAV = {
  AGENT: [
    ['animaux', 'Rechercher'],
    ['envois', 'Déclarations'],
    ['taches', 'Vérifications'],
  ],
  VET: [
    ['signalements', 'Signalements'],
    ['enquetes', 'Enquêtes'],
    ['import', 'Import'],
  ],
} as const;

export function ConnectionControl({ compact = false }: { compact?: boolean }) {
  const { connection, lastCheck, checkConnection, simulated, setSimulated, health } = useApp();
  const label = connection === 'online' ? 'Serveur joignable' : connection === 'offline' ? 'Hors connexion' : 'Vérification…';
  const cls = connection === 'online' ? 'border-petrol/30 bg-petrol-soft text-petrol' : connection === 'offline' ? 'border-amber-line bg-amber-soft text-amber' : '';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button className={`pill min-h-9 ${cls}`} onClick={() => checkConnection()} title="Vérifier la connexion au serveur" aria-live="polite">
        <span aria-hidden="true">{connection === 'online' ? '●' : connection === 'offline' ? '○' : '…'}</span>
        {label}
        {!compact && lastCheck && <span className="num text-[11px] opacity-80">· vérifié {formatInstant(Date.parse(lastCheck)).slice(11)}</span>}
      </button>
      {health?.demoMode !== false && (
      <label className="pill min-h-9 cursor-pointer" title="Bloque les appels réseau dans ce navigateur, pour la démonstration">
        <input type="checkbox" checked={simulated} onChange={(e) => setSimulated(e.target.checked)} />
        Couper le réseau <span className="text-muted">(simulation démo)</span>
      </label>
      )}
    </div>
  );
}

export function Shell({ current, children, header }: { current: string; children: ReactNode; header?: ReactNode }) {
  const { session, logout, health } = useApp();
  if (!session) return null;
  const demo = health?.demoMode !== false;
  const nav = NAV[session.role];
  return (
    <div className="min-h-screen">
      <div className="bg-ink px-3 py-1 text-center text-xs text-white" role="note">
        {demo ? 'Démonstrateur — données entièrement synthétiques — mode démonstration (pas d’authentification sécurisée)' : 'Prototype — données de démonstration synthétiques — session authentifiée'}
      </div>
      <div className="md:grid md:grid-cols-[200px_1fr]">
        <nav aria-label="Navigation principale" className="no-print hidden border-r border-line bg-surface p-3 md:block">
          <div className="mb-4 flex items-center gap-2 px-2">
            <img src="/icon.svg" alt="" width={32} height={32} />
            <span className="text-base font-bold">Sentinelle</span>
          </div>
          <ul className="space-y-1">
            {nav.map(([path, label]) => (
              <li key={path}>
                <a
                  href={`#/${path}`}
                  aria-current={current === path ? 'page' : undefined}
                  className={`flex min-h-11 items-center rounded-lg px-3 font-medium ${current === path ? 'bg-petrol-soft text-petrol' : 'text-ink-2 hover:bg-surface-2'}`}
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-6 border-t border-line px-2 pt-4 text-xs text-ink-2">
            <p className="font-semibold text-ink">{session.name}</p>
            <p>{session.orgName}</p>
            <button className="btn btn-sm mt-3 w-full" onClick={() => logout()}>
              {demo ? 'Changer de rôle' : 'Se déconnecter'}
            </button>
            <p className="mt-2 text-[11px]">Purge les données locales de cet utilisateur.</p>
          </div>
        </nav>
        <div className="min-w-0 pb-20 md:pb-0">
          <header className="no-print flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3 md:px-6">
            <div className="flex items-center gap-2 md:hidden">
              <img src="/icon.svg" alt="" width={28} height={28} />
              <span className="font-bold">Sentinelle</span>
            </div>
            <div className="min-w-0 flex-1">{header}</div>
            <ConnectionControl />
            <button className="btn btn-sm md:hidden" onClick={() => logout()}>
              {demo ? 'Changer de rôle' : 'Se déconnecter'}
            </button>
          </header>
          <main id="contenu" className="p-3 md:p-6">
            {children}
          </main>
        </div>
      </div>
      <nav aria-label="Navigation mobile" className="no-print fixed inset-x-0 bottom-0 z-10 flex border-t border-line bg-surface md:hidden">
        {nav.map(([path, label]) => (
          <button
            key={path}
            onClick={() => go(path)}
            aria-current={current === path ? 'page' : undefined}
            className={`min-h-14 flex-1 text-sm font-medium ${current === path ? 'text-petrol' : 'text-ink-2'}`}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
