import { useEffect, type ReactNode } from 'react';
import { formatInstant } from '@sentinelle/domain';
import { go, useApp } from '../state';
import { useDetailed } from '../farm/store';

const NAV = {
  FARMER: [
    ['elevage', 'Mon élevage'],
    ['animaux', 'Animaux'],
    ['envois', 'Déclarations'],
  ],
  AGENT: [
    ['elevage', 'Mon élevage'],
    ['animaux', 'Rechercher'],
    ['envois', 'Déclarations'],
    ['taches', 'Vérifications'],
  ],
  VET: [
    ['elevage', 'Mon élevage'],
    ['signalements', 'Signalements'],
    ['enquetes', 'Enquêtes'],
    ['import', 'Import'],
  ],
} as const;

export function ConnectionControl({ compact = false }: { compact?: boolean }) {
  const { connection, lastCheck, checkConnection, simulated, setSimulated, health } = useApp();
  // Affichage simple : l'interrupteur de simulation de coupure réseau est un outil de démonstration, masqué sauf s'il est actif.
  const detailed = useDetailed();
  const label = connection === 'online' ? 'Serveur joignable' : connection === 'offline' ? 'Hors connexion' : 'Vérification…';
  const cls = connection === 'online' ? 'border-petrol/30 bg-petrol-soft text-petrol' : connection === 'offline' ? 'border-amber-line bg-amber-soft text-amber' : '';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button className={`pill min-h-9 ${cls}`} onClick={() => checkConnection()} title="Vérifier la connexion au serveur">
        <span aria-hidden="true">{connection === 'online' ? '●' : connection === 'offline' ? '○' : '…'}</span>
        {label}
        {!compact && lastCheck && (
          <span className="num text-[12px] opacity-80" aria-hidden="true">
            · vérifié {formatInstant(Date.parse(lastCheck)).slice(11)}
          </span>
        )}
      </button>
      {/* Annoncé aux lecteurs d'écran seulement quand l'état change, pas à chaque vérification périodique. */}
      <span className="sr-only" role="status">
        {label}
      </span>
      {health?.demoMode !== false && (detailed || simulated) && (
        <label className="pill min-h-9 cursor-pointer" title="Bloque les appels réseau dans ce navigateur, pour la démonstration">
          <input type="checkbox" checked={simulated} onChange={(e) => setSimulated(e.target.checked)} />
          Couper le réseau <span className="text-ink-2">(simulation démo)</span>
        </label>
      )}
    </div>
  );
}

export function Shell({ current, children, header, title }: { current: string; children: ReactNode; header?: ReactNode; title?: string }) {
  const { session, logout, health } = useApp();
  useEffect(() => {
    if (title) document.title = `${title} · Sentinelle Vivant (démonstrateur)`;
  }, [title]);
  if (!session) return null;
  const demo = health?.demoMode !== false;
  const nav = NAV[session.role];
  return (
    <div className="min-h-screen">
      <div className="bg-encre px-3 py-1 text-center text-[12.5px] text-white" role="note">
        {demo ? 'Démonstrateur · données entièrement synthétiques · mode démonstration (pas d’authentification sécurisée)' : 'Prototype · données de démonstration synthétiques · session authentifiée'}
      </div>
      <header className="no-print border-b border-filet bg-papier">
        <div className="mx-auto flex max-w-[1340px] flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2 md:px-8">
          <a href="#/elevage" className="flex items-center gap-2 text-encre no-underline" aria-label="Sentinelle Vivant, mon élevage">
            <img src="/icon.svg" alt="" width={30} height={30} />
            <span className="v-display text-[20px]">Sentinelle Vivant</span>
          </a>
          <nav aria-label="Navigation principale" className="hidden md:block">
            <ul className="flex items-center gap-1">
              {nav.map(([path, label]) => (
                <li key={path}>
                  <a
                    href={`#/${path}`}
                    aria-current={current === path ? 'page' : undefined}
                    className={`flex min-h-11 items-center border-b-2 px-3 text-[15px] font-semibold ${current === path ? 'border-encre text-encre' : 'border-transparent text-encre-2 hover:text-encre'}`}
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <ConnectionControl compact />
            <span className="hidden text-right text-[13px] leading-tight text-encre-2 lg:block">
              <b className="block text-encre">{session.name}</b>
              {session.orgName}
            </span>
            <button className="btn btn-sm" onClick={() => logout()} title="Purge les données locales de cet utilisateur">
              {demo ? 'Changer de rôle' : 'Se déconnecter'}
            </button>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-[1340px] pb-20 md:pb-0">
        {header && <div className="no-print px-3 pt-4 text-[15px] md:px-8">{header}</div>}
        <main id="contenu" className="p-3 md:px-8 md:py-6">
          {children}
        </main>
      </div>
      <nav aria-label="Navigation mobile" className="no-print fixed inset-x-0 bottom-0 z-10 flex border-t border-filet bg-papier md:hidden">
        {nav.map(([path, label]) => (
          <button key={path} onClick={() => go(path)} aria-current={current === path ? 'page' : undefined} className={`min-h-14 flex-1 text-sm font-semibold ${current === path ? 'text-encre shadow-[inset_0_3px_0_var(--color-encre)]' : 'text-encre-2'}`}>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
