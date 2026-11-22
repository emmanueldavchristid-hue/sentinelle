-- SENTINELLE VIVANT : balises de démonstration (contrat d'événement IoT minimal, pas une plateforme IoT).
-- Une balise est un téléphone qui transmet sa DISTANCE à un point de repère choisi par l'utilisateur.
-- Aucune coordonnée géographique n'est stockée : elles restent sur le téléphone.
CREATE TABLE devices (
  id text PRIMARY KEY,                       -- identifiant du dispositif (BAL-XXXX)
  org_id text NOT NULL REFERENCES organizations(id),
  label text NOT NULL,
  animal_id text REFERENCES animals(id),     -- animal auquel la balise est associée pour la démonstration
  token_hash text NOT NULL,                  -- seul le hachage du jeton de la balise est stocké
  radius_m integer NOT NULL DEFAULT 30 CHECK (radius_m BETWEEN 5 AND 500),
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz
);

CREATE TABLE device_readings (
  id bigserial PRIMARY KEY,
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES organizations(id),
  source text NOT NULL CHECK (source IN ('PHONE_GPS', 'SIMULATED')), -- origine de la mesure, visible dans chaque preuve
  observed_at timestamptz NOT NULL,          -- instant observé par le dispositif
  received_at timestamptz NOT NULL DEFAULT now(), -- instant reçu par le serveur
  distance_m real,                           -- distance au repère, en mètres (unité fixe) ; NULL = pas de position
  accuracy_m real,                           -- précision annoncée par le dispositif, en mètres
  zone text NOT NULL CHECK (zone IN ('INSIDE', 'OUTSIDE', 'UNCERTAIN', 'NO_FIX')) -- qualité / statut calculé par le serveur
);
CREATE INDEX device_readings_device ON device_readings(device_id, id DESC);
