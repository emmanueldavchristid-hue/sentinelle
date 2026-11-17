-- Reformulations IA validées de la synthèse d'une analyse (la synthèse déterministe n'est pas stockée : elle se recalcule).
CREATE TABLE analysis_summaries (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  provider text NOT NULL,
  content jsonb NOT NULL,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
