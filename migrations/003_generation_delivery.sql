-- Persistent inputs/validation bind each delivery to its source attempt and bytes.
ALTER TABLE provider_attempts ADD COLUMN request_params jsonb;
ALTER TABLE provider_attempts ADD COLUMN input_sha256 text;
ALTER TABLE provider_attempts ADD COLUMN delivery_receipt jsonb;
ALTER TABLE provider_attempts ADD COLUMN quote_id text;
ALTER TABLE provider_attempts ADD COLUMN committed_credits integer CHECK (committed_credits >= 0);
ALTER TABLE asset_imports ADD COLUMN validation_receipt jsonb;
ALTER TABLE worker_heartbeats ADD COLUMN generation_enabled boolean NOT NULL DEFAULT false;
CREATE TABLE auth_rate_limits (
  bucket text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0
);
