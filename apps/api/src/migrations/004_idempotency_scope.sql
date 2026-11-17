-- Clés d'idempotence limitées à (organisation, utilisateur, opération, cible) et liées au contenu de la requête.
ALTER TABLE idempotent_ops ADD COLUMN org_id text;
ALTER TABLE idempotent_ops ADD COLUMN user_id text;
ALTER TABLE idempotent_ops ADD COLUMN target text;
ALTER TABLE idempotent_ops ADD COLUMN request_hash text;
