-- Sentinelle — schéma initial. Données de démonstration uniquement.
CREATE TABLE organizations (id text PRIMARY KEY, name text NOT NULL);

CREATE TABLE users (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('AGENT', 'VET'))
);

CREATE TABLE locations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('FARM', 'MARKET')),
  pos_x real,
  pos_y real
);

CREATE TABLE animals (
  id text PRIMARY KEY,                 -- identifiant interne
  org_id text NOT NULL REFERENCES organizations(id),
  tag text NOT NULL,                   -- identifiant externe (boucle, démo)
  species text NOT NULL DEFAULT 'bovin'
);

-- Révisions en ajout seul : une correction crée rev + 1, rien n'est écrasé.
CREATE TABLE record_revisions (
  record_id text NOT NULL,
  rev integer NOT NULL CHECK (rev >= 1),
  org_id text NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('presence', 'movement')),
  data jsonb NOT NULL,
  author_id text,
  reason text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (record_id, rev)
);

CREATE TABLE observations (
  id uuid PRIMARY KEY,                 -- identifiant client
  idempotency_key uuid NOT NULL UNIQUE,
  payload_version integer NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  animal_id text NOT NULL REFERENCES animals(id),
  location_id text NOT NULL REFERENCES locations(id),
  event_time jsonb NOT NULL,           -- heure de l'événement (avec précision)
  note text NOT NULL,
  author_id text NOT NULL REFERENCES users(id),
  recorded_at_client timestamptz NOT NULL, -- heure de saisie
  received_at timestamptz NOT NULL DEFAULT now(), -- heure de réception serveur
  status text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'UNDER_INVESTIGATION', 'CLOSED')),
  reviewed_by text REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text
);

CREATE TABLE investigations (
  id uuid PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  observation_id uuid NOT NULL UNIQUE REFERENCES observations(id),
  status text NOT NULL DEFAULT 'OPEN',
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Chaque analyse conserve ses paramètres, la version du moteur et l'instantané des données utilisées.
CREATE TABLE analysis_runs (
  id uuid PRIMARY KEY,
  investigation_id uuid NOT NULL REFERENCES investigations(id),
  seq integer NOT NULL,
  engine_version text NOT NULL,
  params jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  output jsonb NOT NULL,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (investigation_id, seq)
);

CREATE TABLE verification_tasks (
  id uuid PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  investigation_id uuid NOT NULL REFERENCES investigations(id),
  record_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('COMPLETE_PRESENCE', 'CHECK_RECORD')),
  label text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'REQUESTED', 'DONE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  requested_at timestamptz,
  done_at timestamptz,
  done_rev integer,
  UNIQUE (investigation_id, record_id, kind)
);

-- Déduplication des opérations rejouées (réponse perdue, double envoi).
CREATE TABLE idempotent_ops (
  key uuid PRIMARY KEY,
  op text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  org_id text,
  actor_id text,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text NOT NULL,
  detail jsonb
);
