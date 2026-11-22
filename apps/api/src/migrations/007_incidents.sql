-- SENTINELLE VIVANT : incident d'éloignement d'une balise de démonstration.
-- Un incident couvre UN épisode : il s'ouvre à la première mesure « hors zone » et se ferme quand la balise est de nouveau
-- mesurée dans la zone, ou quand elle est arrêtée. Les mesures suivantes du même épisode ne créent pas d'autre incident.
-- Il garde les faits qui l'ont justifié (mesure, précision, seuil, source, règle), pas de coordonnées géographiques.
CREATE TABLE device_incidents (
  id text PRIMARY KEY,                        -- INC-XXXXX
  org_id text NOT NULL REFERENCES organizations(id),
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  animal_id text,                             -- association de démonstration au moment de l'incident
  label text NOT NULL,                        -- nom de la balise au moment de l'incident
  rule text NOT NULL,                         -- règle appliquée, en clair
  radius_m integer NOT NULL,                  -- seuil au moment de l'incident
  source text NOT NULL CHECK (source IN ('PHONE_GPS', 'SIMULATED')),
  opened_at timestamptz NOT NULL DEFAULT now(), -- réception par le serveur de la mesure qui a ouvert l'incident
  trigger_observed_at timestamptz NOT NULL,   -- instant observé par la balise
  trigger_distance_m real NOT NULL,
  trigger_accuracy_m real,
  max_distance_m real NOT NULL,
  closed_at timestamptz,
  close_reason text CHECK (close_reason IN ('BACK_INSIDE', 'DEVICE_STOPPED'))
);
-- Un seul incident ouvert par balise : c'est ce qui évite les doublons.
CREATE UNIQUE INDEX device_incidents_open ON device_incidents(device_id) WHERE closed_at IS NULL;
CREATE INDEX device_incidents_org ON device_incidents(org_id, opened_at DESC);
