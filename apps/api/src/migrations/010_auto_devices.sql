-- SENTINELLE VIVANT : suivi automatique des appareils et repère commun (mode démonstration).
-- Tout appareil qui ouvre le lien de l'application et autorise sa position devient une balise, sans association manuelle.
-- Le navigateur envoie sa position au serveur, qui calcule la distance et le décalage est/nord par rapport au repère de
-- l'organisation. Les coordonnées d'une MESURE ne sont jamais stockées : device_readings ne garde que des mètres.
-- Seule la position du REPÈRE est gardée (table org_anchors), et aucune route ne la renvoie.

-- origin : distingue une balise enregistrée automatiquement (AUTO) d'une balise associée à la main (MANUAL).
-- kind : ce que le navigateur dit être (téléphone ou ordinateur), s'il le dit. auto_seq : numéro du nom « Appareil N ».
ALTER TABLE devices ADD COLUMN origin text NOT NULL DEFAULT 'MANUAL' CHECK (origin IN ('MANUAL', 'AUTO'));
ALTER TABLE devices ADD COLUMN kind text CHECK (kind IN ('PHONE', 'COMPUTER'));
ALTER TABLE devices ADD COLUMN auto_seq integer;
CREATE UNIQUE INDEX devices_auto_seq ON devices(org_id, auto_seq) WHERE auto_seq IS NOT NULL;

-- Repère commun d'une organisation : un seul, pris à la première position reçue, déplaçable sur un appareil suivi.
-- seq augmente à chaque déplacement : une mesure porte le numéro du repère par rapport auquel elle a été calculée.
CREATE TABLE org_anchors (
  org_id text PRIMARY KEY REFERENCES organizations(id),
  seq integer NOT NULL DEFAULT 1,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  accuracy_m real,
  set_at timestamptz NOT NULL DEFAULT now(),
  set_by_device text,
  set_by_label text,
  set_how text NOT NULL CHECK (set_how IN ('FIRST_POSITION', 'MOVED'))
);

-- anchor_seq : NULL pour une mesure dont le repère est resté sur le téléphone (balise associée à la main).
ALTER TABLE device_readings ADD COLUMN anchor_seq integer;

-- Nouvelle source : position donnée par le navigateur d'un appareil qui ne se dit pas téléphone (un ordinateur n'a en
-- général pas de GPS). Nouveau motif de fin d'incident : le repère a été déplacé.
ALTER TABLE device_readings DROP CONSTRAINT device_readings_source_check;
ALTER TABLE device_readings ADD CONSTRAINT device_readings_source_check CHECK (source IN ('PHONE_GPS', 'BROWSER_POSITION', 'SIMULATED'));
ALTER TABLE device_incidents DROP CONSTRAINT device_incidents_source_check;
ALTER TABLE device_incidents ADD CONSTRAINT device_incidents_source_check CHECK (source IN ('PHONE_GPS', 'BROWSER_POSITION', 'SIMULATED'));
ALTER TABLE device_incidents DROP CONSTRAINT device_incidents_close_reason_check;
ALTER TABLE device_incidents ADD CONSTRAINT device_incidents_close_reason_check CHECK (close_reason IN ('BACK_INSIDE', 'DEVICE_STOPPED', 'ANCHOR_MOVED'));
