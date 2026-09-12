-- Metaxy Drive core. Drive has its own object namespace and lifecycle, and the
-- existing Drop tables and FILES cleanup queue remain unchanged.
CREATE TABLE IF NOT EXISTS drive_nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  system_role TEXT CHECK (system_role IN ('root', 'inbox') OR system_role IS NULL),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'trashed', 'deleting')),
  object_key TEXT UNIQUE,
  content_type TEXT,
  size INTEGER,
  etag TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  trashed_at INTEGER,
  FOREIGN KEY (parent_id) REFERENCES drive_nodes(id) ON DELETE RESTRICT,
  CHECK ((kind = 'folder' AND object_key IS NULL AND content_type IS NULL
          AND size IS NULL AND etag IS NULL)
      OR (kind = 'file' AND object_key IS NOT NULL AND content_type IS NOT NULL
          AND size IS NOT NULL AND size >= 0)),
  CHECK (system_role IS NULL OR (kind = 'folder' AND status = 'active')),
  CHECK (kind = 'folder' OR system_role IS NULL)
);

-- NULL is deliberately not used for root parent_id. The stable root row is
-- self-parented, so sibling uniqueness works at every level.
CREATE UNIQUE INDEX IF NOT EXISTS idx_drive_nodes_active_sibling_name
ON drive_nodes(parent_id, name_key) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_drive_nodes_system_role
ON drive_nodes(system_role) WHERE system_role IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_drive_nodes_parent_status
ON drive_nodes(parent_id, status, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_drive_nodes_trash
ON drive_nodes(status, trashed_at, updated_at);

CREATE TABLE IF NOT EXISTS drive_uploads (
  id TEXT PRIMARY KEY,
  node_id TEXT,
  parent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  upload_object_key TEXT NOT NULL UNIQUE,
  final_object_key TEXT NOT NULL UNIQUE,
  expected_size INTEGER NOT NULL CHECK (expected_size >= 0),
  expected_content_type TEXT NOT NULL,
  presign_expires_at INTEGER NOT NULL,
  finalize_token TEXT,
  finalize_started_at INTEGER,
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'completing', 'completed', 'failed', 'aborted')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  failure_reason TEXT,
  FOREIGN KEY (node_id) REFERENCES drive_nodes(id) ON DELETE SET NULL,
  FOREIGN KEY (parent_id) REFERENCES drive_nodes(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_drive_uploads_due
ON drive_uploads(status, presign_expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_drive_uploads_parent_name
ON drive_uploads(parent_id, name_key, status);

CREATE TABLE IF NOT EXISTS drive_object_deletions (
  object_key TEXT PRIMARY KEY,
  node_id TEXT,
  bucket TEXT NOT NULL DEFAULT 'DRIVE' CHECK (bucket = 'DRIVE'),
  created_at INTEGER NOT NULL,
  not_before INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  FOREIGN KEY (node_id) REFERENCES drive_nodes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_drive_object_deletions_due
ON drive_object_deletions(not_before, attempts, last_attempt_at, created_at);

INSERT OR IGNORE INTO drive_nodes (
  id, parent_id, kind, name, name_key, system_role, status,
  object_key, content_type, size, etag, version, created_at, updated_at, trashed_at
)
VALUES (
  'drive-root', 'drive-root', 'folder', 'Drive', 'drive', 'root', 'active',
  NULL, NULL, NULL, NULL, 1,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  NULL
);

INSERT OR IGNORE INTO drive_nodes (
  id, parent_id, kind, name, name_key, system_role, status,
  object_key, content_type, size, etag, version, created_at, updated_at, trashed_at
)
SELECT
  'drive-inbox', 'drive-root', 'folder', '中转箱', '中转箱', 'inbox', 'active',
  NULL, NULL, NULL, NULL, 1,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  NULL
WHERE EXISTS (SELECT 1 FROM drive_nodes WHERE id = 'drive-root');
