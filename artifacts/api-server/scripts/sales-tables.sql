-- Additive development setup. Production schema is managed by the publish migration.
CREATE TABLE IF NOT EXISTS sales_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  customer_id text,
  natural_key text,
  payload jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_records_kind_idx ON sales_records(kind);
CREATE INDEX IF NOT EXISTS sales_records_customer_idx ON sales_records(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS sales_records_active_key_uq ON sales_records(natural_key) WHERE archived = false;
CREATE TABLE IF NOT EXISTS sales_record_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id uuid NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_record_activity_record_idx ON sales_record_activity(record_id);
