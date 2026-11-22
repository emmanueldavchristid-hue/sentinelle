/**
 * E-mail d'alerte d'éloignement (demande de Yvan, 22/11) : UN message par épisode, avec un lien direct vers l'incident.
 *
 * Règles tenues ici :
 * - désactivé par défaut ; il faut une activation explicite (ALERT_EMAIL=on), une clé, un destinataire et une adresse publique ;
 * - le destinataire est fixé côté serveur (ALERT_EMAIL_TO) : c'est le destinataire de test approuvé. Rien de ce que saisit un
 *   utilisateur de l'application ne peut en désigner un autre ;
 * - le message ne contient ni coordonnée géographique, ni jeton, ni secret : seulement ce que l'incident a enregistré, et un
 *   lien que l'application ouvre avec son contrôle d'accès habituel ;
 * - le statut gardé est celui que le fournisseur a réellement renvoyé (« accepté », ou l'échec et sa raison). Un message accepté
 *   par le fournisseur n'est pas un message lu : l'application ne dit jamais « reçu par le destinataire » ;
 * - la clé voyage dans un en-tête, jamais dans une adresse, un journal ou un message d'erreur.
 *
 * Fournisseur par défaut : Resend (API HTTPS, relue dans sa documentation le 22/11/2026). Sans domaine vérifié, Resend n'envoie
 * qu'à l'adresse du compte, depuis onboarding@resend.dev : cela suffit pour un destinataire de test.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Un même incident ne part qu'une fois, même si l'appel est rejoué. */
  idempotencyKey: string;
}
export interface Mailer {
  readonly provider: string;
  send(m: MailMessage, signal?: AbortSignal): Promise<{ id: string | null }>;
}
export class MailError extends Error {
  constructor(
    public readonly code: 'KEY' | 'RECIPIENT' | 'QUOTA' | 'VALIDATION' | 'NETWORK' | 'PROVIDER',
    message: string,
  ) {
    super(message);
  }
}

const RESEND_BASE = 'https://api.resend.com';

export function resendMailer(opts: { apiKey: string; from: string; baseUrl?: string }): Mailer {
  const base = (opts.baseUrl || RESEND_BASE).replace(/\/+$/, '');
  const scrub = (s: string) => s.split(opts.apiKey).join('<clé>');
  return {
    provider: 'Resend',
    async send(m, signal) {
      let res: Response;
      try {
        res = await fetch(`${base}/emails`, {
          method: 'POST',
          signal,
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
            // Exigé par Resend : sans cet en-tête, la demande est refusée (403).
            'User-Agent': 'sentinelle-demo/1.0',
            'Idempotency-Key': m.idempotencyKey.slice(0, 256),
          },
          body: JSON.stringify({ from: opts.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
        });
      } catch {
        throw new MailError('NETWORK', 'Le service d’envoi est injoignable.');
      }
      const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; message?: string };
      if (res.ok) return { id: typeof body.id === 'string' ? body.id.slice(0, 80) : null };
      const detail = scrub(String(body.message ?? '')).slice(0, 200);
      const name = String(body.name ?? '');
      if (res.status === 429) throw new MailError('QUOTA', /daily|monthly/.test(name) ? 'Quota d’envoi du service atteint.' : 'Trop de demandes au service d’envoi.');
      if (/only send testing emails|domain is not verified/i.test(detail)) throw new MailError('RECIPIENT', 'Le service d’envoi refuse ce destinataire ou cet expéditeur : sans domaine vérifié, il n’envoie qu’à l’adresse du compte.');
      if (res.status === 401 || res.status === 403) throw new MailError('KEY', 'Le service d’envoi refuse la clé configurée.');
      if (res.status === 400 || res.status === 422) throw new MailError('VALIDATION', `Le service d’envoi refuse le message${detail ? ` : ${detail}` : '.'}`);
      throw new MailError('PROVIDER', `Le service d’envoi a répondu une erreur (${res.status}).`);
    },
  };
}

