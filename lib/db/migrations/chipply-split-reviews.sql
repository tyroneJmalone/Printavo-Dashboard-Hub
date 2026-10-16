CREATE TABLE IF NOT EXISTS chipply_data_split_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES chipply_data_snapshots(id),
  process_key text NOT NULL,
  invoice_ids jsonb NOT NULL,
  evidence_hash text NOT NULL,
  action text NOT NULL CHECK (action IN ('approve', 'revoke')),
  reason text NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chipply_split_snapshot_idx ON chipply_data_split_reviews(snapshot_id);
