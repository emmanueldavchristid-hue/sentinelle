-- Authentification réelle (hors mode démonstration) et traçabilité des imports.
ALTER TABLE users ADD COLUMN username text UNIQUE;
ALTER TABLE users ADD COLUMN password_hash text;
ALTER TABLE users ADD COLUMN disabled boolean NOT NULL DEFAULT false;

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,          -- seul le hachage du jeton est stocké
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE import_batches (
  id uuid PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  author_id text NOT NULL REFERENCES users(id),
  file_hash text NOT NULL,
  row_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
