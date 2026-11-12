-- 2026-11-12: the copy of each ready model that web pages load (meshopt geometry, WebP textures; built by the worker,
-- packages/domain/src/web-model.ts). The original file stays the source of truth: validation, downloads and receipts
-- use it. A copy is read only through its original's permission check (GET /api/v1/files/<original>/content?variant=web),
-- so revoking access to the original revokes the copy with it. The worker enqueues a 'web_copy' job per model file
-- (ref_id = original file id); a job that finished without a row here means the copy would not have been smaller.
CREATE TABLE model_web_copies (
    model_file_id uuid PRIMARY KEY REFERENCES files(id),
    file_id uuid NOT NULL UNIQUE REFERENCES files(id),
    policy text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
