import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { api, ApiFailure, errorMessage } from './api';
import { AppProvider, go, useApp, useRoute } from './state';
import { Shell, ConnectionControl } from './components/Shell';
import { Banner, ErrorView, Loading } from './components/ui';
import { AgentTasks, AnimalCard, AnimalSearch, ObservationForm, Outbox, TaskCorrection } from './pages/agent';
import { InvestigationList, Review, Signals } from './pages/vet';
import { ImportPage } from './pages/import';
import { QrScan } from './pages/qr';
import { InvestigationConsole } from './pages/console';
import { Report } from './pages/report';

interface DemoUser {
  id: string;
  name: string;
  role: 'AGENT' | 'VET' | 'FARMER';
  org_id: string;
  org_name: string;
}

function LoginForm() {
  const { login } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) return setError('Saisissez votre identifiant et votre mot de passe.');
    setBusy(true);
    try {
      const u = await api<{ id: string; name: string; role: 'AGENT' | 'VET' | 'FARMER'; org_id: string; orgName: string }>('/api/auth/login', { method: 'POST', body: { username: username.trim(), password } });
      setPassword('');
      login({ userId: u.id, name: u.name, role: u.role, orgId: u.org_id, orgName: u.orgName });
      go(u.role === 'AGENT' ? 'animaux' : 'signalements');
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card space-y-3 p-4" onSubmit={submit} noValidate aria-labelledby="login-h">
      <h2 id="login-h" className="text-base font-semibold">
        Connexion
      </h2>
      <div className="field">
        <label htmlFor="login-user">Identifiant</label>
        <input id="login-user" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="login-pass">Mot de passe</label>
        <input id="login-pass" type="password" className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <button className="btn btn-primary w-full" disabled={busy}>
        {busy ? 'Connexion…' : 'Se connecter'}
      </button>
      <p className="hint">Les comptes sont créés par un administrateur (commande « pnpm user:create »).</p>
    </form>
  );
}

function Home() {
  const { health, connection } = useApp();
  if (!health) {
    return connection === 'offline' ? (
      <div className="mx-auto max-w-xl p-6">
        <ErrorView error={new ApiFailure(503, { error: 'OFFLINE', message: 'Serveur injoignable : la première connexion nécessite le réseau.' })} />
      </div>
    ) : (
      <Loading />
    );
  }
  return health.demoMode ? <RolePicker /> : <AuthPage />;
}

function AuthPage() {
  return (
    <div className="min-h-screen">
      <div className="bg-ink px-3 py-1 text-center text-xs text-white" role="note">
        Prototype — données de démonstration synthétiques
      </div>
      <main className="mx-auto max-w-md space-y-4 p-4 pt-10">
        <div className="flex items-center gap-3">
          <img src="/icon.svg" alt="" width={44} height={44} />
          <div>
            <h1 className="text-2xl font-bold">Sentinelle</h1>
            <p className="text-ink-2">Du signalement à l’enquête, chaque mouvement compte.</p>
          </div>
        </div>
        <LoginForm />
        <ConnectionControl />
      </main>
    </div>
  );
}

