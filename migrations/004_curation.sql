-- T08: retry/backoff for storage cleanup after risk deletion; review metadata.
ALTER TABLE cleanup_jobs ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0);
ALTER TABLE cleanup_jobs ADD COLUMN run_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE submissions ADD COLUMN reviewed_at timestamptz;
ALTER TABLE submissions ADD COLUMN reviewed_by uuid REFERENCES users(id);
ALTER TABLE submissions ADD CONSTRAINT submissions_reason_length CHECK (rejection_reason IS NULL OR char_length(rejection_reason) <= 500);
ALTER TABLE candidates ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX candidates_created_idx ON candidates(created_at DESC, id);
