CREATE TABLE IF NOT EXISTS drops (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'revoked', 'deleting')),
  draft_token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  committed_at INTEGER,
  delete_requested_at INTEGER,
  view_count INTEGER NOT NULL DEFAULT 0,
  last_viewed_at INTEGER,
  total_size INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  drop_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  expected_size INTEGER NOT NULL,
  actual_size INTEGER,
  etag TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'uploaded')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (drop_id) REFERENCES drops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS drop_items (
  id TEXT PRIMARY KEY,
  drop_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'file')),
  sort_order INTEGER NOT NULL,
  text_storage TEXT CHECK (text_storage IN ('d1', 'r2')),
  text_content TEXT,
  text_object_key TEXT,
  file_id TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (drop_id) REFERENCES drops(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  UNIQUE (drop_id, sort_order),
  CHECK (
    (type = 'text' AND text_storage IS NOT NULL AND file_id IS NULL)
    OR
    (type = 'file' AND file_id IS NOT NULL AND text_storage IS NULL
      AND text_content IS NULL AND text_object_key IS NULL)
  ),
  CHECK (
    type != 'text'
    OR (text_storage = 'd1' AND text_content IS NOT NULL AND text_object_key IS NULL)
    OR (text_storage = 'r2' AND text_content IS NULL AND text_object_key IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS object_deletions (
  object_key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_drops_status_expires_at
ON drops(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_drops_created_at
ON drops(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_drop_items_drop_order
ON drop_items(drop_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_files_drop_id
ON files(drop_id);

CREATE INDEX IF NOT EXISTS idx_files_status_created_at
ON files(status, created_at);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
ON admin_sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_object_deletions_created_at
ON object_deletions(created_at);

-- Default system settings
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('site_name', '之间门', 1780000000000),
  ('default_expiry_seconds', '86400', 1780000000000),
  ('max_expiry_seconds', '604800', 1780000000000),
  ('max_file_bytes', '52428800', 1780000000000),
  ('max_drop_file_bytes', '524288000', 1780000000000),
  ('max_files_per_drop', '10', 1780000000000),
  ('max_text_bytes', '5242880', 1780000000000),
  ('code_length', '6', 1780000000000),
  ('allow_public_risky_files', 'false', 1780000000000);
