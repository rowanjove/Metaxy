CREATE TABLE IF NOT EXISTS drive_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_drive_devices_username
ON drive_devices(username, revoked_at);

CREATE TABLE IF NOT EXISTS dav_locks (
  token TEXT PRIMARY KEY,
  node_id TEXT,
  path_key TEXT NOT NULL,
  owner TEXT,
  depth TEXT NOT NULL CHECK (depth IN ('0', '1', 'infinity')),
  scope TEXT NOT NULL CHECK (scope IN ('exclusive', 'shared')),
  device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (node_id) REFERENCES drive_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES drive_devices(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dav_locks_path_expiry
ON dav_locks(path_key, expires_at);

CREATE INDEX IF NOT EXISTS idx_dav_locks_expiry
ON dav_locks(expires_at);
