-- SENTINELLE VIVANT : e-mail d'alerte d'un incident d'éloignement (un par épisode, envoi facultatif et activé explicitement).
-- On garde le statut réellement renvoyé par le fournisseur, jamais une supposition. L'adresse du destinataire n'est pas
-- stockée en entier : seulement sa forme masquée, telle qu'elle est affichée.
-- email_message_id : identifiant rendu par le fournisseur quand il accepte le message.
-- email_at : instant de la réponse du fournisseur. email_error : raison lisible de l'échec, sans secret.
ALTER TABLE device_incidents ADD COLUMN email_status text CHECK (email_status IN ('SENDING', 'SENT', 'FAILED'));
ALTER TABLE device_incidents ADD COLUMN email_provider text;
ALTER TABLE device_incidents ADD COLUMN email_to_masked text;
ALTER TABLE device_incidents ADD COLUMN email_message_id text;
ALTER TABLE device_incidents ADD COLUMN email_at timestamptz;
ALTER TABLE device_incidents ADD COLUMN email_error text;