/** Adresse affichée sans l'exposer en entier : « y•••@exemple.com ». */
export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}•••@${domain}`;
}

export interface AlertEmailConfig {
  enabled: boolean;
  provider: string;
  apiKey: string;
  to: string;
  from: string;
  publicUrl: string;
}
export interface AlertEmailReport {
  ready: boolean;
  /** Raison lisible, sans valeur secrète. */
  reason: string | null;
}
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** L'envoi peut-il avoir lieu ? Sinon, pourquoi, en clair (nom de la variable à renseigner, jamais sa valeur). */
export function checkAlertEmail(c: AlertEmailConfig): AlertEmailReport {
  if (!c.enabled) return { ready: false, reason: 'E-mail d’alerte non activé (ALERT_EMAIL=on dans le fichier .env pour l’activer).' };
  if (c.provider !== 'resend') return { ready: false, reason: `Fournisseur d’envoi inconnu : ${c.provider}. Seul « resend » est pris en charge.` };
  if (!c.apiKey) return { ready: false, reason: 'RESEND_API_KEY n’est pas renseignée dans le fichier .env.' };
  if (/\s/.test(c.apiKey) || c.apiKey.length < 10) return { ready: false, reason: 'RESEND_API_KEY semble mal formée (espace ou longueur).' };
  if (!EMAIL_RE.test(c.to)) return { ready: false, reason: 'ALERT_EMAIL_TO doit contenir l’adresse du destinataire de test, et une seule.' };
  if (!/^https?:\/\/[^\s/]+/.test(c.publicUrl)) return { ready: false, reason: 'PUBLIC_URL doit contenir l’adresse publique de l’application (par exemple celle du tunnel), pour le lien du message.' };
  return { ready: true, reason: null };
}

/** Ce dont le reste du serveur a besoin pour prévenir par e-mail : rien si l'envoi n'est pas prêt. */
export interface AlertNotifier {
  mailer: Mailer;
  to: string;
  publicUrl: string;
}

export interface IncidentMailFacts {
  incidentId: string;
  label: string;
  animalId: string | null;
  radiusM: number;
  distanceM: number;
  accuracyM: number | null;
  simulated: boolean;
  /** Source de la mesure, en clair, quand ce n'est ni le GPS d'un téléphone ni une distance simulée (ex. position du navigateur d'un ordinateur). */
  sourceText?: string;
  /** Instant observé par la balise, déjà formaté à l'heure d'Abidjan. */
  observedAt: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Lien direct vers l'incident : aucun secret, aucun paramètre personnel ; l'application contrôle l'accès à l'ouverture. */
export const incidentLink = (publicUrl: string, incidentId: string) => `${publicUrl.replace(/\/+$/, '')}/#/elevage/incident/${encodeURIComponent(incidentId)}`;

export function incidentMail(n: AlertNotifier, f: IncidentMailFacts): MailMessage {
  const who = `La balise de démonstration « ${f.label} »${f.animalId ? `, associée à ${f.animalId},` : ''}`;
  const measure = `${Math.round(f.distanceM)} m du repère${f.accuracyM ? ` (précision ± ${Math.round(f.accuracyM)} m)` : ''}, pour un seuil de ${f.radiusM} m`;
  const source = f.simulated ? 'distance SIMULÉE à la main (ce n’est pas une mesure)' : (f.sourceText ?? 'GPS du téléphone');
  const link = incidentLink(n.publicUrl, f.incidentId);
  const lines = [
    'Démonstration SENTINELLE VIVANT, données synthétiques.',
    `${who} a été mesurée hors de sa zone le ${f.observedAt}.`,
    `Mesure : ${measure}. Source : ${source}.`,
    `Comprendre l’incident ${f.incidentId} : ${link}`,
    'La balise mesure sa propre distance à un repère, pas la position de l’animal. Un seul message est envoyé par épisode d’éloignement.',
    'Ce lien ne contient aucun secret : l’application applique son contrôle d’accès à l’ouverture.',
  ];
  const html = `<div style="font-family:Georgia,serif;font-size:16px;line-height:1.5;color:#1c2b27;max-width:560px">
<p style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#6b6257">${esc(lines[0]!)}</p>
<p style="font-size:19px;margin:8px 0"><b>${esc(lines[1]!)}</b></p>
<p>${esc(lines[2]!)}</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#0f5a56;color:#ffffff;padding:11px 18px;text-decoration:none;border-radius:4px">Comprendre l’incident ${esc(f.incidentId)}</a></p>
<p style="font-size:14px;color:#52605a">${esc(lines[4]!)}<br>${esc(lines[5]!)}</p>
</div>`;
  return { to: n.to, subject: `[Sentinelle, démonstration] Balise « ${f.label} » hors de sa zone`, text: lines.join('\n\n'), html, idempotencyKey: `sentinelle-incident/${f.incidentId}` };
}
