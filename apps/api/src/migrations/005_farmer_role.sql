-- SENTINELLE VIVANT : rôle « éleveur », premier utilisateur de l'exploitation (lecture de sa situation, observations confirmées).
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('AGENT', 'VET', 'FARMER'));
-- Base de démonstration déjà chargée : ajoute l'éleveur de démonstration sans toucher aux autres données.
INSERT INTO users(id, org_id, name, role)
  SELECT 'U-ELEVEUR', 'ORG-DEMO', 'Éleveur (démo)', 'FARMER'
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = 'ORG-DEMO')
  ON CONFLICT (id) DO NOTHING;
