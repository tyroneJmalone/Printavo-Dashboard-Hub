-- Scoped additive migration: no unrelated schema changes and no deletes.
BEGIN;
CREATE TABLE IF NOT EXISTS printscope_rule_versions (
 id serial PRIMARY KEY, rows jsonb NOT NULL, csv text NOT NULL, hash text NOT NULL,
 created_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS printscope_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment text NOT NULL,
 state text NOT NULL, filename text NOT NULL, byte_size integer NOT NULL,
 content_type text NOT NULL, source_path text NOT NULL, generation text, sha256 text,
 rule_version_id integer NOT NULL REFERENCES printscope_rule_versions(id),
 submitted_by uuid NOT NULL, parent_job_id uuid, result jsonb, assets jsonb, error jsonb,
 attempts integer NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS printscope_queue_idx ON printscope_jobs(environment,state,created_at);
CREATE TABLE IF NOT EXISTS printscope_pilots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment text NOT NULL UNIQUE,
 rule_version_id integer NOT NULL REFERENCES printscope_rule_versions(id),
 created_by uuid NOT NULL, started_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 purge_after timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT printscope_pilot_dates_ck CHECK (
   ends_at = started_at + interval '14 days'
   AND purge_after = ends_at + interval '30 days'
 )
);
ALTER TABLE printscope_jobs ADD COLUMN IF NOT EXISTS pilot_id uuid REFERENCES printscope_pilots(id);
ALTER TABLE printscope_jobs ADD COLUMN IF NOT EXISTS pilot_source_id uuid;
ALTER TABLE printscope_jobs ADD COLUMN IF NOT EXISTS pilot_provenance jsonb;
ALTER TABLE printscope_jobs ADD COLUMN IF NOT EXISTS assets_expired_at timestamptz;
ALTER TABLE printscope_jobs ADD COLUMN IF NOT EXISTS cleanup_attempted_at timestamptz;
ALTER TABLE printscope_jobs ADD COLUMN IF NOT EXISTS cleanup_error text;
CREATE UNIQUE INDEX IF NOT EXISTS printscope_pilot_import_uq
 ON printscope_jobs(environment,pilot_id,pilot_source_id,sha256,rule_version_id)
 WHERE pilot_id IS NOT NULL AND parent_job_id IS NULL;
CREATE TABLE IF NOT EXISTS printscope_pilot_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 job_id uuid NOT NULL REFERENCES printscope_jobs(id),
 outcome text NOT NULL CHECK (outcome IN ('pass','flag','fail','uncertain')),
 reason text, note text, reviewer_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS printscope_pilot_reviews_job_idx
 ON printscope_pilot_reviews(job_id,created_at DESC,id DESC);
COMMIT;