-- PostgreSQL 18. The migration runner owns BEGIN/COMMIT and the migration lock.
-- Cross-table cycles are created below, then linked using deferred foreign keys.
-- No generated tasks, user assets, administrator account, or sample content is seeded.

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username_key text NOT NULL UNIQUE CHECK (username_key ~ '^[a-z0-9_]{3,32}$'),
    username_display text NOT NULL,
    nickname text NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND 40),
    password_hash text NOT NULL,
    role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    credential_version bigint NOT NULL DEFAULT 1 CHECK (credential_version > 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    credential_version bigint NOT NULL CHECK (credential_version > 0),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id),
    purpose text NOT NULL CHECK (purpose IN ('input_image', 'model', 'original', 'derived')),
    object_key text NOT NULL UNIQUE CHECK (char_length(object_key) > 0),
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    byte_size bigint NOT NULL CHECK (byte_size >= 0),
    mime text NOT NULL,
    state text NOT NULL DEFAULT 'staged' CHECK (state IN ('staged', 'committed', 'deleted')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_owner_idx ON files(owner_id);
CREATE INDEX files_state_created_idx ON files(state, created_at);

CREATE TABLE quota_days (
    user_id uuid NOT NULL REFERENCES users(id),
    quota_day date NOT NULL,
    override_total integer CHECK (override_total >= 0),
    used_net integer NOT NULL DEFAULT 0 CHECK (used_net >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, quota_day)
);

CREATE TABLE generation_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id),
    input_file_id uuid NOT NULL REFERENCES files(id),
    status text NOT NULL DEFAULT 'accepted' CHECK (status IN (
        'accepted', 'dispatching', 'submission_unknown', 'provider_running',
        'ingesting', 'validating', 'succeeded', 'failed'
    )),
    submitted_day date NOT NULL,
    attempt_id uuid UNIQUE,
    policy_version text NOT NULL,
    result_asset_id uuid UNIQUE,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id, submitted_day),
    CHECK (status <> 'succeeded' OR result_asset_id IS NOT NULL)
);
-- The local in-flight limit includes cross-day and unknown provider submissions.
CREATE UNIQUE INDEX generation_tasks_one_active_per_user ON generation_tasks(user_id)
    WHERE status NOT IN ('succeeded', 'failed');
CREATE INDEX generation_tasks_user_created_idx ON generation_tasks(user_id, created_at DESC, id);
CREATE INDEX generation_tasks_input_idx ON generation_tasks(input_file_id);

CREATE TABLE quota_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('reserve', 'refund')),
    quota_day date NOT NULL,
    delta smallint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (task_id, kind),
    FOREIGN KEY (task_id, user_id, quota_day)
        REFERENCES generation_tasks(id, user_id, submitted_day),
    FOREIGN KEY (user_id, quota_day) REFERENCES quota_days(user_id, quota_day),
    CHECK ((kind = 'reserve' AND delta = 1) OR (kind = 'refund' AND delta = -1))
);
CREATE INDEX quota_events_user_day_idx ON quota_events(user_id, quota_day);

CREATE TABLE provider_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL UNIQUE REFERENCES generation_tasks(id),
    dispatch_nonce uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    region text NOT NULL DEFAULT 'cn' CHECK (region IN ('cn', 'international')),
    request_hash text NOT NULL,
    dispatch_state text NOT NULL DEFAULT 'prepared' CHECK (dispatch_state IN (
        'prepared', 'dispatch_started', 'submission_unknown', 'acknowledged', 'rejected', 'settled'
    )),
    provider_task_id text CHECK (provider_task_id ~ '^[0-9]+$'),
    provider_state text,
    started_at timestamptz,
    settled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, task_id),
    UNIQUE (id, dispatch_nonce),
    UNIQUE (region, provider_task_id)
);
ALTER TABLE generation_tasks ADD CONSTRAINT generation_tasks_attempt_fk
    FOREIGN KEY (attempt_id, id) REFERENCES provider_attempts(id, task_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE provider_evidence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id uuid NOT NULL,
    dispatch_nonce uuid NOT NULL,
    provider_task_id text NOT NULL CHECK (provider_task_id ~ '^[0-9]+$'),
    observed_at timestamptz NOT NULL DEFAULT now(),
    evidence_hash text NOT NULL,
    UNIQUE (attempt_id, evidence_hash),
    FOREIGN KEY (attempt_id, dispatch_nonce) REFERENCES provider_attempts(id, dispatch_nonce)
);
CREATE INDEX provider_evidence_task_idx ON provider_evidence(provider_task_id);

