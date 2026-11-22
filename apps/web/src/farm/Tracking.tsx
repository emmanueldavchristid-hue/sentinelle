import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useApp, useRoute } from '../state';
import { attachBrowser, AutoTracker, browserBlocked, browserEnv } from './tracker';

/**
 * Bandeau de transparence du suivi automatique, monté une fois pour toute l'application (toutes les pages, tous les rôles).
 * En mode démonstration, tout appareil qui ouvre le lien et autorise sa position est suivi comme balise : ce bandeau le dit sur
 * l'appareil lui-même, tant que c'est vrai, avec « Arrêter le suivi ». Il reste en haut de l'écran pendant le suivi.
 * Quand l'appareil n'est pas suivi (position refusée, indisponible, page hors https, suivi arrêté), il le dit en une ligne,
 * sans rien bloquer.
 * Pas sur la page « balise » : elle a son propre parcours (association à la main), et un appareil n'est pas suivi deux fois.
 */
const tracker = new AutoTracker(browserEnv());

const clock = (ms: number) => new Date(ms).toLocaleTimeString('fr-FR', { timeZone: 'Africa/Abidjan', hour12: false });

export function TrackingBanner() {
  const { health } = useApp();
  const [page] = useRoute();
  const enabled = health?.demoMode === true && page !== 'balise';
  const state = useSyncExternalStore(tracker.subscribe, tracker.getState);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!enabled) return;
    return attachBrowser(tracker);
  }, [enabled]);

  const shown = enabled && state.phase !== 'off';
  const on = state.phase === 'tracking' || (state.phase === 'waiting' && state.label !== null);
  // Le bandeau reste en haut de l'écran pendant le suivi : les panneaux qui se fixent en haut au défilement se décalent d'autant.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!shown || !on || !el) {
      root.style.removeProperty('--suivi-h');
      return;
    }
    const apply = () => root.style.setProperty('--suivi-h', `${el.offsetHeight}px`);
    apply();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty('--suivi-h');
    };
  }, [shown, on]);

  if (!shown) return null;
  const name = state.label ? `« ${state.label} »` : null;
  const stop = (
    <button type="button" className="v-track-btn" onClick={() => void tracker.stopByUser()}>
      Arrêter le suivi
    </button>
  );
  const resume = (
    <button type="button" className="v-track-btn" onClick={() => tracker.resume(browserBlocked())}>
      Reprendre le suivi
    </button>
  );

  let text: React.ReactNode;
  let detail: React.ReactNode = null;
  let action: React.ReactNode = null;
  switch (state.phase) {
    case 'tracking':
      text = (
        <>
          Cet appareil est suivi comme balise <b>{name}</b> : sa position est envoyée au serveur de démonstration.
        </>
      );
      detail = state.sendError ? (
        <>Envoi interrompu ({state.sendError.replace(/\.$/, '')}) : sans nouvel envoi, l’appareil sera dit muet.</>
      ) : state.stale ? (
        <>
          Aucune nouvelle position depuis <span className="num">{clock(state.lastSentAt!)}</span> : l’appareil est dit muet.
        </>
      ) : (
        <>
          Dernière position envoyée à <span className="num">{clock(state.lastSentAt!)}</span>
          {state.lastAccuracyM !== null ? ` (± ${Math.round(state.lastAccuracyM)} m)` : ''}.
        </>
      );
      action = stop;
      break;
    case 'waiting':
      text = name ? (
        <>
          Cet appareil est suivi comme balise <b>{name}</b> : sa position est envoyée au serveur de démonstration.
        </>
      ) : (
        <>Cet appareil va être suivi comme balise : sa position sera envoyée au serveur de démonstration dès que le navigateur la donnera.</>
      );
      detail = state.sendError ? `Envoi interrompu (${state.sendError.replace(/\.$/, '')}).` : 'En attente d’une position (le navigateur demande l’autorisation).';
      action = stop;
      break;
    case 'full':
      text = <>Cet appareil n’est pas suivi comme balise. {state.sendError}</>;
      action = stop;
      break;
    case 'denied':
      text = <>Position refusée par le navigateur : cet appareil n’est pas suivi comme balise. Pour qu’il le soit, autorisez la position pour ce site, puis rechargez la page.</>;
      break;
    case 'unavailable':
      text = <>Position indisponible sur cet appareil pour l’instant : il n’est pas suivi comme balise.</>;
      action = stop;
      break;
    case 'insecure':
      text = <>Cette page n’est pas ouverte en https : le navigateur ne donne pas la position, cet appareil n’est pas suivi comme balise.</>;
      break;
    case 'unsupported':
      text = <>Ce navigateur ne donne pas accès à la position : cet appareil n’est pas suivi comme balise.</>;
      break;
    case 'stopped':
      text = <>Suivi arrêté sur cet appareil : sa position n’est plus envoyée.</>;
      action = resume;
      break;
    case 'stopped-remote':
      text = <>Le suivi de cet appareil a été arrêté depuis l’écran de l’éleveur : sa position n’est plus envoyée.</>;
      action = resume;
      break;
    default:
      return null;
  }

  return (
    <section ref={ref} className="v-track no-print" data-on={on ? 'true' : undefined} aria-label="Suivi de cet appareil">
      <p className="v-track-text">
        {/* L'état est écrit en toutes lettres ; le signe ne fait que le rappeler. */}
        <span aria-hidden="true">{on ? '◉ ' : '○ '}</span>
        {text}
        {detail && (
          <span className="v-track-detail" data-warn={state.sendError || state.stale ? 'true' : undefined}>
            {' '}
            {detail}
          </span>
        )}
      </p>
      {action}
    </section>
  );
}
