ALTER TABLE drops ADD COLUMN delete_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drops ADD COLUMN last_delete_attempt_at INTEGER;

ALTER TABLE files ADD COLUMN presign_expires_at INTEGER;
ALTER TABLE files ADD COLUMN upload_object_key TEXT;
ALTER TABLE files ADD COLUMN finalize_token TEXT;
ALTER TABLE files ADD COLUMN finalize_started_at INTEGER;

ALTER TABLE object_deletions ADD COLUMN not_before INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_drops_deletion_retry
ON drops(status, delete_requested_at, delete_attempts, last_delete_attempt_at);

CREATE INDEX IF NOT EXISTS idx_files_presign_expires_at
ON files(drop_id, presign_expires_at);

CREATE INDEX IF NOT EXISTS idx_object_deletions_due
ON object_deletions(not_before, attempts, last_attempt_at, created_at);