CREATE TABLE jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL,
    ref_id uuid NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
    run_at timestamptz NOT NULL DEFAULT now(),
    lease_until timestamptz,
    fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, ref_id)
);
-- ref_id is polymorphic (task/import/cleanup); its kind-specific target is checked
-- by the domain service inside the same transaction that enqueues the job.
CREATE INDEX jobs_ready_idx ON jobs(run_at, id) WHERE state = 'queued';
CREATE INDEX jobs_lease_idx ON jobs(lease_until) WHERE state = 'running';

CREATE TABLE asset_imports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id uuid NOT NULL REFERENCES users(id),
    input_file_id uuid NOT NULL REFERENCES files(id),
    source_type text NOT NULL CHECK (source_type IN ('furniture', 'official_candidate')),
    metadata_snapshot jsonb NOT NULL CHECK (jsonb_typeof(metadata_snapshot) = 'object'),
    policy_version text NOT NULL,
    state text NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted', 'validating', 'succeeded', 'failed')),
    result_asset_id uuid UNIQUE,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (state <> 'succeeded' OR result_asset_id IS NOT NULL)
);
CREATE INDEX asset_imports_admin_idx ON asset_imports(admin_id, created_at DESC, id);
CREATE INDEX asset_imports_input_idx ON asset_imports(input_file_id);

CREATE TABLE assets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid REFERENCES users(id),
    source_type text NOT NULL CHECK (source_type IN ('personal', 'furniture', 'official_candidate')),
    generation_task_id uuid UNIQUE REFERENCES generation_tasks(id),
    import_id uuid UNIQUE REFERENCES asset_imports(id),
    model_file_id uuid REFERENCES files(id),
    original_image_id uuid REFERENCES files(id),
    name text,
    description text NOT NULL DEFAULT '',
    normalization jsonb CHECK (jsonb_typeof(normalization) = 'object'),
    bounds jsonb CHECK (jsonb_typeof(bounds) = 'object'),
    state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'deleted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE (id, generation_task_id),
    UNIQUE (id, import_id),
    CHECK (num_nonnulls(generation_task_id, import_id) = 1),
    CHECK ((source_type = 'personal' AND owner_id IS NOT NULL AND generation_task_id IS NOT NULL)
        OR (source_type IN ('furniture', 'official_candidate') AND import_id IS NOT NULL)),
    CHECK (state = 'deleted' OR (model_file_id IS NOT NULL AND name IS NOT NULL
        AND char_length(name) BETWEEN 1 AND 80 AND normalization IS NOT NULL AND bounds IS NOT NULL))
);
CREATE INDEX assets_owner_created_idx ON assets(owner_id, created_at DESC, id);
CREATE INDEX assets_model_file_idx ON assets(model_file_id);
CREATE INDEX assets_original_image_idx ON assets(original_image_id);
CREATE INDEX assets_source_ready_idx ON assets(source_type, created_at DESC) WHERE state = 'ready';
ALTER TABLE generation_tasks ADD CONSTRAINT generation_tasks_result_fk
    FOREIGN KEY (result_asset_id, id) REFERENCES assets(id, generation_task_id)
    DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE asset_imports ADD CONSTRAINT asset_imports_result_fk
    FOREIGN KEY (result_asset_id, id) REFERENCES assets(id, import_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE rooms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL UNIQUE REFERENCES users(id),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    scene_version text NOT NULL,
    layout_version bigint NOT NULL DEFAULT 0 CHECK (layout_version >= 0),
    share_token_hash text UNIQUE,
    share_token_ciphertext text,
    share_epoch bigint NOT NULL DEFAULT 0 CHECK (share_epoch >= 0),
    share_enabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((share_token_hash IS NULL) = (share_token_ciphertext IS NULL)),
    CHECK (NOT share_enabled OR share_token_hash IS NOT NULL)
);

CREATE TABLE room_versions (
    room_id uuid NOT NULL REFERENCES rooms(id),
    version bigint NOT NULL CHECK (version >= 0),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    scene_version text NOT NULL,
    placements_json jsonb NOT NULL CHECK (jsonb_typeof(placements_json) = 'array'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, version)
);
-- Registration inserts rooms + empty room_versions(0) in one transaction.
ALTER TABLE rooms ADD CONSTRAINT rooms_current_version_fk
    FOREIGN KEY (id, layout_version) REFERENCES room_versions(room_id, version)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id uuid NOT NULL REFERENCES assets(id),
    user_id uuid NOT NULL REFERENCES users(id),
    submitted_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'deleted')),
    public_snapshot jsonb NOT NULL CHECK (jsonb_typeof(public_snapshot) = 'object'),
    rejection_reason text,
    UNIQUE (id, asset_id),
    CHECK (status <> 'rejected' OR nullif(btrim(rejection_reason), '') IS NOT NULL)
);
CREATE UNIQUE INDEX submissions_one_pending_per_asset ON submissions(asset_id) WHERE status = 'pending';
CREATE INDEX submissions_user_idx ON submissions(user_id, submitted_at DESC, id);
CREATE INDEX submissions_review_idx ON submissions(submitted_at, id) WHERE status = 'pending';

