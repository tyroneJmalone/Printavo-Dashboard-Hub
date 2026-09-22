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
COMMIT;