function RolePicker() {
  const { login } = useApp();
  const [users, setUsers] = useState<DemoUser[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [demo, setDemo] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const load = () =>
    api<{ users: DemoUser[] }>('/api/demo/users')
      .then((r) => (setUsers(r.users), setError(null)))
      .catch(setError);
  useEffect(() => {
    load();
    api<{ demoMode: boolean }>('/api/health').then((h) => setDemo(h.demoMode)).catch(() => {});
  }, []);
  const reset = async (withObservation: boolean) => {
    if (!window.confirm('Réinitialiser toutes les données de démonstration ? Cette action efface les enquêtes et corrections.')) return;
    try {
      await api('/api/demo/reset', { method: 'POST', body: { withObservation }, headers: { 'x-sentinelle-demo': 'reset' } });
      setResetMsg(withObservation ? 'Données réinitialisées, avec le signalement B-017 déjà reçu.' : 'Données réinitialisées (scénario B-017, sans signalement).');
    } catch (e) {
      setResetMsg(errorMessage(e));
    }
  };
  return (
    <div className="min-h-screen">
      <div className="bg-ink px-3 py-1 text-center text-xs text-white" role="note">
        Démonstrateur — données entièrement synthétiques
      </div>
      <main className="mx-auto max-w-xl space-y-4 p-4 pt-10">
        <div className="flex items-center gap-3">
          <img src="/icon.svg" alt="" width={44} height={44} />
          <div>
            <h1 className="text-2xl font-bold">Sentinelle</h1>
            <p className="text-ink-2">Du signalement à l’enquête, chaque mouvement compte.</p>
          </div>
        </div>
        <section className="card p-4" aria-labelledby="role-h">
          <h2 id="role-h" className="text-base font-semibold">
            Choisir un rôle
          </h2>
          <p className="hint mb-3">Mode démonstration : sélecteur de rôle, sans authentification sécurisée. Ne pas utiliser pour une mise en ligne.</p>
          {error ? <ErrorView error={error} onRetry={load} /> : null}
          {!users && !error ? <Loading /> : null}
          <ul className="space-y-2">
            {users && [...users].sort((a, b) => Number(a.org_id !== 'ORG-DEMO') - Number(b.org_id !== 'ORG-DEMO')).map((u) => (
              <li key={u.id}>
                <button
                  className="btn w-full flex-wrap justify-between gap-x-3 whitespace-normal text-left"
                  onClick={() => {
                    login({ userId: u.id, name: u.name, role: u.role, orgId: u.org_id, orgName: u.org_name });
                    go(u.role === 'AGENT' ? 'animaux' : 'signalements');
                  }}
                >
                  <span>{u.name}</span>
                  <span className="text-xs text-ink-2">{u.org_name}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <ConnectionControl />
        {demo && (
          <details className="card p-4">
            <summary className="cursor-pointer font-semibold">Préparation de la démonstration</summary>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn btn-sm" onClick={() => reset(false)}>
                Réinitialiser le scénario
              </button>
              <button className="btn btn-sm" onClick={() => reset(true)}>
                Réinitialiser avec signalement reçu (secours)
              </button>
            </div>
            <p className="hint mt-2">Pensez aussi à « Changer de rôle » pour purger les données locales de l’agent.</p>
            {resetMsg && (
              <div className="mt-2">
                <Banner tone="info">{resetMsg}</Banner>
              </div>
            )}
          </details>
        )}
      </main>
    </div>
  );
}

function Router() {
  const { session } = useApp();
  const [page, arg, arg2] = useRoute();
  if (!session) return <Home />;
  if (session.role === 'AGENT') {
    switch (page) {
      case 'animal':
        return <Shell current="animaux" header={<span className="font-semibold">Fiche animale</span>}>{arg ? <AnimalCard id={arg} /> : null}</Shell>;
      case 'declarer':
        return <Shell current="animaux" header={<span className="font-semibold">Déclaration terrain</span>}>{arg ? <ObservationForm animalId={arg} /> : null}</Shell>;
      case 'envois':
        return <Shell current="envois" header={<span className="font-semibold">Déclarations</span>}><Outbox /></Shell>;
      case 'taches':
        return <Shell current="taches" header={<span className="font-semibold">Vérifications</span>}><AgentTasks /></Shell>;
      case 'scan':
        return <Shell current="animaux" header={<span className="font-semibold">Scanner un QR code</span>}><QrScan /></Shell>;
      case 'tache':
        return <Shell current="taches" header={<span className="font-semibold">Compléter une information</span>}>{arg ? <TaskCorrection taskId={arg} /> : null}</Shell>;
      default:
        return <Shell current="animaux" header={<span className="font-semibold">Rechercher un animal</span>}><AnimalSearch /></Shell>;
    }
  }
  switch (page) {
    case 'signalement':
      return <Shell current="signalements" header={<span className="font-semibold">Examen</span>}>{arg ? <Review id={arg} /> : null}</Shell>;
    case 'rapport':
      return <Shell current="enquetes" header={<span className="font-semibold">Rapport d’enquête</span>}>{arg ? <Report id={arg} seq={Number(arg2) || 1} /> : null}</Shell>;
    case 'import':
      return <Shell current="import" header={<span className="font-semibold">Import de données</span>}><ImportPage /></Shell>;
    case 'enquetes':
      return <Shell current="enquetes" header={<span className="font-semibold">Enquêtes</span>}><InvestigationList /></Shell>;
    case 'enquete':
      return <Shell current="enquetes" header={<span className="font-semibold">Console d’enquête</span>}>{arg ? <InvestigationConsole id={arg} /> : null}</Shell>;
    default:
      return <Shell current="signalements" header={<span className="font-semibold">Signalements</span>}><Signals /></Shell>;
  }
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <Router />
    </AppProvider>
  </StrictMode>,
);