CREATE TABLE candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id uuid NOT NULL UNIQUE REFERENCES assets(id),
    submission_id uuid UNIQUE,
    source text NOT NULL CHECK (source IN ('user', 'official')),
    public_snapshot jsonb NOT NULL CHECK (jsonb_typeof(public_snapshot) = 'object'),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, asset_id),
    FOREIGN KEY (submission_id, asset_id) REFERENCES submissions(id, asset_id),
    CHECK ((source = 'user' AND submission_id IS NOT NULL)
        OR (source = 'official' AND submission_id IS NULL))
);

CREATE TABLE active_publications (
    asset_id uuid PRIMARY KEY REFERENCES assets(id),
    submission_id uuid UNIQUE,
    candidate_id uuid UNIQUE,
    CHECK (num_nonnulls(submission_id, candidate_id) = 1),
    FOREIGN KEY (submission_id, asset_id) REFERENCES submissions(id, asset_id),
    FOREIGN KEY (candidate_id, asset_id) REFERENCES candidates(id, asset_id)
);
-- The shared asset lock + this single occupancy row implement cross-table
-- pending/candidate exclusion. Domain writes must maintain occupancy atomically.

CREATE TABLE gallery_versions (
    version bigint PRIMARY KEY CHECK (version >= 0),
    slots_json jsonb NOT NULL CHECK (jsonb_typeof(slots_json) = 'array'),
    details_json jsonb NOT NULL CHECK (jsonb_typeof(details_json) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gallery (
    singleton_id smallint PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
    version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    FOREIGN KEY (version) REFERENCES gallery_versions(version) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE exhibit_slots (
    slot_no smallint PRIMARY KEY CHECK (slot_no BETWEEN 1 AND 30),
    candidate_id uuid REFERENCES candidates(id),
    CONSTRAINT exhibit_slots_candidate_unique UNIQUE (candidate_id) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE TABLE snapshot_grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash text NOT NULL UNIQUE,
    kind text NOT NULL CHECK (kind IN ('room', 'gallery')),
    scope_id uuid,
    version bigint NOT NULL CHECK (version >= 0),
    gallery_version bigint,
    share_epoch bigint,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (scope_id, version) REFERENCES room_versions(room_id, version),
    FOREIGN KEY (gallery_version) REFERENCES gallery_versions(version),
    CHECK ((kind = 'room' AND scope_id IS NOT NULL AND share_epoch IS NOT NULL AND share_epoch >= 0
            AND gallery_version IS NULL)
        OR (kind = 'gallery' AND scope_id IS NULL AND share_epoch IS NULL
            AND gallery_version IS NOT NULL AND gallery_version = version))
);
CREATE INDEX snapshot_grants_expiry_idx ON snapshot_grants(expires_at);
CREATE INDEX snapshot_grants_room_idx ON snapshot_grants(scope_id, version);
CREATE INDEX snapshot_grants_gallery_idx ON snapshot_grants(gallery_version);

CREATE TABLE write_receipts (
    actor_id text NOT NULL,
    method text NOT NULL,
    path text NOT NULL,
    key text NOT NULL,
    body_hash text NOT NULL,
    status smallint NOT NULL CHECK (status BETWEEN 100 AND 599),
    response jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (actor_id, method, path, key)
);
-- actor_id is an opaque namespace: an authenticated UUID or a scoped anonymous
-- registration namespace. A users FK would make anonymous safe receipts impossible.

CREATE TABLE cleanup_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id uuid REFERENCES assets(id),
    file_id uuid REFERENCES files(id),
    object_key text NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (asset_id IS NOT NULL OR file_id IS NOT NULL),
    UNIQUE (object_key)
);
CREATE INDEX cleanup_jobs_asset_idx ON cleanup_jobs(asset_id);
CREATE INDEX cleanup_jobs_file_idx ON cleanup_jobs(file_id);
CREATE INDEX cleanup_jobs_pending_idx ON cleanup_jobs(created_at, id) WHERE state IN ('queued', 'failed');

CREATE TABLE worker_heartbeats (
    worker_id text PRIMARY KEY,
    last_seen timestamptz NOT NULL DEFAULT now()
);
