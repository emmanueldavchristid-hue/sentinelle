import { config, envFile, envFileLoaded } from './config.js';
import { checkAlertEmail, incidentMail, MailError, maskEmail, resendMailer } from './notify.js';

/**
 * Vérification de l'e-mail d'alerte : « pnpm alert:check » dit si la configuration est complète, sans rien envoyer.
 * « pnpm alert:check --envoyer » envoie UN message d'essai réel au destinataire de test configuré (ALERT_EMAIL_TO).
 * N'affiche jamais la clé ; le destinataire n'est affiché que masqué.
 */
const say = (s: string) => console.log(s);
const c = config.alertEmail;
say(`Fichier de configuration : ${envFileLoaded ? `${envFile} (chargé)` : `${envFile} (absent)`}`);
say(`ALERT_EMAIL : ${c.enabled ? 'on' : 'non activé'}`);
say(`Fournisseur : ${c.provider}`);
say(`RESEND_API_KEY : ${c.apiKey ? 'présente (valeur non affichée)' : 'absente'}`);
say(`ALERT_EMAIL_TO : ${c.to ? maskEmail(c.to) : 'absent'}`);
say(`ALERT_EMAIL_FROM : ${c.from}`);
say(`PUBLIC_URL : ${c.publicUrl || 'absente'}`);
const report = checkAlertEmail(c);
if (!report.ready) {
  say(`\nRésultat : l’e-mail d’alerte est DÉSACTIVÉ. ${report.reason}`);
  process.exit(1);
}
if (!process.argv.includes('--envoyer')) {
  say('\nRésultat : configuration complète. Rien n’a été envoyé. Pour envoyer un message d’essai réel au destinataire de test : pnpm alert:check --envoyer');
  process.exit(0);
}
const notifier = { mailer: resendMailer({ apiKey: c.apiKey, from: c.from }), to: c.to, publicUrl: c.publicUrl };
const message = incidentMail(notifier, { incidentId: 'INC-ESSAI', label: 'Essai', animalId: null, radiusM: 30, distanceM: 55, accuracyM: null, simulated: true, observedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') });
try {
  // Chaque essai est un message distinct : la clé d'idempotence porte l'instant de l'essai.
  const sent = await notifier.mailer.send({ ...message, subject: `[Sentinelle, essai d’envoi] ${message.subject}`, idempotencyKey: `sentinelle-essai/${Date.now()}` });
  say(`\nRésultat : message d’essai ACCEPTÉ par ${notifier.mailer.provider}${sent.id ? ` (identifiant ${sent.id})` : ''} pour ${maskEmail(c.to)}. Vérifiez la boîte de réception, et les indésirables : accepté ne veut pas dire reçu.`);
  process.exit(0);
} catch (e) {
  say(`\nRésultat : ÉCHEC de l’envoi. ${e instanceof MailError ? `${e.message} [${e.code}]` : 'Erreur inattendue.'}`);
  process.exit(1);
}
